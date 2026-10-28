const got = require('got')
const { join } = require('node:path')
const { LoggerUtil } = require('helios-core')
const { atomicWrite, resolveDistribution, validateDistribution } = require('./distributionmanifest')
const {
    DistributionAPI,
    HeliosDistribution,
    RestResponseStatus,
    handleGotError
} = require('helios-core/common')

const logger = LoggerUtil.getLogger('LauncherDistributionAPI')

const REMOTE_DISTRO_TIMEOUT_MS = 12000

class LauncherDistributionAPI extends DistributionAPI {

    constructor(launcherDirectory, commonDir, instanceDir, remoteUrl, devMode, options = {}) {
        super(launcherDirectory, commonDir, instanceDir, remoteUrl, devMode)
        this.requestClient = options.requestClient ?? got
        this.requestTimeoutMs = options.requestTimeoutMs ?? REMOTE_DISTRO_TIMEOUT_MS
        this.lastLoadSource = null
    }

    async pullRemote() {
        logger.info(`Loading remote distribution index (timeout ${this.requestTimeoutMs}ms).`)
        try {
            const response = await this.requestClient.get(this.remoteUrl, {
                responseType: 'json',
                retry: { limit: 0 },
                timeout: { request: this.requestTimeoutMs }
            })
            const data = await resolveDistribution(response.body, {
                remoteUrl: this.remoteUrl,
                cacheDirectory: join(this.launcherDirectory, 'distribution-servers'),
                download: async url => (await this.requestClient.get(url, {
                    responseType: 'buffer',
                    retry: { limit: 0 },
                    timeout: { request: this.requestTimeoutMs }
                })).body
            })
            // Validate with the actual core parser before replacing the usable cache.
            new HeliosDistribution(data, this.commonDir, this.instanceDir)
            this.lastLoadSource = 'remote'
            logger.info('Loaded remote distribution index.')
            return {
                data,
                responseStatus: RestResponseStatus.SUCCESS
            }
        } catch(error) {
            this.lastLoadSource = null
            const result = handleGotError('Pull Remote Distribution', error, logger, () => null)
            logger.warn('Remote distribution unavailable. Attempting the local cache.')
            return result
        }
    }

    async pullLocal() {
        let distribution = null
        try {
            const cached = await super.pullLocal()
            if(cached != null) {
                validateDistribution(cached)
                new HeliosDistribution(cached, this.commonDir, this.instanceDir)
                distribution = cached
            }
        } catch(error) {
            logger.warn('Cached distribution could not be read or validated.', error)
        }
        if(distribution != null) {
            this.lastLoadSource = 'cache'
            logger.warn('Loaded the cached distribution index.')
        } else {
            this.lastLoadSource = null
            logger.error('No valid cached distribution index is available.')
        }
        return distribution
    }

    async writeDistributionToDisk(distribution) {
        await atomicWrite(this.distroPath, JSON.stringify(distribution))
    }

    async _loadDistributionNullable() {
        if(!this.devMode) {
            const { data } = await this.pullRemote()
            if(data != null) {
                try {
                    await this.writeDistributionToDisk(data)
                    return data
                } catch(error) {
                    logger.warn('Could not commit the new distribution cache. Keeping the previous distribution.', error)
                }
            }
        }
        return this.pullLocal()
    }

    getLastLoadSource() {
        return this.lastLoadSource
    }
}

exports.LauncherDistributionAPI = LauncherDistributionAPI
exports.REMOTE_DISTRO_TIMEOUT_MS = REMOTE_DISTRO_TIMEOUT_MS
