const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
    ANONYMOUS_USAGE_TIMEOUT_MS,
    getAnonymousUsageDate,
    getOrCreateDailyToken,
    parseAnonymousUsageDescriptor,
    reportAnonymousUsage
} = require('../app/assets/js/anonymoususage')

function distribution(endpoint = 'https://nebula.example.com/api/v1/public/launcher-presence/maplecraft') {
    return {
        rawDistribution: {
            telemetry: {
                anonymousDailyActive: { endpoint, timeZone: 'Asia/Taipei' }
            }
        }
    }
}

function createConfigManager(enabled = true) {
    let state = { date: null, scope: null, dailyToken: null }
    let saves = 0
    return {
        getAnonymousUsage: () => enabled,
        getAnonymousUsageState: () => ({ ...state }),
        setAnonymousUsageState: next => { state = { ...next } },
        clearAnonymousUsageState: () => { state = { date: null, scope: null, dailyToken: null } },
        save: () => { saves += 1 },
        inspect: () => ({ state, saves })
    }
}

test('uses the Asia/Taipei calendar date at midnight', () => {
    assert.equal(getAnonymousUsageDate(new Date('2026-08-24T15:59:59.999Z')), '2026-08-24')
    assert.equal(getAnonymousUsageDate(new Date('2026-08-24T16:00:00.000Z')), '2026-08-25')
})

test('accepts only credential-free HTTPS descriptors for the supported time zone', () => {
    assert.deepEqual(parseAnonymousUsageDescriptor(distribution()), {
        endpoint: 'https://nebula.example.com/api/v1/public/launcher-presence/maplecraft',
        timeZone: 'Asia/Taipei'
    })
    assert.equal(parseAnonymousUsageDescriptor(distribution('http://nebula.example.com/presence')), null)
    assert.equal(parseAnonymousUsageDescriptor(distribution('https://user:secret@nebula.example.com/presence')), null)
    assert.equal(parseAnonymousUsageDescriptor({ rawDistribution: {} }), null)
    assert.equal(parseAnonymousUsageDescriptor({
        rawDistribution: { telemetry: { anonymousDailyActive: { endpoint: 'https://nebula.example.com', timeZone: 'UTC' } } }
    }), null)
})

test('reuses a token for the same day and scope, then rotates it', () => {
    const configManager = createConfigManager()
    let randomValue = 0
    const randomBytes = size => Buffer.alloc(size, ++randomValue)
    const beforeMidnight = new Date('2026-08-24T15:59:59.000Z')
    const first = getOrCreateDailyToken(configManager, 'https://nebula.example.com/one', beforeMidnight, randomBytes)
    const same = getOrCreateDailyToken(configManager, 'https://nebula.example.com/one', beforeMidnight, randomBytes)
    const nextDay = getOrCreateDailyToken(configManager, 'https://nebula.example.com/one', new Date('2026-08-24T16:00:00.000Z'), randomBytes)
    const nextScope = getOrCreateDailyToken(configManager, 'https://nebula.example.com/two', new Date('2026-08-24T16:00:00.000Z'), randomBytes)

    assert.equal(first, same)
    assert.notEqual(first, nextDay)
    assert.notEqual(nextDay, nextScope)
    assert.match(first, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(configManager.inspect().saves, 3)
})

test('sends only the daily token without retries, redirects, or startup coupling', async () => {
    const configManager = createConfigManager()
    let request
    const delivered = await reportAnonymousUsage(distribution(), {
        configManager,
        now: new Date('2026-08-25T00:00:00.000Z'),
        randomBytes: size => Buffer.alloc(size, 7),
        requestClient: {
            post: async (endpoint, options) => {
                request = { endpoint, options }
                return { statusCode: 204 }
            }
        }
    })

    assert.equal(delivered, true)
    assert.equal(request.endpoint, 'https://nebula.example.com/api/v1/public/launcher-presence/maplecraft')
    assert.deepEqual(Object.keys(request.options.json), ['dailyToken'])
    assert.equal(request.options.retry.limit, 0)
    assert.equal(request.options.followRedirect, false)
    assert.equal(request.options.timeout.request, ANONYMOUS_USAGE_TIMEOUT_MS)
    assert.equal(request.options.headers['user-agent'], 'MapleCraftLauncher-Anonymous-Usage')
})

test('opt-out clears local state and network failure remains non-fatal', async () => {
    const disabled = createConfigManager(false)
    disabled.setAnonymousUsageState({ date: '2026-08-25', scope: 'scope', dailyToken: 'x'.repeat(43) })
    let disabledRequests = 0
    assert.equal(await reportAnonymousUsage(distribution(), {
        configManager: disabled,
        requestClient: { post: async () => { disabledRequests += 1 } }
    }), false)
    assert.equal(disabledRequests, 0)
    assert.equal(disabled.inspect().state.dailyToken, null)

    const enabled = createConfigManager(true)
    assert.equal(await reportAnonymousUsage(distribution(), {
        configManager: enabled,
        randomBytes: size => Buffer.alloc(size, 9),
        requestClient: { post: async () => { throw new Error('offline') } }
    }), false)
})
