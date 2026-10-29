const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { mkdtemp, mkdir, readFile, writeFile } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ServerGroups = require('../app/assets/js/servergroups')

const uiSource = readFileSync(resolve(__dirname, '..', 'app/assets/js/scripts/uibinder.js'), 'utf8')
const startupFunctions = ['loadStartupDistribution', 'onDistroRefresh'].map(name => {
    const match = uiSource.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))
    assert.ok(match, `Renderer function ${name} exists`)
    return match[0]
}).join('\n')

function distributionFixture() {
    const servers = ['main-default', 'main-beta', 'other-default', 'other-beta']
        .map(id => ({ rawServer: { id } }))
    return {
        servers,
        rawDistribution: { serverGroups: [
            { id: 'main', defaultVersionId: 'main-default', versionIds: ['main-default', 'main-beta'] },
            { id: 'other', defaultVersionId: 'other-default', versionIds: ['other-default', 'other-beta'] }
        ] },
        getMainServer() { return servers[1] },
        getServerById(id) { return servers.find(server => server.rawServer.id === id) }
    }
}

function startupHarness(config, distribution) {
    const context = vm.createContext({
        ServerGroups, ConfigManager: config,
        DistroAPI: { getDistribution: async () => distribution, getLastLoadSource: () => 'cache' },
        loggerUICore: { info() {} }, landingDistribution: null, launchInProgress: false,
        renderServerSidebar() {}, syncModConfigurations() {}, syncServerStatusView() {},
        ensureJavaSettings() {}, scheduleServerBackgroundPreload() {},
        updateSelectedServer(server) {
            config.setSelectedServer(server?.rawServer.id ?? null)
            const group = server && ServerGroups.getServerGroup(distribution, server.rawServer.id)
            if(group) config.setSelectedServerVersion(group.id, server.rawServer.id)
            config.save()
        }
    })
    vm.runInContext(startupFunctions, context)
    return context
}

function loadModule(file, directory, overrides = {}) {
    const filename = resolve(__dirname, '..', 'app', 'assets', 'js', file)
    const nativeRequire = createRequire(filename)
    const module = { exports: {} }
    vm.runInNewContext(readFileSync(filename, 'utf8'), {
        module, exports: module.exports, __dirname: dirname(filename),
        process: { platform: process.platform, env: { ...process.env, APPDATA: directory, HOME: directory } },
        require: id => {
            if(Object.hasOwn(overrides, id)) return overrides[id]
            if(id === '@electron/remote') return { app: { getPath: () => directory } }
            return nativeRequire(id)
        }
    }, { filename })
    return module.exports
}

test('persists per-group choices, Java and mod settings without mixing version instances or saves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maplecraft-version-instances-'))
    const config = loadModule('configmanager.js', directory)
    config.load()
    config.setDataDirectory(directory)
    const ids = ['legacy-1.20.1', 'version-beta']
    config.setSelectedServer(ids[1])
    config.setSelectedServerVersion('survival', ids[1])
    config.setSelectedServerVersion('creative', 'creative-version')
    for(const [index, id] of ids.entries()) {
        config.ensureJavaConfig(id, { suggestedMajor: 17 })
        config.setMinRAM(id, `${index + 2}G`)
        config.setJavaExecutable(id, `java-${index}`)
        config.setModConfiguration(id, { id, mods: { example: index === 0 } })
    }
    config.save()
    const reloaded = loadModule('configmanager.js', directory)
    reloaded.load()
    assert.equal(reloaded.getSelectedServer(), ids[1])
    assert.equal(reloaded.getSelectedServerVersions().survival, ids[1])
    assert.equal(reloaded.getSelectedServerVersions().creative, 'creative-version')
    assert.equal(reloaded.getMinRAM(ids[0]), '2G')
    assert.equal(reloaded.getMinRAM(ids[1]), '3G')
    assert.equal(reloaded.getModConfiguration(ids[0]).mods.example, true)
    assert.equal(reloaded.getModConfiguration(ids[1]).mods.example, false)
    const ProcessBuilder = loadModule('processbuilder.js', directory, { './configmanager': reloaded })
    const builders = ids.map(id => new ProcessBuilder({ rawServer: { id, minecraftVersion: '1.20.1' } }))
    assert.notEqual(builders[0].gameDir, builders[1].gameDir)
    assert.equal(builders[0].gameDir, join(directory, 'instances', ids[0]))
    for(const [index, builder] of builders.entries()) {
        await mkdir(join(builder.gameDir, 'saves'), { recursive: true })
        await writeFile(join(builder.gameDir, 'saves', 'level.dat'), `world-${index}`)
    }
    assert.equal(await readFile(join(builders[0].gameDir, 'saves', 'level.dat'), 'utf8'), 'world-0')
    assert.equal(await readFile(join(builders[1].gameDir, 'saves', 'level.dat'), 'utf8'), 'world-1')

    const distro = {
        servers: ids.map(id => ({ rawServer: { id } })),
        rawDistribution: { serverGroups: [
            { id: 'survival', defaultVersionId: ids[0], versionIds: ids }
        ] },
        getMainServer() { return this.servers[0] }
    }
    await startupHarness(reloaded, distro).loadStartupDistribution()
    const restarted = loadModule('configmanager.js', directory)
    restarted.load()
    assert.equal(restarted.getSelectedServer(), ids[0])
    assert.equal(Object.keys(restarted.getSelectedServerVersions()).length, 0)
    for(const [index, id] of ids.entries()) {
        assert.equal(restarted.getMinRAM(id), `${index + 2}G`)
        assert.equal(restarted.getJavaExecutable(id), `java-${index}`)
        assert.equal(restarted.getModConfiguration(id).mods.example, index === 0)
        assert.equal(await readFile(join(builders[index].gameDir, 'saves', 'level.dat'), 'utf8'), `world-${index}`)
    }
})

test('startup resets all group choices, retains the selected group and preserves session choices on refresh', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maplecraft-startup-versions-'))
    let config = loadModule('configmanager.js', directory)
    config.load()
    config.setSelectedServer('other-beta')
    config.setSelectedServerVersion('main', 'main-beta')
    config.setSelectedServerVersion('other', 'other-beta')
    config.save()
    config = loadModule('configmanager.js', directory)
    config.load()
    const distro = distributionFixture()
    const ui = startupHarness(config, distro)
    assert.equal(await ui.loadStartupDistribution(), distro)
    assert.equal(config.getSelectedServer(), 'other-default')
    assert.equal(Object.keys(config.getSelectedServerVersions()).length, 0)
    for(const group of ServerGroups.getServerGroups(distro)) {
        assert.equal(ServerGroups.selectGroupVersion(group, config.getSelectedServerVersions()[group.id]).rawServer.id, group.defaultVersionId)
    }

    config.setSelectedServer('other-beta')
    config.setSelectedServerVersion('other', 'other-beta')
    config.setSelectedServerVersion('main', 'main-beta')
    ui.onDistroRefresh(distro)
    assert.equal(config.getSelectedServer(), 'other-beta')
    assert.equal(config.getSelectedServerVersions().main, 'main-beta')
    assert.equal(config.getSelectedServerVersions().other, 'other-beta')

    config = loadModule('configmanager.js', directory)
    config.load()
    await startupHarness(config, distro).loadStartupDistribution()
    assert.equal(config.getSelectedServer(), 'other-default')
    assert.equal(Object.keys(config.getSelectedServerVersions()).length, 0)
})

test('startup resolves removed versions and groups before clearing their remembered choices', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maplecraft-startup-fallback-'))
    const config = loadModule('configmanager.js', directory)
    config.load()
    const distro = distributionFixture()
    for(const [selected, rememberedGroup, expected] of [
        ['removed-version', 'other', 'other-default'],
        ['removed-version', 'removed-group', 'main-default'],
        [null, 'other', 'main-default']
    ]) {
        config.setSelectedServer(selected)
        config.setSelectedServerVersion(rememberedGroup, selected ?? 'other-beta')
        config.setSelectedServerVersion('main', 'main-beta')
        await startupHarness(config, distro).loadStartupDistribution()
        assert.equal(config.getSelectedServer(), expected)
        assert.equal(Object.keys(config.getSelectedServerVersions()).length, 0)
    }
})

test('startup preserves single-version legacy servers and leaves choices intact when distribution loading fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maplecraft-startup-legacy-'))
    const config = loadModule('configmanager.js', directory)
    config.load()
    const distro = distributionFixture()
    delete distro.rawDistribution.serverGroups
    config.setSelectedServer('other-beta')
    config.setSelectedServerVersion('other', 'other-beta')
    const ui = startupHarness(config, distro)
    const getDistribution = ui.DistroAPI.getDistribution
    ui.DistroAPI.getDistribution = async () => { throw new Error('offline') }
    await assert.rejects(ui.loadStartupDistribution(), /offline/)
    assert.equal(config.getSelectedServer(), 'other-beta')
    assert.equal(config.getSelectedServerVersions().other, 'other-beta')
    ui.DistroAPI.getDistribution = getDistribution
    await ui.loadStartupDistribution()
    assert.equal(config.getSelectedServer(), 'other-beta')
    assert.equal(Object.keys(config.getSelectedServerVersions()).length, 0)
})
