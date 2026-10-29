const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ServerBackgroundPool, loadDecodedBackground } = require('../app/assets/js/serverbackgroundpool')

function deferred(){
    let resolve
    let reject
    const promise = new Promise((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

function resource(key){
    return { key, source: `https://cdn.example.test/${key}.png`,
        descriptor: { serverId: key, type: 'background', source: `https://cdn.example.test/${key}.png` } }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('loaded backgrounds stay alive and can be read synchronously while cache checks run', async () => {
    const checking = deferred()
    const image = {}
    let resolves = 0
    let loads = 0
    const pool = new ServerBackgroundPool({
        cache: { resolve: async () => ++resolves === 1 ? { currentUrl: 'cached.png', refresh: null } : checking.promise },
        loadImage: async () => { loads++; return image }
    })
    const entry = resource('a')
    const ready = await pool.prepare(entry)
    assert.strictEqual(pool.get('a'), ready)
    assert.strictEqual(ready.image, image)
    const revalidation = pool.prepare(entry, { priority: true })
    assert.strictEqual(pool.get('a'), ready)
    checking.resolve({ currentUrl: 'cached.png', refresh: Promise.resolve('cached.png') })
    assert.strictEqual(await revalidation, ready)
    assert.equal(loads, 1)
})

test('limits preparation to two jobs, shares pending work and prioritizes the selected background', async () => {
    const requests = new Map()
    const started = []
    let active = 0
    let peak = 0
    const pool = new ServerBackgroundPool({
        cache: { resolve: async descriptor => {
            active++
            peak = Math.max(peak, active)
            started.push(descriptor.serverId)
            const request = deferred()
            requests.set(descriptor.serverId, request)
            return { currentUrl: null, refresh: request.promise.finally(() => { active-- }) }
        } },
        loadImage: async url => ({ url })
    })
    const entries = ['a', 'b', 'c', 'd'].map(resource)
    const jobs = entries.map(entry => pool.prepare(entry))
    assert.deepEqual(started, ['a', 'b'])
    assert.strictEqual(pool.prepare(entries[3], { priority: true }), jobs[3])
    requests.get('a').resolve('a.png')
    await jobs[0]
    assert.deepEqual(started, ['a', 'b', 'd'])
    requests.get('b').resolve('b.png')
    await jobs[1]
    assert.deepEqual(started, ['a', 'b', 'd', 'c'])
    requests.get('d').resolve('d.png')
    requests.get('c').resolve('c.png')
    const ready = await Promise.all(jobs)
    assert.equal(peak, 2)
    assert.deepEqual(ready.map(asset => asset.url), ['a.png', 'b.png', 'c.png', 'd.png'])
})

test('a refreshed image only replaces its predecessor after decoding completes', async () => {
    const refresh = deferred()
    const decoding = deferred()
    const updates = []
    let checks = 0
    const oldImage = {}
    const newImage = {}
    const pool = new ServerBackgroundPool({
        cache: { resolve: async () => ({ currentUrl: 'old.png', refresh: ++checks === 1 ? null : refresh.promise }) },
        loadImage: async url => url === 'old.png' ? oldImage : decoding.promise,
        onUpdate: (_key, asset) => updates.push(asset.url)
    })
    const oldAsset = await pool.prepare(resource('a'))
    const revalidation = pool.prepare(resource('a'))
    refresh.resolve('new.png')
    await settle()
    assert.strictEqual(pool.get('a'), oldAsset)
    assert.deepEqual(updates, ['old.png'])
    decoding.resolve(newImage)
    assert.strictEqual((await revalidation).image, newImage)
    assert.deepEqual(updates, ['old.png', 'new.png'])
})

test('distribution replacement releases old resources and ignores their late completions', async () => {
    const oldDecode = deferred()
    const newDecode = deferred()
    const updates = []
    let checks = 0
    const pool = new ServerBackgroundPool({
        cache: { resolve: async () => ({ currentUrl: ++checks === 1 ? 'old.png' : 'new.png', refresh: null }) },
        loadImage: url => url === 'old.png' ? oldDecode.promise : newDecode.promise,
        onUpdate: (_key, asset) => updates.push(asset.url)
    })
    const oldJob = pool.prepare(resource('a'))
    await settle()
    pool.retain([])
    const newJob = pool.prepare(resource('a'))
    await settle()
    newDecode.resolve({ name: 'new' })
    const ready = await newJob
    oldDecode.resolve({ name: 'old' })
    assert.equal(await oldJob, null)
    assert.strictEqual(pool.get('a'), ready)
    assert.deepEqual(updates, ['new.png'])
    pool.retain([])
    assert.equal(pool.get('a'), null)
})

test('removed queued resources settle without starting downloads', async () => {
    const requests = []
    const pool = new ServerBackgroundPool({
        cache: { resolve: async () => {
            const request = deferred()
            requests.push(request)
            return request.promise
        } },
        loadImage: async () => ({})
    })
    const jobs = ['a', 'b', 'c'].map(key => pool.prepare(resource(key)))
    pool.retain([])
    assert.equal(await jobs[2], null)
    assert.equal(requests.length, 2)
    requests.forEach(request => request.resolve({ currentUrl: 'unused.png', refresh: null }))
    assert.deepEqual(await Promise.all(jobs), [null, null, null])
})

test('offline and decode failures preserve ready images and allow later retries', async () => {
    const failures = []
    let checks = 0
    const pool = new ServerBackgroundPool({
        cache: { resolve: async () => {
            checks++
            if(checks === 1) return { currentUrl: 'cached.png', refresh: null }
            return { currentUrl: 'cached.png', refresh: checks === 2
                ? Promise.reject(new Error('offline')) : Promise.resolve('broken.png') }
        } },
        loadImage: async url => {
            if(url === 'broken.png') throw new Error('decode failed')
            return { url }
        },
        onError: error => failures.push(error.message)
    })
    const ready = await pool.prepare(resource('a'))
    assert.strictEqual(await pool.prepare(resource('a')), ready)
    assert.strictEqual(await pool.prepare(resource('a')), ready)
    assert.deepEqual(failures, ['offline', 'decode failed'])

    pool.retain([])
    const fresh = await pool.prepare(resource('a'))
    assert.equal(fresh.url, 'cached.png')
})

test('a broken cached image does not prevent a usable refreshed image from being prepared', async () => {
    const pool = new ServerBackgroundPool({
        cache: { resolve: async () => ({ currentUrl: 'broken.png', refresh: Promise.resolve('new.png') }) },
        loadImage: async url => {
            if(url === 'broken.png') throw new Error('decode failed')
            return { url }
        }
    })
    assert.equal((await pool.prepare(resource('a'))).url, 'new.png')
})

test('local backgrounds are decoded once and never sent to the remote cache', async () => {
    let loads = 0
    const pool = new ServerBackgroundPool({
        cache: { resolve: () => assert.fail('local background used the remote cache') },
        loadImage: async () => { loads++; return {} }
    })
    const entry = { key: 'default.jpg', source: 'default.jpg', descriptor: null }
    const ready = await pool.prepare(entry)
    assert.strictEqual(await pool.prepare(entry), ready)
    assert.equal(loads, 1)
})

test('browser image loading waits for decode and retains the decoded Image instance', async () => {
    const decoded = deferred()
    const image = { decode: () => decoded.promise }
    let ready = false
    const loading = loadDecodedBackground('background.png', {
        createImage: () => image, schedule: () => 1, cancel() {}
    }).then(value => { ready = true; return value })
    assert.equal(image.src, 'background.png')
    const loadEvent = image.onload()
    await settle()
    assert.equal(ready, false)
    decoded.resolve()
    await loadEvent
    assert.strictEqual(await loading, image)
    assert.equal(image.onload, null)
    assert.equal(image.onerror, null)
})

test('browser image timeouts and decode errors reject without leaving event handlers', async () => {
    let timeout
    const image = {}
    const loading = loadDecodedBackground('background.png', {
        createImage: () => image, schedule: callback => { timeout = callback; return 1 }, cancel() {}
    })
    const timedOut = assert.rejects(loading, /timed out/)
    timeout()
    await timedOut
    assert.equal(image.onload, null)
    assert.equal(image.onerror, null)
    const broken = { decode: async () => { throw new Error('decode failed') } }
    const decode = loadDecodedBackground('broken.png', {
        createImage: () => broken, schedule: () => 1, cancel() {}
    })
    const rejected = assert.rejects(decode, /decode failed/)
    await broken.onload()
    await rejected
})
