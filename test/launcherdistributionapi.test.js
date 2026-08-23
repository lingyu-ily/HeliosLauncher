const assert = require('node:assert/strict')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

const {
    LauncherDistributionAPI,
    REMOTE_DISTRO_TIMEOUT_MS
} = require('../app/assets/js/launcherdistributionapi')

function distributionFixture() {
    return {
        version: '1.0.0',
        rss: '',
        servers: [{
            id: 'main-1.20.1',
            name: 'Main',
            description: '',
            icon: '',
            version: '1.0.0',
            address: 'localhost:25565',
            minecraftVersion: '1.20.1',
            mainServer: true,
            autoconnect: false,
            modules: []
        }]
    }
}

async function temporaryLauncherDirectory() {
    return mkdtemp(join(tmpdir(), 'maplecraft-launcher-test-'))
}

test('loads and caches a remote distribution with the startup timeout', async t => {
    const launcherDirectory = await temporaryLauncherDirectory()
    t.after(() => rm(launcherDirectory, { recursive: true, force: true }))
    let requestOptions
    const requestClient = {
        get: async (_url, options) => {
            requestOptions = options
            return { body: distributionFixture() }
        }
    }
    const api = new LauncherDistributionAPI(
        launcherDirectory,
        join(launcherDirectory, 'common'),
        join(launcherDirectory, 'instances'),
        'https://distribution.example.test/distribution.json',
        false,
        { requestClient }
    )

    const distribution = await api.getDistribution()

    assert.equal(distribution.getMainServer().rawServer.id, 'main-1.20.1')
    assert.equal(api.getLastLoadSource(), 'remote')
    assert.equal(requestOptions.timeout.request, REMOTE_DISTRO_TIMEOUT_MS)
    assert.equal(requestOptions.retry.limit, 0)
})

test('cancels a hung remote request and loads the local cache', async t => {
    const launcherDirectory = await temporaryLauncherDirectory()
    t.after(() => rm(launcherDirectory, { recursive: true, force: true }))
    await writeFile(
        join(launcherDirectory, 'distribution.json'),
        JSON.stringify(distributionFixture())
    )
    const server = createServer(() => undefined)
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    t.after(() => {
        server.closeAllConnections()
        server.close()
    })
    const address = server.address()
    const api = new LauncherDistributionAPI(
        launcherDirectory,
        join(launcherDirectory, 'common'),
        join(launcherDirectory, 'instances'),
        `http://127.0.0.1:${address.port}/distribution.json`,
        false,
        { requestTimeoutMs: 40 }
    )

    const startedAt = Date.now()
    const distribution = await api.getDistribution()

    assert.ok(Date.now() - startedAt < 1000)
    assert.equal(distribution.getMainServer().rawServer.id, 'main-1.20.1')
    assert.equal(api.getLastLoadSource(), 'cache')
})

test('fails cleanly when neither the remote nor cache is available', async t => {
    const launcherDirectory = await temporaryLauncherDirectory()
    t.after(() => rm(launcherDirectory, { recursive: true, force: true }))
    const requestClient = {
        get: async () => { throw new Error('offline') }
    }
    const api = new LauncherDistributionAPI(
        launcherDirectory,
        join(launcherDirectory, 'common'),
        join(launcherDirectory, 'instances'),
        'https://distribution.example.test/distribution.json',
        false,
        { requestClient }
    )

    await assert.rejects(
        api.getDistribution(),
        /Unable to load distribution from remote server or local disk/
    )
    assert.equal(api.getLastLoadSource(), null)
})
