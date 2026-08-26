const assert = require('node:assert/strict')
const { mkdtemp, readdir, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

const {
    SERVER_IMAGE_FAILURE_RETRY_MS,
    SERVER_IMAGE_REVALIDATE_MS,
    ServerImageCache
} = require('../app/assets/js/serverimagecache')

const PNG_A = Buffer.from('89504e470d0a1a0a01020304', 'hex')
const PNG_B = Buffer.from('89504e470d0a1a0a05060708', 'hex')

async function temporaryCacheDirectory(){
    return mkdtemp(join(tmpdir(), 'maplecraft-image-cache-test-'))
}

function descriptor(overrides = {}){
    return {
        serverId: 'main-server',
        serverVersion: '1.0.0',
        type: 'icon',
        source: 'https://assets.example.test/icon.png',
        ...overrides
    }
}

function imageResponse(body = PNG_A, headers = {}){
    return {
        statusCode: 200,
        headers: {
            'content-type': 'image/png',
            etag: '"icon-a"',
            'last-modified': 'Mon, 24 Aug 2026 00:00:00 GMT',
            ...headers
        },
        body
    }
}

test('downloads an image once and reuses it across cache instances', async t => {
    const cacheRoot = await temporaryCacheDirectory()
    t.after(() => rm(cacheRoot, { recursive: true, force: true }))
    let requests = 0
    const requestImage = async () => {
        requests++
        return imageResponse()
    }

    const firstCache = new ServerImageCache(cacheRoot, { requestImage })
    const first = await firstCache.resolve(descriptor())
    assert.equal(first.currentUrl, null)
    const cachedUrl = await first.refresh

    const secondCache = new ServerImageCache(cacheRoot, { requestImage })
    const second = await secondCache.resolve(descriptor())
    assert.equal(second.currentUrl, cachedUrl)
    assert.equal(second.refresh, null)
    assert.equal(requests, 1)
})

test('revalidates an expired image with conditional headers and accepts 304', async t => {
    const cacheRoot = await temporaryCacheDirectory()
    t.after(() => rm(cacheRoot, { recursive: true, force: true }))
    let now = 1000
    const requests = []
    const cache = new ServerImageCache(cacheRoot, {
        now: () => now,
        requestImage: async (_url, options) => {
            requests.push(options)
            return requests.length === 1
                ? imageResponse()
                : { statusCode: 304, headers: {}, body: Buffer.alloc(0) }
        }
    })

    const initialUrl = await (await cache.resolve(descriptor())).refresh
    now += SERVER_IMAGE_REVALIDATE_MS
    const expired = await cache.resolve(descriptor())

    assert.equal(expired.currentUrl, initialUrl)
    assert.equal(await expired.refresh, initialUrl)
    assert.equal(requests[1].headers['If-None-Match'], '"icon-a"')
    assert.equal(requests[1].headers['If-Modified-Since'], 'Mon, 24 Aug 2026 00:00:00 GMT')
    assert.equal((await cache.resolve(descriptor())).refresh, null)
})

test('atomically replaces changed content and removes the previous asset', async t => {
    const cacheRoot = await temporaryCacheDirectory()
    t.after(() => rm(cacheRoot, { recursive: true, force: true }))
    let now = 0
    let requests = 0
    const cache = new ServerImageCache(cacheRoot, {
        now: () => now,
        requestImage: async () => imageResponse(++requests === 1 ? PNG_A : PNG_B, { etag: `"icon-${requests}"` })
    })

    const firstUrl = await (await cache.resolve(descriptor())).refresh
    now += SERVER_IMAGE_REVALIDATE_MS
    const secondUrl = await (await cache.resolve(descriptor())).refresh

    assert.notEqual(secondUrl, firstUrl)
    const serverDirectory = (await readdir(cacheRoot))[0]
    const files = await readdir(join(cacheRoot, serverDirectory, 'icon'))
    assert.equal(files.filter(file => file.startsWith('asset-')).length, 1)
    assert.equal(files.some(file => file.endsWith('.part')), false)
})

test('keeps stale data and cools down after a failed refresh', async t => {
    const cacheRoot = await temporaryCacheDirectory()
    t.after(() => rm(cacheRoot, { recursive: true, force: true }))
    let now = 0
    let requests = 0
    const cache = new ServerImageCache(cacheRoot, {
        now: () => now,
        requestImage: async () => {
            requests++
            if(requests > 1){
                throw new Error('offline')
            }
            return imageResponse()
        }
    })

    const cachedUrl = await (await cache.resolve(descriptor())).refresh
    now += SERVER_IMAGE_REVALIDATE_MS
    const expired = await cache.resolve(descriptor())
    await assert.rejects(expired.refresh, /offline/)

    const coolingDown = await cache.resolve(descriptor())
    assert.equal(coolingDown.currentUrl, cachedUrl)
    assert.equal(coolingDown.refresh, null)
    now += SERVER_IMAGE_FAILURE_RETRY_MS
    const retry = (await cache.resolve(descriptor())).refresh
    assert.notEqual(retry, null)
    await assert.rejects(retry, /offline/)
})

test('deduplicates matching requests and refreshes immediately for a new URL or version', async t => {
    const cacheRoot = await temporaryCacheDirectory()
    t.after(() => rm(cacheRoot, { recursive: true, force: true }))
    let resolveRequest
    let requests = 0
    const cache = new ServerImageCache(cacheRoot, {
        requestImage: () => {
            requests++
            if(requests > 1){
                return Promise.resolve(imageResponse())
            }
            return new Promise(resolve => {
                resolveRequest = resolve
            })
        }
    })

    const first = await cache.resolve(descriptor())
    const second = await cache.resolve(descriptor())
    assert.strictEqual(second.refresh, first.refresh)
    assert.equal(requests, 1)
    resolveRequest(imageResponse())
    await first.refresh

    const versionRefresh = (await cache.resolve(descriptor({ serverVersion: '1.0.1' }))).refresh
    assert.notEqual(versionRefresh, null)
    await versionRefresh
    const sourceRefresh = (await cache.resolve(descriptor({ source: 'https://assets.example.test/new.png' }))).refresh
    assert.notEqual(sourceRefresh, null)
    await sourceRefresh
})

test('rejects invalid content without leaving partial image files', async t => {
    const cacheRoot = await temporaryCacheDirectory()
    t.after(() => rm(cacheRoot, { recursive: true, force: true }))
    const cache = new ServerImageCache(cacheRoot, {
        requestImage: async () => imageResponse(PNG_A, { 'content-type': 'text/html' })
    })

    const resolved = await cache.resolve(descriptor())
    await assert.rejects(resolved.refresh, /Unsupported server image content type/)

    const serverDirectory = (await readdir(cacheRoot))[0]
    const files = await readdir(join(cacheRoot, serverDirectory, 'icon'))
    assert.equal(files.some(file => file.startsWith('asset-')), false)
    const metadata = JSON.parse(await readFile(join(cacheRoot, serverDirectory, 'icon', 'metadata.json'), 'utf8'))
    assert.equal(metadata.lastFailureSource, descriptor().source)
})

test('rejects oversized images and credentialed remote URLs', async t => {
    const cacheRoot = await temporaryCacheDirectory()
    t.after(() => rm(cacheRoot, { recursive: true, force: true }))
    const cache = new ServerImageCache(cacheRoot, {
        requestImage: async () => imageResponse(Buffer.alloc(5*1024*1024 + 1))
    })

    const oversized = await cache.resolve(descriptor())
    await assert.rejects(oversized.refresh, /invalid size/)

    const credentialed = await cache.resolve(descriptor({
        source: 'https://user:password@assets.example.test/icon.png'
    }))
    assert.equal(credentialed.currentUrl, null)
    assert.equal(credentialed.refresh, null)
})
