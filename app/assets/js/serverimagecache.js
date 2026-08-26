const crypto = require('crypto')
const fs = require('fs-extra')
const got = require('got')
const path = require('path')

const SERVER_IMAGE_REVALIDATE_MS = 24*60*60*1000
const SERVER_IMAGE_FAILURE_RETRY_MS = 10*60*1000

const SERVER_IMAGE_TYPES = {
    icon: { maximumSize: 5*1024*1024 },
    logo: { maximumSize: 10*1024*1024 },
    background: { maximumSize: 25*1024*1024 }
}

const IMAGE_CONTENT_TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/svg+xml': 'svg'
}

function normalizeRemoteImageSource(source){
    if(typeof source !== 'string' || source.trim().length === 0){
        return null
    }
    try {
        const parsed = new URL(source.trim())
        if((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password){
            return null
        }
        return parsed.toString()
    } catch {
        return null
    }
}

function normalizeContentType(value){
    if(Array.isArray(value)){
        value = value[0]
    }
    return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''
}

async function requestRemoteImage(url, { headers, maximumSize }){
    const request = got.stream(url, {
        headers,
        retry: { limit: 0 },
        timeout: {
            response: 15000,
            request: 30000
        },
        throwHttpErrors: false
    })
    const chunks = []
    let response = null
    let size = 0

    request.once('response', value => {
        response = value
        const contentLength = Number(value.headers['content-length'])
        if(Number.isFinite(contentLength) && contentLength > maximumSize){
            request.destroy(new Error(`Server image exceeds ${maximumSize} bytes`))
        }
    })

    for await (const chunk of request){
        size += chunk.length
        if(size > maximumSize){
            request.destroy()
            throw new Error(`Server image exceeds ${maximumSize} bytes`)
        }
        chunks.push(chunk)
    }

    if(response == null){
        throw new Error('Server image request completed without a response')
    }
    return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks, size)
    }
}

class ServerImageCache {
    constructor(cacheRoot, options = {}){
        this.cacheRoot = cacheRoot
        this.requestImage = options.requestImage ?? requestRemoteImage
        this.now = options.now ?? (() => Date.now())
        this.revalidateMs = options.revalidateMs ?? SERVER_IMAGE_REVALIDATE_MS
        this.failureRetryMs = options.failureRetryMs ?? SERVER_IMAGE_FAILURE_RETRY_MS
        this.inFlight = new Map()
        this.slotSequences = new Map()
    }

    async resolve(descriptor){
        const context = this._resolveContext(descriptor)
        if(context.source == null){
            return { currentUrl: null, refresh: null }
        }

        const state = await this._readState(context)
        if(this._isFresh(state, context) || this._isFailureCoolingDown(state.metadata, context)){
            return { currentUrl: state.currentUrl, refresh: null }
        }

        return {
            currentUrl: state.currentUrl,
            refresh: this._startRefresh(context, state)
        }
    }

    async invalidate(descriptor){
        const context = this._resolveContext(descriptor)
        this.slotSequences.set(context.slotKey, (this.slotSequences.get(context.slotKey) ?? 0) + 1)
        this.inFlight.delete(context.slotKey)
        await fs.remove(context.cacheDirectory)
    }

    _resolveContext(descriptor){
        if(typeof descriptor?.serverId !== 'string' || descriptor.serverId.length === 0){
            throw new Error('A server ID is required to cache a server image')
        }
        if(SERVER_IMAGE_TYPES[descriptor.type] == null){
            throw new Error(`Unsupported server image type: ${descriptor.type}`)
        }
        const serverHash = crypto.createHash('sha256').update(descriptor.serverId).digest('hex').slice(0, 32)
        const cacheDirectory = path.join(this.cacheRoot, serverHash, descriptor.type)
        return {
            serverId: descriptor.serverId,
            serverVersion: typeof descriptor.serverVersion === 'string' ? descriptor.serverVersion : '',
            type: descriptor.type,
            source: normalizeRemoteImageSource(descriptor.source),
            serverHash,
            cacheDirectory,
            metadataPath: path.join(cacheDirectory, 'metadata.json'),
            slotKey: `${serverHash}\u0000${descriptor.type}`,
            maximumSize: SERVER_IMAGE_TYPES[descriptor.type].maximumSize
        }
    }

    async _readState(context){
        let metadata = await fs.readJson(context.metadataPath).catch(() => null)
        if(metadata == null){
            return { metadata: null, currentUrl: null }
        }
        if(metadata.version !== 1 || metadata.type !== context.type){
            await fs.remove(context.cacheDirectory)
            return { metadata: null, currentUrl: null }
        }
        if(metadata.fileName == null){
            await this._cleanupCacheDirectory(context, null)
            return { metadata, currentUrl: null }
        }
        const extension = IMAGE_CONTENT_TYPES[metadata.contentType]
        if(typeof metadata.contentHash !== 'string'
            || !/^[a-f\d]{64}$/.test(metadata.contentHash)
            || metadata.fileName !== `asset-${metadata.contentHash}.${extension}`
            || extension == null
            || !Number.isSafeInteger(metadata.size)
            || metadata.size <= 0
            || metadata.size > context.maximumSize){
            await fs.remove(context.cacheDirectory)
            return { metadata: null, currentUrl: null }
        }
        const filePath = path.join(context.cacheDirectory, metadata.fileName)
        const fileStat = await fs.stat(filePath).catch(() => null)
        if(!fileStat?.isFile() || fileStat.size !== metadata.size){
            await fs.remove(context.cacheDirectory)
            return { metadata: null, currentUrl: null }
        }
        await this._cleanupCacheDirectory(context, metadata.fileName)
        return {
            metadata,
            currentUrl: this._cacheUrl(context, metadata.fileName)
        }
    }

    _isFresh(state, context){
        return state.currentUrl != null
            && state.metadata.source === context.source
            && state.metadata.serverVersion === context.serverVersion
            && Number.isFinite(state.metadata.checkedAt)
            && this.now() - state.metadata.checkedAt < this.revalidateMs
    }

    _isFailureCoolingDown(metadata, context){
        return metadata?.lastFailureSource === context.source
            && metadata?.lastFailureServerVersion === context.serverVersion
            && Number.isFinite(metadata?.lastFailureAt)
            && this.now() - metadata.lastFailureAt < this.failureRetryMs
    }

    _startRefresh(context, state){
        const identity = `${context.source}\u0000${context.serverVersion}`
        const current = this.inFlight.get(context.slotKey)
        if(current?.identity === identity){
            return current.promise
        }

        const sequence = (this.slotSequences.get(context.slotKey) ?? 0) + 1
        this.slotSequences.set(context.slotKey, sequence)
        const promise = this._refresh(context, state, sequence).finally(() => {
            if(this.inFlight.get(context.slotKey)?.promise === promise){
                this.inFlight.delete(context.slotKey)
            }
        })
        this.inFlight.set(context.slotKey, { identity, promise })
        return promise
    }

    async _refresh(context, state, sequence){
        const headers = {
            Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8'
        }
        if(state.currentUrl != null && state.metadata.source === context.source){
            if(typeof state.metadata.etag === 'string' && state.metadata.etag.length > 0){
                headers['If-None-Match'] = state.metadata.etag
            }
            if(typeof state.metadata.lastModified === 'string' && state.metadata.lastModified.length > 0){
                headers['If-Modified-Since'] = state.metadata.lastModified
            }
        }

        let candidateFileName = null
        try {
            const response = await this.requestImage(context.source, {
                headers,
                maximumSize: context.maximumSize
            })
            if(sequence !== this.slotSequences.get(context.slotKey)){
                return state.currentUrl
            }
            if(response.statusCode === 304){
                if(state.currentUrl == null || state.metadata.source !== context.source){
                    throw new Error('Server returned 304 without a matching cached image')
                }
                const metadata = {
                    ...state.metadata,
                    serverVersion: context.serverVersion,
                    checkedAt: this.now(),
                    lastFailureAt: null,
                    lastFailureSource: null,
                    lastFailureServerVersion: null
                }
                await this._writeMetadata(context, metadata)
                return state.currentUrl
            }
            if(response.statusCode !== 200){
                throw new Error(`Server image request failed with status ${response.statusCode}`)
            }

            const contentType = normalizeContentType(response.headers?.['content-type'])
            const extension = IMAGE_CONTENT_TYPES[contentType]
            if(extension == null){
                throw new Error(`Unsupported server image content type: ${contentType || 'missing'}`)
            }
            if(!Buffer.isBuffer(response.body) || response.body.length === 0 || response.body.length > context.maximumSize){
                throw new Error(`Server image has an invalid size: ${response.body?.length ?? 0}`)
            }

            const contentHash = crypto.createHash('sha256').update(response.body).digest('hex')
            const fileName = `asset-${contentHash}.${extension}`
            const filePath = path.join(context.cacheDirectory, fileName)
            const partPath = path.join(context.cacheDirectory, `${fileName}.${crypto.randomUUID()}.part`)
            await fs.ensureDir(context.cacheDirectory)
            await fs.writeFile(partPath, response.body, { flag: 'wx' })
            if(sequence !== this.slotSequences.get(context.slotKey)){
                await fs.remove(partPath)
                return state.currentUrl
            }
            await fs.move(partPath, filePath, { overwrite: true })
            candidateFileName = fileName

            const completedAt = this.now()
            const metadata = {
                version: 1,
                type: context.type,
                source: context.source,
                serverVersion: context.serverVersion,
                etag: typeof response.headers?.etag === 'string' ? response.headers.etag : null,
                lastModified: typeof response.headers?.['last-modified'] === 'string' ? response.headers['last-modified'] : null,
                contentType,
                contentHash,
                fileName,
                size: response.body.length,
                cachedAt: completedAt,
                checkedAt: completedAt,
                lastFailureAt: null,
                lastFailureSource: null,
                lastFailureServerVersion: null
            }
            if(sequence !== this.slotSequences.get(context.slotKey)){
                await this._removeUnreferencedFile(context, fileName)
                return state.currentUrl
            }
            await this._writeMetadata(context, metadata)
            if(state.metadata?.fileName && state.metadata.fileName !== fileName){
                await fs.remove(path.join(context.cacheDirectory, state.metadata.fileName)).catch(() => undefined)
            }
            return this._cacheUrl(context, fileName)
        } catch(err) {
            if(candidateFileName != null){
                await this._removeUnreferencedFile(context, candidateFileName)
            }
            if(sequence === this.slotSequences.get(context.slotKey)){
                await this._recordFailure(context, state.metadata)
            }
            throw err
        }
    }

    async _recordFailure(context, metadata){
        await this._writeMetadata(context, {
            version: 1,
            type: context.type,
            source: metadata?.source ?? null,
            serverVersion: metadata?.serverVersion ?? null,
            etag: metadata?.etag ?? null,
            lastModified: metadata?.lastModified ?? null,
            contentType: metadata?.contentType ?? null,
            contentHash: metadata?.contentHash ?? null,
            fileName: metadata?.fileName ?? null,
            size: metadata?.size ?? null,
            cachedAt: metadata?.cachedAt ?? null,
            checkedAt: metadata?.checkedAt ?? null,
            lastFailureAt: this.now(),
            lastFailureSource: context.source,
            lastFailureServerVersion: context.serverVersion
        })
    }

    async _writeMetadata(context, metadata){
        await fs.ensureDir(context.cacheDirectory)
        const partPath = path.join(context.cacheDirectory, `metadata.${crypto.randomUUID()}.part`)
        try {
            await fs.writeJson(partPath, metadata)
            await fs.move(partPath, context.metadataPath, { overwrite: true })
        } finally {
            await fs.remove(partPath)
        }
    }

    async _removeUnreferencedFile(context, fileName){
        const metadata = await fs.readJson(context.metadataPath).catch(() => null)
        if(metadata?.fileName !== fileName){
            await fs.remove(path.join(context.cacheDirectory, fileName))
        }
    }

    async _cleanupCacheDirectory(context, keepFileName){
        if(this.inFlight.has(context.slotKey)){
            return
        }
        const files = await fs.readdir(context.cacheDirectory).catch(() => [])
        await Promise.all(files.map(fileName => {
            if(fileName === 'metadata.json' || fileName === keepFileName){
                return undefined
            }
            if(fileName.endsWith('.part') || /^asset-[a-f\d]{64}\.(?:png|jpg|webp|gif|avif|svg)$/.test(fileName)){
                return fs.remove(path.join(context.cacheDirectory, fileName))
            }
            return undefined
        }))
    }

    _cacheUrl(context, fileName){
        return `maplecraft-image://cache/${context.serverHash}/${context.type}/${fileName}`
    }
}

module.exports = {
    IMAGE_CONTENT_TYPES,
    SERVER_IMAGE_FAILURE_RETRY_MS,
    SERVER_IMAGE_REVALIDATE_MS,
    SERVER_IMAGE_TYPES,
    ServerImageCache,
    normalizeRemoteImageSource,
    requestRemoteImage
}
