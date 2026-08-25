const crypto = require('crypto')
const got = require('got')
const { LoggerUtil } = require('helios-core')

const logger = LoggerUtil.getLogger('AnonymousUsage')
const ANONYMOUS_USAGE_TIME_ZONE = 'Asia/Taipei'
const ANONYMOUS_USAGE_TIMEOUT_MS = 2500
const DAILY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

function getAnonymousUsageDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: ANONYMOUS_USAGE_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(now)
    const value = type => parts.find(part => part.type === type)?.value || ''
    return `${value('year')}-${value('month')}-${value('day')}`
}

function parseAnonymousUsageDescriptor(distribution) {
    const descriptor = distribution?.rawDistribution?.telemetry?.anonymousDailyActive
    if(descriptor == null || descriptor.timeZone !== ANONYMOUS_USAGE_TIME_ZONE) {
        return null
    }
    try {
        const endpoint = new URL(descriptor.endpoint)
        if(endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
            return null
        }
        return { endpoint: endpoint.toString(), timeZone: descriptor.timeZone }
    } catch {
        return null
    }
}

function getOrCreateDailyToken(configManager, endpoint, now = new Date(), randomBytes = crypto.randomBytes) {
    const date = getAnonymousUsageDate(now)
    const scope = crypto.createHash('sha256').update(endpoint).digest('hex')
    const current = configManager.getAnonymousUsageState()
    if(current?.date === date && current?.scope === scope && DAILY_TOKEN_PATTERN.test(current.dailyToken || '')) {
        return current.dailyToken
    }
    const dailyToken = randomBytes(32).toString('base64url')
    configManager.setAnonymousUsageState({ date, scope, dailyToken })
    configManager.save()
    return dailyToken
}

async function reportAnonymousUsage(distribution, options = {}) {
    const configManager = options.configManager ?? require('./configmanager')
    if(!configManager.getAnonymousUsage()) {
        const current = configManager.getAnonymousUsageState()
        if(current?.date || current?.scope || current?.dailyToken) {
            configManager.clearAnonymousUsageState()
            configManager.save()
        }
        return false
    }
    const descriptor = parseAnonymousUsageDescriptor(distribution)
    if(descriptor == null) {
        return false
    }
    const dailyToken = getOrCreateDailyToken(
        configManager,
        descriptor.endpoint,
        options.now ?? new Date(),
        options.randomBytes ?? crypto.randomBytes
    )
    const requestClient = options.requestClient ?? got
    try {
        const response = await requestClient.post(descriptor.endpoint, {
            json: { dailyToken },
            headers: { 'user-agent': 'MapleCraftLauncher-Anonymous-Usage' },
            followRedirect: false,
            retry: { limit: 0 },
            timeout: { request: ANONYMOUS_USAGE_TIMEOUT_MS },
            throwHttpErrors: false
        })
        return response.statusCode === 204
    } catch(error) {
        logger.debug('Anonymous usage signal was not delivered.', error?.code ?? error?.name ?? 'request failed')
        return false
    }
}

exports.ANONYMOUS_USAGE_TIME_ZONE = ANONYMOUS_USAGE_TIME_ZONE
exports.ANONYMOUS_USAGE_TIMEOUT_MS = ANONYMOUS_USAGE_TIMEOUT_MS
exports.getAnonymousUsageDate = getAnonymousUsageDate
exports.parseAnonymousUsageDescriptor = parseAnonymousUsageDescriptor
exports.getOrCreateDailyToken = getOrCreateDailyToken
exports.reportAnonymousUsage = reportAnonymousUsage
