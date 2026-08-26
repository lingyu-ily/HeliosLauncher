class ServerStatusCache {
    constructor(cooldownMs = 10000, now = () => Date.now()){
        this.cooldownMs = cooldownMs
        this.now = now
        this.entries = new Map()
        this.inFlight = new Map()
    }

    get(key){
        const entry = this.entries.get(key)
        if(entry == null){
            return null
        }
        return {
            value: entry.value,
            updatedAt: entry.updatedAt,
            fresh: this.now() - entry.updatedAt < this.cooldownMs
        }
    }

    refresh(key, loader){
        const cached = this.get(key)
        if(cached?.fresh){
            return Promise.resolve(cached.value)
        }

        const currentRequest = this.inFlight.get(key)
        if(currentRequest != null){
            return currentRequest
        }

        const request = Promise.resolve()
            .then(loader)
            .then(value => {
                this.entries.set(key, {
                    value,
                    updatedAt: this.now()
                })
                return value
            })
            .finally(() => {
                if(this.inFlight.get(key) === request){
                    this.inFlight.delete(key)
                }
            })

        this.inFlight.set(key, request)
        return request
    }
}

module.exports = { ServerStatusCache }
