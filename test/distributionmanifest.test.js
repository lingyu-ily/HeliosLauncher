const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtemp, mkdir, readFile, writeFile, readdir } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { LauncherDistributionAPI } = require('../app/assets/js/launcherdistributionapi')
const { atomicWrite, SERVER_DOWNLOAD_CONCURRENCY } = require('../app/assets/js/distributionmanifest')

const ROOT_URL = 'https://distribution.example.test/distribution.json'

function serverFixture(id, extra = {}) {
    return {
        id, name: id, description: '', icon: '', version: '1.0.0',
        address: 'localhost:25565', minecraftVersion: '1.20.1', mainServer: true, autoconnect: false,
        modules: [{
            id: 'test:mod:1.0', name: 'Optional mod', type: 'ForgeMod', required: { value: false, def: false },
            artifact: { url: 'https://files.example.test/mod.jar', size: 100, MD5: 'test-md5' },
            subModules: [{
                id: 'config', name: '設定', type: 'File',
                artifact: { path: 'config/test.json', url: 'https://files.example.test/config.json', size: 10 }
            }]
        }],
        ...extra
    }
}

function bundle(servers) {
    const bodies = new Map()
    const references = servers.map(server => {
        const body = Buffer.from(JSON.stringify(server))
        const sha256 = createHash('sha256').update(body).digest('hex')
        const url = `https://distribution.example.test/server-distributions/${sha256}.json`
        bodies.set(url, body)
        return { id: server.id, url, sha256, size: body.length }
    })
    return {
        index: { distributionFormat: 2, version: '1.0.0', rss: 'feed', telemetry: { custom: true }, servers: references },
        bodies
    }
}

async function fixture(servers = [serverFixture('main')]) {
    // Retain small scratch fixtures for failed-test diagnostics; no automatic deletion.
    const directory = await mkdtemp(join(tmpdir(), 'maplecraft-manifest-test-'))
    let current = bundle(servers)
    const requests = []
    const requestClient = {
        get: async (url, options) => {
            requests.push({ url, options })
            if(url === ROOT_URL) return { body: structuredClone(current.index) }
            if(!current.bodies.has(url)) throw new Error('HTTP 404')
            return { body: current.bodies.get(url) }
        }
    }
    function api() {
        return new LauncherDistributionAPI(directory, join(directory, 'common'), join(directory, 'instances'), ROOT_URL, false, { requestClient })
    }
    return {
        directory, requests, requestClient, api,
        get current() { return current },
        set current(value) { current = value }
    }
}

test('round trips globals, server order, nested modules and optional settings; reuses cache after restart', async () => {
    const servers = [serverFixture('beta'), serverFixture('alpha', { mainServer: false })]
    const f = await fixture(servers)
    const result = await f.api().getDistribution()
    assert.deepEqual(result.rawDistribution, { version: '1.0.0', rss: 'feed', telemetry: { custom: true }, servers })
    assert.equal(result.servers[0].modules[0].getRequired().def, false)
    assert.equal(f.requests.length, 3)
    for(const request of f.requests.slice(1)) {
        assert.equal(request.options.responseType, 'buffer')
        assert.equal(request.options.timeout.request, 12000)
        assert.equal(request.options.retry.limit, 0)
    }
    f.requests.length = 0
    assert.deepEqual((await f.api().getDistribution()).rawDistribution, result.rawDistribution)
    assert.deepEqual(f.requests.map(request => request.url), [ROOT_URL])
})

test('downloads only the changed server and handles addition, removal and reordering', async () => {
    const first = serverFixture('first')
    const second = serverFixture('second', { mainServer: false })
    const f = await fixture([first, second])
    const api = f.api()
    await api.getDistribution()
    const changed = { ...second, name: 'Updated' }
    f.current = bundle([first, changed])
    f.requests.length = 0
    await api.refreshDistributionOrFallback()
    assert.deepEqual(f.requests.map(request => request.url), [ROOT_URL, f.current.index.servers[1].url])

    f.current = bundle([changed, serverFixture('new', { mainServer: false }), first])
    f.requests.length = 0
    const added = await api.refreshDistributionOrFallback()
    assert.deepEqual(added.servers.map(server => server.rawServer.id), ['second', 'new', 'first'])
    assert.deepEqual(f.requests.map(request => request.url), [ROOT_URL, f.current.index.servers[1].url])

    f.current = bundle([first, changed])
    f.requests.length = 0
    assert.deepEqual((await api.refreshDistributionOrFallback()).servers.map(server => server.rawServer.id), ['first', 'second'])
    assert.deepEqual(f.requests.map(request => request.url), [ROOT_URL])
})

test('limits concurrent server requests to four while preserving index order', async () => {
    const f = await fixture(Array.from({ length: 9 }, (_, index) => serverFixture(`server-${index}`, { mainServer: index === 0 })))
    const get = f.requestClient.get
    let active = 0
    let peak = 0
    f.requestClient.get = async (url, options) => {
        if(url === ROOT_URL) return get(url, options)
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        try { return await get(url, options) } finally { active-- }
    }
    const result = await f.api().getDistribution()
    assert.equal(peak, SERVER_DOWNLOAD_CONCURRENCY)
    assert.deepEqual(result.servers.map(server => server.rawServer.id), f.current.index.servers.map(server => server.id))
})

test('repairs a corrupt server cache from verified remote bytes', async () => {
    const f = await fixture()
    await f.api().getDistribution()
    const reference = f.current.index.servers[0]
    const path = join(f.directory, 'distribution-servers', `${reference.sha256}.json`)
    await writeFile(path, 'corrupt')
    f.requests.length = 0
    await f.api().getDistribution()
    assert.deepEqual(f.requests.map(request => request.url), [ROOT_URL, reference.url])
    assert.deepEqual(await readFile(path), f.current.bodies.get(reference.url))
})

for(const failure of ['404', 'hash', 'size', 'json', 'server-id', 'modules', 'core-parser', 'index']) {
    test(`${failure} failure preserves the entire previous distribution on disk and in use`, async () => {
        const f = await fixture([serverFixture('first'), serverFixture('second', { mainServer: false })])
        const api = f.api()
        const previous = (await api.getDistribution()).rawDistribution
        const path = join(f.directory, 'distribution.json')
        const previousBytes = await readFile(path)
        const changed = serverFixture('second', { name: 'Changed', mainServer: false })
        if(failure === 'modules') changed.modules = null
        if(failure === 'core-parser') changed.modules[0].id = 'invalid-maven-id'
        f.current = bundle([serverFixture('first', { name: 'Changed first' }), changed])
        const reference = f.current.index.servers[1]
        if(failure === '404') f.current.bodies.delete(reference.url)
        if(failure === 'hash') f.current.bodies.set(reference.url, Buffer.alloc(reference.size, 32))
        if(failure === 'size') reference.size++
        if(failure === 'json') {
            const body = Buffer.from('{bad json')
            f.current.bodies.set(reference.url, body)
            reference.sha256 = createHash('sha256').update(body).digest('hex')
            reference.size = body.length
        }
        if(failure === 'server-id') reference.id = 'wrong-id'
        if(failure === 'index') f.current.index.servers[1].sha256 = '../invalid'
        const result = await api.refreshDistributionOrFallback()
        assert.deepEqual(result.rawDistribution, previous)
        assert.deepEqual(await readFile(path), previousBytes)
        assert.equal(api.getLastLoadSource(), 'cache')
    })
}

test('legacy input still works and unsupported format cannot overwrite its cache', async () => {
    const f = await fixture()
    f.current.index = { version: '1.0.0', rss: '', servers: [serverFixture('legacy')] }
    const api = f.api()
    const previous = (await api.getDistribution()).rawDistribution
    assert.equal(f.requests.length, 1)
    f.current.index = { ...f.current.index, distributionFormat: 3 }
    assert.deepEqual((await api.refreshDistributionOrFallback()).rawDistribution, previous)
})

test('missing remote server and absent complete cache fail cleanly', async () => {
    const f = await fixture()
    f.current.bodies.clear()
    await assert.rejects(f.api().getDistribution(), /Unable to load distribution/)
    await assert.rejects(readFile(join(f.directory, 'distribution.json')), { code: 'ENOENT' })
})

test('failed complete-cache commit keeps the prior cache', async () => {
    const f = await fixture()
    const api = f.api()
    const previous = (await api.getDistribution()).rawDistribution
    const path = join(f.directory, 'distribution.json')
    const previousBytes = await readFile(path)
    f.current = bundle([serverFixture('changed')])
    api.writeDistributionToDisk = async () => { throw new Error('Disk full') }
    assert.deepEqual((await api.refreshDistributionOrFallback()).rawDistribution, previous)
    assert.deepEqual(await readFile(path), previousBytes)
})

test('partial temporary files are ignored and failed atomic rename leaves the target intact', async () => {
    const f = await fixture()
    const api = f.api()
    const previous = (await api.getDistribution()).rawDistribution
    await writeFile(join(f.directory, 'distribution.json.interrupted.tmp'), '{partial')
    f.requestClient.get = async () => { throw new Error('offline') }
    assert.deepEqual((await f.api().getDistribution()).rawDistribution, previous)
    const target = join(f.directory, 'blocked')
    await mkdir(target)
    await writeFile(join(target, 'keep'), 'original')
    await assert.rejects(atomicWrite(target, 'new'))
    assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'original')
    assert.ok((await readdir(f.directory)).some(name => name.startsWith('blocked.') && name.endsWith('.tmp')))
})

test('a hung shard request times out and falls back to a complete cached distribution', async t => {
    const f = await fixture()
    const previous = (await f.api().getDistribution()).rawDistribution
    const candidate = bundle([serverFixture('changed')])
    const http = createServer((request, response) => {
        if(request.url === '/distribution.json') {
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(candidate.index))
        }
    })
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
    t.after(() => { http.closeAllConnections(); http.close() })
    const root = `http://127.0.0.1:${http.address().port}`
    candidate.index.servers[0].url = `${root}/hung.json`
    const api = new LauncherDistributionAPI(f.directory, join(f.directory, 'common'), join(f.directory, 'instances'), `${root}/distribution.json`, false, { requestTimeoutMs: 50 })
    const started = Date.now()
    assert.deepEqual((await api.getDistribution()).rawDistribution, previous)
    assert.ok(Date.now() - started < 2000)
    assert.equal(api.getLastLoadSource(), 'cache')
})
