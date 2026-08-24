const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')
const { test } = require('node:test')

const fs = require('fs-extra')

const {
    deleteStaleInstances,
    scanStaleInstances,
    validateStaleInstance
} = require('../app/assets/js/instancecleanup')

async function temporaryDirectory(t) {
    const directory = await mkdtemp(join(tmpdir(), 'maplecraft-instance-cleanup-test-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    return directory
}

test('lists only physical directories that do not belong to current servers', async t => {
    const root = await temporaryDirectory(t)
    const instances = join(root, 'instances')
    await mkdir(instances)
    await Promise.all([
        mkdir(join(instances, 'current-server')),
        mkdir(join(instances, 'zeta-stale')),
        mkdir(join(instances, 'alpha-stale')),
        writeFile(join(instances, 'not-an-instance.txt'), 'keep')
    ])
    const linkedTarget = join(root, 'linked-target')
    await mkdir(linkedTarget)
    try {
        await symlink(linkedTarget, join(instances, 'linked-instance'), 'junction')
    } catch(error) {
        if(error.code !== 'EPERM') {
            throw error
        }
        t.diagnostic('Directory junction creation is not permitted in this environment.')
    }

    const stale = await scanStaleInstances(instances, ['current-server'])

    assert.deepEqual(stale.map(instance => instance.id), ['alpha-stale', 'zeta-stale'])
    assert.deepEqual(stale.map(instance => instance.path), [
        resolve(instances, 'alpha-stale'),
        resolve(instances, 'zeta-stale')
    ])
})

test('returns an empty list when the instances directory does not exist', async t => {
    const root = await temporaryDirectory(t)

    assert.deepEqual(await scanStaleInstances(join(root, 'missing'), []), [])
})

test('treats server IDs as case-insensitive on Windows', { skip: process.platform !== 'win32' }, async t => {
    const root = await temporaryDirectory(t)
    const instances = join(root, 'instances')
    await mkdir(join(instances, 'Current-Server'), { recursive: true })

    assert.deepEqual(await scanStaleInstances(instances, ['current-server']), [])
    await assert.rejects(
        validateStaleInstance(instances, 'Current-Server', ['current-server']),
        error => error.code === 'ACTIVE_INSTANCE'
    )
})

test('rejects active, unsafe, non-directory, and symbolic-link targets', async t => {
    const root = await temporaryDirectory(t)
    const instances = join(root, 'instances')
    await mkdir(join(instances, 'current-server'), { recursive: true })
    await writeFile(join(instances, 'plain-file'), 'keep')

    await assert.rejects(
        validateStaleInstance(instances, 'current-server', ['current-server']),
        error => error.code === 'ACTIVE_INSTANCE'
    )
    await assert.rejects(
        validateStaleInstance(instances, '../outside', []),
        error => error.code === 'INVALID_INSTANCE_ID'
    )
    await assert.rejects(
        validateStaleInstance(instances, 'instance*', []),
        error => error.code === 'INVALID_INSTANCE_ID'
    )
    await assert.rejects(
        validateStaleInstance(instances, 'plain-file', []),
        error => error.code === 'INVALID_INSTANCE_TYPE'
    )

    const linkedTarget = join(root, 'linked-target')
    const linkedInstance = join(instances, 'linked-instance')
    await mkdir(linkedTarget)
    try {
        await symlink(linkedTarget, linkedInstance, 'junction')
        await assert.rejects(
            validateStaleInstance(instances, 'linked-instance', []),
            error => error.code === 'INVALID_INSTANCE_TYPE'
        )
    } catch(error) {
        if(error.code !== 'EPERM') {
            throw error
        }
        t.diagnostic('Directory junction creation is not permitted in this environment.')
    }
})

test('deletes selected stale instances sequentially and continues after failures', async t => {
    const root = await temporaryDirectory(t)
    const instances = join(root, 'instances')
    const outside = join(root, 'outside')
    await Promise.all([
        mkdir(join(instances, 'current-server'), { recursive: true }),
        mkdir(join(instances, 'stale-one'), { recursive: true }),
        mkdir(join(instances, 'stale-two'), { recursive: true }),
        mkdir(join(instances, 'unselected-stale'), { recursive: true }),
        mkdir(outside, { recursive: true })
    ])
    const progress = []
    let activeServerChecks = 0
    const result = await deleteStaleInstances(
        instances,
        ['stale-one', 'stale-two', 'current-server', '../outside'],
        async () => {
            activeServerChecks++
            return ['current-server']
        },
        {
            remove: async target => {
                if(basename(target) === 'stale-two') {
                    const error = new Error('in use')
                    error.code = 'EBUSY'
                    throw error
                }
                await fs.remove(target)
            },
            onProgress: state => progress.push(state)
        }
    )

    assert.deepEqual(result.deleted.map(instance => instance.id), ['stale-one'])
    assert.deepEqual(result.failed.map(instance => instance.id), [
        'stale-two',
        'current-server',
        '../outside'
    ])
    assert.equal(activeServerChecks, 4)
    assert.equal(progress.length, 4)
    assert.deepEqual(progress.map(state => state.completed), [1, 2, 3, 4])
    assert.equal(await fs.pathExists(join(instances, 'stale-one')), false)
    assert.equal(await fs.pathExists(join(instances, 'stale-two')), true)
    assert.equal(await fs.pathExists(join(instances, 'current-server')), true)
    assert.equal(await fs.pathExists(join(instances, 'unselected-stale')), true)
    assert.equal(await fs.pathExists(outside), true)
})

test('revalidates active server IDs before every deletion', async t => {
    const root = await temporaryDirectory(t)
    const instances = join(root, 'instances')
    await Promise.all([
        mkdir(join(instances, 'stale-one'), { recursive: true }),
        mkdir(join(instances, 'became-active'), { recursive: true })
    ])
    let check = 0

    const result = await deleteStaleInstances(
        instances,
        ['stale-one', 'became-active'],
        async () => ++check === 1 ? [] : ['became-active']
    )

    assert.deepEqual(result.deleted.map(instance => instance.id), ['stale-one'])
    assert.deepEqual(result.failed.map(instance => instance.id), ['became-active'])
    assert.equal(result.failed[0].error.code, 'ACTIVE_INSTANCE')
    assert.equal(await fs.pathExists(join(instances, 'became-active')), true)
})
