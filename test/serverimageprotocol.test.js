const assert = require('node:assert/strict')
const { join } = require('node:path')
const { test } = require('node:test')

const { resolveServerImageCacheRequest } = require('../app/assets/js/serverimageprotocol')

const HASH = 'a'.repeat(32)
const FILE = `asset-${'b'.repeat(64)}.png`

test('resolves a valid server image cache URL inside the cache root', () => {
    const cacheRoot = join('C:', 'cache-root')
    const resolved = resolveServerImageCacheRequest(
        cacheRoot,
        `maplecraft-image://cache/${HASH}/icon/${FILE}`
    )

    assert.equal(resolved.filePath, join(cacheRoot, HASH, 'icon', FILE))
    assert.equal(resolved.contentType, 'image/png')
})

test('rejects invalid hosts, asset types, filenames, and traversal attempts', () => {
    const cacheRoot = join('C:', 'cache-root')
    const invalidUrls = [
        `maplecraft-image://other/${HASH}/icon/${FILE}`,
        `maplecraft-image://cache/${HASH}/video/${FILE}`,
        `maplecraft-image://cache/${HASH}/icon/not-an-asset.png`,
        `maplecraft-image://cache/${HASH}/icon/%2e%2e/${FILE}`,
        `maplecraft-image://cache/${HASH}/icon/${FILE}/extra`
    ]

    for(const url of invalidUrls){
        assert.equal(resolveServerImageCacheRequest(cacheRoot, url), null)
    }
})
