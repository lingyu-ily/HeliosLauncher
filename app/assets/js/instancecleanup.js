const fs = require('fs-extra')
const path = require('path')

function createCleanupError(code, message) {
    const error = new Error(message)
    error.code = code
    return error
}

function pathsEqual(first, second) {
    if(process.platform === 'win32') {
        return first.toLowerCase() === second.toLowerCase()
    }
    return first === second
}

function normalizeInstanceId(instanceId) {
    const value = String(instanceId)
    return process.platform === 'win32' ? value.toLowerCase() : value
}

function validateInstanceId(instanceId) {
    if(typeof instanceId !== 'string'
        || instanceId.length === 0
        || instanceId === '.'
        || instanceId === '..'
        || instanceId.includes('\0')
        || /[\\/*?]/.test(instanceId)) {
        throw createCleanupError('INVALID_INSTANCE_ID', 'The instance ID is not a safe directory name.')
    }
}

function normalizeServerIds(serverIds) {
    return new Set(Array.from(serverIds ?? [], normalizeInstanceId))
}

async function validateStaleInstance(instanceDirectory, instanceId, activeServerIds, options = {}) {
    validateInstanceId(instanceId)
    const fsApi = options.fsApi ?? fs
    const activeIds = normalizeServerIds(activeServerIds)
    if(activeIds.has(normalizeInstanceId(instanceId))) {
        throw createCleanupError('ACTIVE_INSTANCE', `Instance ${instanceId} belongs to a current server.`)
    }

    const rootPath = path.resolve(instanceDirectory)
    const targetPath = path.resolve(rootPath, instanceId)
    if(!pathsEqual(path.dirname(targetPath), rootPath)) {
        throw createCleanupError('INSTANCE_OUTSIDE_ROOT', 'The instance path is outside the instances directory.')
    }

    const stats = await fsApi.lstat(targetPath)
    if(stats.isSymbolicLink() || !stats.isDirectory()) {
        throw createCleanupError('INVALID_INSTANCE_TYPE', 'The instance path is not a physical directory.')
    }

    const [realRootPath, realTargetPath] = await Promise.all([
        fsApi.realpath(rootPath),
        fsApi.realpath(targetPath)
    ])
    if(!pathsEqual(path.dirname(realTargetPath), realRootPath)) {
        throw createCleanupError('INSTANCE_OUTSIDE_ROOT', 'The instance resolves outside the instances directory.')
    }

    return {
        id: instanceId,
        path: targetPath
    }
}

async function scanStaleInstances(instanceDirectory, activeServerIds, options = {}) {
    const fsApi = options.fsApi ?? fs
    const rootPath = path.resolve(instanceDirectory)
    let entries
    try {
        entries = await fsApi.readdir(rootPath, { withFileTypes: true })
    } catch(error) {
        if(error.code === 'ENOENT') {
            return []
        }
        throw error
    }

    const activeIds = normalizeServerIds(activeServerIds)
    const staleInstances = []
    for(const entry of entries) {
        if(!entry.isDirectory()
            || entry.isSymbolicLink()
            || activeIds.has(normalizeInstanceId(entry.name))) {
            continue
        }
        try {
            staleInstances.push(await validateStaleInstance(rootPath, entry.name, activeIds, { fsApi }))
        } catch(error) {
            if(error.code !== 'ENOENT'
                && error.code !== 'INVALID_INSTANCE_ID'
                && error.code !== 'INVALID_INSTANCE_TYPE'
                && error.code !== 'INSTANCE_OUTSIDE_ROOT') {
                throw error
            }
        }
    }

    return staleInstances.sort((first, second) => {
        if(first.id === second.id) {
            return 0
        }
        return first.id < second.id ? -1 : 1
    })
}

async function deleteStaleInstances(instanceDirectory, instanceIds, getActiveServerIds, options = {}) {
    const fsApi = options.fsApi ?? fs
    const remove = options.remove ?? (target => fsApi.remove(target))
    const onProgress = options.onProgress ?? (() => undefined)
    const uniqueIds = Array.from(new Set(instanceIds))
    const result = {
        deleted: [],
        failed: []
    }

    for(let index = 0; index < uniqueIds.length; index++) {
        const instanceId = uniqueIds[index]
        let success = false
        try {
            const activeServerIds = await getActiveServerIds()
            const instance = await validateStaleInstance(instanceDirectory, instanceId, activeServerIds, { fsApi })
            await remove(instance.path)
            result.deleted.push(instance)
            success = true
        } catch(error) {
            result.failed.push({ id: instanceId, error })
        }
        try {
            await onProgress({
                completed: index + 1,
                total: uniqueIds.length,
                id: instanceId,
                success
            })
        } catch(_error) {
            // Progress reporting must not interrupt the cleanup queue.
        }
    }

    return result
}

exports.deleteStaleInstances = deleteStaleInstances
exports.scanStaleInstances = scanStaleInstances
exports.validateStaleInstance = validateStaleInstance
