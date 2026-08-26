const assert = require('node:assert/strict')
const { test } = require('node:test')

const { ServerStatusCache } = require('../app/assets/js/serverstatuscache')

test('queries once and returns a fresh cached server status', async () => {
    let now = 1000
    let queries = 0
    const cache = new ServerStatusCache(10000, () => now)
    const loader = async () => {
        queries++
        return { state: 'online', online: 4, max: 20 }
    }

    const first = await cache.refresh('server-a', loader)
    now += 9999
    const second = await cache.refresh('server-a', loader)

    assert.deepEqual(first, { state: 'online', online: 4, max: 20 })
    assert.strictEqual(second, first)
    assert.equal(cache.get('server-a').fresh, true)
    assert.equal(queries, 1)
})

test('queries again when the ten second cooldown expires', async () => {
    let now = 0
    let queries = 0
    const cache = new ServerStatusCache(10000, () => now)
    const loader = async () => ({ state: 'online', online: ++queries, max: 20 })

    await cache.refresh('server-a', loader)
    now = 10000
    const refreshed = await cache.refresh('server-a', loader)

    assert.equal(refreshed.online, 2)
    assert.equal(cache.get('server-a').updatedAt, 10000)
})

test('caches normalized offline results during the cooldown', async () => {
    let now = 0
    let queries = 0
    const cache = new ServerStatusCache(10000, () => now)
    const loader = async () => {
        queries++
        return { state: 'offline' }
    }

    await cache.refresh('server-a', loader)
    now = 5000
    const cached = await cache.refresh('server-a', loader)

    assert.deepEqual(cached, { state: 'offline' })
    assert.equal(queries, 1)
})

test('deduplicates concurrent requests for the same server', async () => {
    let resolveStatus
    let queries = 0
    const cache = new ServerStatusCache()
    const loader = () => {
        queries++
        return new Promise(resolve => {
            resolveStatus = resolve
        })
    }

    const first = cache.refresh('server-a', loader)
    const second = cache.refresh('server-a', loader)
    await Promise.resolve()

    assert.strictEqual(second, first)
    assert.equal(queries, 1)

    resolveStatus({ state: 'online', online: 8, max: 20 })
    await first
})

test('keeps A to B to A requests isolated when responses finish out of order', async () => {
    const cache = new ServerStatusCache()
    let resolveA
    let resolveB
    let queriesA = 0
    let queriesB = 0

    const firstA = cache.refresh('server-a\u0000host-a\u000025565', () => {
        queriesA++
        return new Promise(resolve => {
            resolveA = resolve
        })
    })
    const requestB = cache.refresh('server-b\u0000host-b\u000025565', () => {
        queriesB++
        return new Promise(resolve => {
            resolveB = resolve
        })
    })
    const secondA = cache.refresh('server-a\u0000host-a\u000025565', () => {
        queriesA++
        return Promise.resolve({ state: 'offline' })
    })
    await Promise.resolve()

    assert.strictEqual(secondA, firstA)
    assert.equal(queriesA, 1)
    assert.equal(queriesB, 1)

    resolveB({ state: 'online', online: 12, max: 20 })
    await requestB
    resolveA({ state: 'online', online: 3, max: 20 })
    await firstA

    assert.equal(cache.get('server-a\u0000host-a\u000025565').value.online, 3)
    assert.equal(cache.get('server-b\u0000host-b\u000025565').value.online, 12)
})
