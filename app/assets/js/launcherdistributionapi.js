const got = require('got')
const { LoggerUtil } = require('helios-core')
const {
    DistributionAPI,
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
            this.lastLoadSource = 'remote'
            logger.info('Loaded remote distribution index.')
            return {
                data: response.body,
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
        const distribution = await super.pullLocal()
        if(distribution != null) {
            this.lastLoadSource = 'cache'
            logger.warn('Loaded the cached distribution index.')
        } else {
            logger.error('No valid cached distribution index is available.')
        }
        return distribution
    }

    getLastLoadSource() {
        return this.lastLoadSource
    }
}

exports.LauncherDistributionAPI = LauncherDistributionAPI
exports.REMOTE_DISTRO_TIMEOUT_MS = REMOTE_DISTRO_TIMEOUT_MS
