const DISTRIBUTION_NOTICE_SUCCESS_MS = 2000

class DistributionNoticeController {

    constructor(render, options = {}) {
        this.render = render
        this.successDurationMs = options.successDurationMs ?? DISTRIBUTION_NOTICE_SUCCESS_MS
        this.schedule = options.schedule ?? setTimeout
        this.cancel = options.cancel ?? clearTimeout
        this.successTimer = null
    }

    setState(state) {
        if(this.successTimer != null){
            this.cancel(this.successTimer)
            this.successTimer = null
        }
        this.render(state)
    }

    showUnavailable() {
        this.setState('offline')
    }

    showRetrying() {
        this.setState('retrying')
    }

    showSuccess() {
        this.setState('success')
        const timer = this.schedule(() => {
            if(this.successTimer === timer){
                this.successTimer = null
                this.render('hidden')
            }
        }, this.successDurationMs)
        this.successTimer = timer
    }

    hide() {
        this.setState('hidden')
    }
}

class DistributionRefreshController {

    constructor(refreshDistribution, getLoadSource, applyDistribution, handlers = {}) {
        this.refreshDistribution = refreshDistribution
        this.getLoadSource = getLoadSource
        this.applyDistribution = applyDistribution
        this.onUnavailable = handlers.onUnavailable ?? (() => undefined)
        this.onRetrying = handlers.onRetrying ?? (() => undefined)
        this.onSuccess = handlers.onSuccess ?? (() => undefined)
        this.currentAttempt = null
    }

    refresh(options = {}) {
        const showProgress = options.showProgress === true
        const announceRecovery = options.announceRecovery === true

        if(showProgress){
            this.onRetrying()
        }

        if(this.currentAttempt == null){
            const attempt = (async () => {
                const data = await this.refreshDistribution()
                if(data == null){
                    throw new Error('The distribution refresh returned no data.')
                }
                await this.applyDistribution(data)
                return {
                    data,
                    source: this.getLoadSource()
                }
            })()
            const trackedAttempt = attempt.finally(() => {
                if(this.currentAttempt === trackedAttempt){
                    this.currentAttempt = null
                }
            })
            this.currentAttempt = trackedAttempt
        }

        return this.currentAttempt.then(result => {
            if(result.source === 'remote'){
                if(announceRecovery){
                    this.onSuccess()
                }
            } else {
                this.onUnavailable()
            }
            return result.data
        }, error => {
            this.onUnavailable()
            throw error
        })
    }
}

exports.DISTRIBUTION_NOTICE_SUCCESS_MS = DISTRIBUTION_NOTICE_SUCCESS_MS
exports.DistributionNoticeController = DistributionNoticeController
exports.DistributionRefreshController = DistributionRefreshController
