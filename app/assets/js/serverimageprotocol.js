const path = require('path')

const SERVER_IMAGE_CONTENT_TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    svg: 'image/svg+xml'
}

function resolveServerImageCacheRequest(cacheRoot, requestUrl){
    let parsed
    try {
        parsed = new URL(requestUrl)
    } catch {
        return null
    }
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const serverHash = pathParts[0]
    const imageType = pathParts[1]
    const fileName = pathParts[2]
    const fileMatch = fileName?.match(/^asset-[a-f\d]{64}\.(png|jpg|webp|gif|avif|svg)$/)

    if(parsed.hostname !== 'cache'
        || pathParts.length !== 3
        || !/^[a-f\d]{32}$/.test(serverHash)
        || !/^(?:icon|logo|background)$/.test(imageType)
        || fileMatch == null){
        return null
    }

    const resolvedRoot = path.resolve(cacheRoot)
    const filePath = path.resolve(resolvedRoot, serverHash, imageType, fileName)
    if(!filePath.startsWith(`${resolvedRoot}${path.sep}`)){
        return null
    }
    return {
        contentType: SERVER_IMAGE_CONTENT_TYPES[fileMatch[1]],
        filePath
    }
}

module.exports = {
    SERVER_IMAGE_CONTENT_TYPES,
    resolveServerImageCacheRequest
}
