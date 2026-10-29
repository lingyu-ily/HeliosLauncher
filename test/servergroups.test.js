const assert = require('node:assert/strict')
const { test } = require('node:test')
const { getGroupIcon, getServerGroups, selectGroupVersion, resolveSelectedVersion, validateServerGroups, getLoaderLabel } = require('../app/assets/js/servergroups')

function fixture() {
    const raw = [{ id: 'legacy-1.20.1', name: 'Survival' }, { id: 'version-beta', name: 'Survival' }, { id: 'creative', name: 'Creative' }]
    const groups = [
        { id: 'survival', name: 'Survival', defaultVersionId: raw[0].id, versionIds: [raw[0].id, raw[1].id] },
        { id: 'creative-group', name: 'Creative', defaultVersionId: raw[2].id, versionIds: [raw[2].id] }
    ]
    return {
        rawDistribution: { servers: raw, serverGroups: groups },
        servers: raw.map(rawServer => ({ rawServer })),
        getMainServer() { return this.servers[0] }
    }
}

test('groups versions once without replacing legacy instance IDs', () => {
    const distro = fixture()
    validateServerGroups(distro.rawDistribution)
    const groups = getServerGroups(distro)
    assert.equal(groups.length, 2)
    assert.deepEqual(groups[0].versions.map(server => server.rawServer.id), ['legacy-1.20.1', 'version-beta'])
    assert.equal(selectGroupVersion(groups[0], 'version-beta').rawServer.id, 'version-beta')
    assert.equal(selectGroupVersion(groups[0], 'deleted').rawServer.id, 'legacy-1.20.1')
})

test('retains a current version, falls back within its group, then to the main group', () => {
    const distro = fixture()
    assert.equal(resolveSelectedVersion(distro, 'version-beta').rawServer.id, 'version-beta')
    assert.equal(resolveSelectedVersion(distro, 'removed', { 'creative-group': 'removed' }).rawServer.id, 'creative')
    assert.equal(resolveSelectedVersion(distro, 'removed', { 'deleted-group': 'removed' }).rawServer.id, 'legacy-1.20.1')
})

test('legacy manifests create a single-version group per server', () => {
    const distro = fixture()
    delete distro.rawDistribution.serverGroups
    assert.deepEqual(getServerGroups(distro).map(group => group.versions.length), [1, 1, 1])
})

test('group icons prefer the shared icon, then the default version rather than the selected version', () => {
    const distro = fixture()
    distro.servers[0].rawServer.icon = 'https://cdn.example.test/default.png'
    distro.servers[1].rawServer.icon = 'https://cdn.example.test/beta.png'
    const group = getServerGroups(distro)[0]
    assert.equal(getGroupIcon(group), distro.servers[0].rawServer.icon)
    group.icon = ' https://cdn.example.test/group.png '
    assert.equal(getGroupIcon(group), 'https://cdn.example.test/group.png')
    group.icon = ' '
    assert.equal(getGroupIcon(group), distro.servers[0].rawServer.icon)
})

test('rejects missing defaults, duplicate membership, unknown references and ungrouped versions', () => {
    for(const mutate of [
        groups => { groups[0].defaultVersionId = 'missing' },
        groups => { groups[0].versionIds.push('creative') },
        groups => { groups[0].versionIds.push('missing') },
        groups => { groups[0].versionIds.pop() }
    ]) {
        const distro = fixture()
        mutate(distro.rawDistribution.serverGroups)
        assert.throws(() => validateServerGroups(distro.rawDistribution))
    }
})

test('formats current and legacy loader versions without substituting the custom pack version', () => {
    const cases = [
        [{ minecraftVersion: '1.20.1', version: '2.3.0', loaderLabel: 'Forge 47.4.0' }, 'Forge 47.4.0'],
        [{ minecraftVersion: '1.21.1', loaderLabel: 'Fabric 0.16.0' }, 'Fabric 0.16.0'],
        [{ loaderLabel: 'Vanilla' }, '原版'],
        [{ minecraftVersion: '1.20.1', modules: [{ type: 'ForgeHosted', id: 'net.minecraftforge:forge:1.20.1-47.4.0:universal' }] }, 'Forge 47.4.0'],
        [{ minecraftVersion: '1.20.1', modules: [{ type: 'Forge', id: 'net.minecraftforge:forge:47.4.0' }] }, 'Forge 47.4.0'],
        [{ modules: [{ type: 'Fabric', id: 'net.fabricmc:fabric-loader:0.16.0' }] }, 'Fabric 0.16.0'],
        [{ modules: [{ type: 'ForgeHosted', id: 'unknown' }] }, 'Forge'],
        [{ modules: [{ type: 'Fabric', id: 'unknown' }] }, 'Fabric'],
        [{ modules: [{ type: 'ForgeMod', id: 'example:mod:3.0.0' }] }, '原版']
    ]
    for(const [server, expected] of cases) assert.equal(getLoaderLabel(server, '原版'), expected)
})
