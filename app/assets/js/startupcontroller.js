class StartupController {

    constructor(load, initialize, onFailure) {
        this.load = load
        this.initialize = initialize
        this.onFailure = onFailure
        this.state = 'idle'
        this.currentAttempt = null
    }

    getState() {
        return this.state
    }

    start() {
        if(this.state === 'loading' || this.state === 'ready') {
            return this.currentAttempt
        }

        this.state = 'loading'
        const attempt = (async () => {
            try {
                const data = await this.load()
                await this.initialize(data)
                this.state = 'ready'
                return data
            } catch(error) {
                this.state = 'error'
                await this.onFailure(error)
                return null
            }
        })()
        this.currentAttempt = attempt
        return attempt
    }

    retry() {
        if(this.state !== 'error') {
            return this.currentAttempt
        }
        return this.start()
    }
}

exports.StartupController = StartupController
