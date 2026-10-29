const { createHash, randomUUID } = require('node:crypto')
const { mkdir, open, readFile, rename } = require('node:fs/promises')
const { dirname, join } = require('node:path')
const { Type } = require('helios-distribution-types')
const { validateServerGroups } = require('./servergroups')

const SERVER_DOWNLOAD_CONCURRENCY = 4
const moduleTypes = new Set(Object.values(Type))

function validateServer(server) {
    if(!server || ['id', 'name', 'address', 'minecraftVersion'].some(key =>
        typeof server[key] !== 'string' || server[key].length === 0) || !Array.isArray(server.modules)) {
        throw new Error('Invalid distribution server.')
    }
    function validateModules(modules) {
        for(const module of modules) {
            if(!module || typeof module.id !== 'string' || !moduleTypes.has(module.type)
                || typeof module.artifact?.url !== 'string'
                || !Number.isSafeInteger(module.artifact.size) || module.artifact.size < 0) {
                throw new Error(`Invalid module in server ${server.id}.`)
            }
            if(module.subModules != null) {
                if(!Array.isArray(module.subModules)) {
                    throw new Error(`Invalid subModules in server ${server.id}.`)
                }
                validateModules(module.subModules)
            }
        }
    }
    validateModules(server.modules)
    return server
}

function validateDistribution(distribution) {
    if(!distribution || !Array.isArray(distribution.servers) || distribution.servers.length === 0
        || (distribution.distributionFormat != null && distribution.distributionFormat !== 1)) {
        throw new Error('Invalid complete distribution.')
    }
    const ids = new Set()
    for(const server of distribution.servers) {
        validateServer(server)
        if(ids.has(server.id)) {
            throw new Error(`Duplicate server ID: ${server.id}.`)
        }
        ids.add(server.id)
    }
    validateServerGroups(distribution)
    return distribution
}

// A failed/interrupted write leaves an unreferenced temporary file, never a
// truncated complete cache. Temporary files are intentionally not auto-deleted.
async function atomicWrite(path, body) {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    const file = await open(temporaryPath, 'wx')
    try {
        await file.writeFile(body)
        await file.sync()
    } finally {
        await file.close()
    }
    await rename(temporaryPath, path)
}

function parseServer(body, reference) {
    if(body.length !== reference.size
        || createHash('sha256').update(body).digest('hex') !== reference.sha256) {
        throw new Error(`Distribution integrity check failed for ${reference.id}.`)
    }
    const server = validateServer(JSON.parse(body.toString('utf8')))
    if(server.id !== reference.id) {
        throw new Error(`Distribution server ID does not match ${reference.id}.`)
    }
    return server
}

async function resolveDistribution(index, { remoteUrl, cacheDirectory, download }) {
    if(index?.distributionFormat !== 2) {
        return validateDistribution(index)
    }
    if(!Array.isArray(index.servers) || index.servers.length === 0) {
        throw new Error('Distribution index has no servers.')
    }
    const ids = new Set()
    const references = index.servers.map(reference => {
        if(!reference || typeof reference.id !== 'string' || reference.id.length === 0
            || ids.has(reference.id) || typeof reference.url !== 'string' || reference.url.length === 0
            || typeof reference.sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(reference.sha256)
            || !Number.isSafeInteger(reference.size) || reference.size <= 0) {
            throw new Error('Invalid distribution server reference.')
        }
        const url = new URL(reference.url, remoteUrl)
        if(!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('Invalid distribution server URL.')
        }
        ids.add(reference.id)
        return { ...reference, url: url.href }
    })
    const servers = new Array(references.length)
    let next = 0
    let failure
    async function worker() {
        while(!failure && next < references.length) {
            const position = next++
            const reference = references[position]
            const path = join(cacheDirectory, `${reference.sha256}.json`)
            try {
                let server
                try {
                    server = parseServer(await readFile(path), reference)
                } catch {
                    // Missing or corrupt cache entries must be fetched and verified again.
                }
                if(!server) {
                    const body = await download(reference.url)
                    server = parseServer(body, reference)
                    await atomicWrite(path, body)
                }
                servers[position] = server
            } catch(error) {
                failure = error
            }
        }
    }
    // Drain in-flight work before falling back, so it cannot race the next refresh.
    await Promise.all(Array.from({ length: Math.min(SERVER_DOWNLOAD_CONCURRENCY, references.length) }, worker))
    if(failure) {
        throw failure
    }
    const complete = { ...index, servers }
    delete complete.distributionFormat
    return validateDistribution(complete)
}

module.exports = { atomicWrite, resolveDistribution, validateDistribution, SERVER_DOWNLOAD_CONCURRENCY }
