function loadDecodedBackground(source, options = {}){
    const createImage = options.createImage ?? (() => new globalThis.Image())
    const schedule = options.schedule ?? setTimeout
    const cancel = options.cancel ?? clearTimeout
    return new Promise((resolve, reject) => {
        const image = createImage()
        let settled = false
        let timer
        const finish = error => {
            if(settled) return
            settled = true
            cancel(timer)
            image.onload = null
            image.onerror = null
            if(error) reject(error)
            else resolve(image)
        }
        timer = schedule(() => finish(new Error('Background image load timed out')), options.timeoutMs ?? 5000)
        image.decoding = 'async'
        image.onload = async () => {
            try {
                if(typeof image.decode === 'function') await image.decode()
                finish()
            } catch(error) {
                finish(error)
            }
        }
        image.onerror = () => finish(new Error('Background image could not be decoded'))
        image.src = source
    })
}

class ServerBackgroundPool {
    constructor(options){
        this.cache = options.cache
        this.loadImage = options.loadImage ?? loadDecodedBackground
        this.onUpdate = options.onUpdate ?? (() => {})
        this.onError = options.onError ?? (() => {})
        this.entries = new Map()
        this.queue = []
        this.active = 0
    }

    get(key){
        return this.entries.get(key)?.asset ?? null
    }

    prepare(resource, options = {}){
        let entry = this.entries.get(resource.key)
        if(!entry){
            entry = { resource, asset: null, pending: null }
            this.entries.set(resource.key, entry)
        }
        if(entry.pending){
            if(options.priority){
                const index = this.queue.indexOf(entry)
                if(index > 0){
                    this.queue.splice(index, 1)
                    this.queue.unshift(entry)
                }
            }
            return entry.pending
        }
        entry.resource = resource
        if(resource.descriptor == null && entry.asset != null){
            return Promise.resolve(entry.asset)
        }
        entry.pending = new Promise(resolve => { entry.complete = resolve })
        if(options.priority) this.queue.unshift(entry)
        else this.queue.push(entry)
        this._drain()
        return entry.pending
    }

    retain(resources){
        const retained = new Set(resources.map(resource => resource.key))
        for(const [key, entry] of this.entries){
            if(!retained.has(key)){
                this.entries.delete(key)
                entry.asset = null
            }
        }
        this.queue = this.queue.filter(entry => {
            if(this._isCurrent(entry)) return true
            entry.complete(null)
            entry.pending = null
            return false
        })
    }

    _isCurrent(entry){
        return this.entries.get(entry.resource.key) === entry
    }

    _drain(){
        while(this.active < 2 && this.queue.length > 0){
            const entry = this.queue.shift()
            this.active++
            void this._prepare(entry).catch(error => {
                if(this._isCurrent(entry)) this.onError(error, entry.resource)
            }).finally(() => {
                entry.complete(this._isCurrent(entry) ? entry.asset : null)
                entry.pending = null
                this.active--
                this._drain()
            })
        }
    }

    async _prepare(entry){
        const { descriptor, source } = entry.resource
        if(descriptor == null){
            await this._load(entry, source)
            return
        }
        const resolution = await this.cache.resolve(descriptor)
        // Attach both handlers before decoding the current image: refresh may
        // fail while decoding is still in progress.
        const refresh = resolution.refresh == null ? null : resolution.refresh.then(
            url => ({ url }), error => ({ error })
        )
        if(resolution.currentUrl != null){
            await this._load(entry, resolution.currentUrl)
        }
        if(refresh != null){
            const result = await refresh
            if(result.error) throw result.error
            if(result.url != null) await this._load(entry, result.url)
        }
    }

    async _load(entry, url){
        if(!this._isCurrent(entry) || entry.asset?.url === url) return
        try {
            const image = await this.loadImage(url)
            if(this._isCurrent(entry)){
                entry.asset = { url, image }
                this.onUpdate(entry.resource.key, entry.asset)
            }
        } catch(error) {
            if(this._isCurrent(entry)) this.onError(error, entry.resource)
        }
    }
}

module.exports = { ServerBackgroundPool, loadDecodedBackground }
