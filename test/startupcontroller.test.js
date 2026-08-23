const assert = require('node:assert/strict')
const { test } = require('node:test')

const { StartupController } = require('../app/assets/js/startupcontroller')

test('consumes a distribution promise that settled before startup begins', async () => {
    const settledDistribution = Promise.resolve({ id: 'distribution' })
    let initialized = 0
    const controller = new StartupController(
        () => settledDistribution,
        async data => {
            assert.equal(data.id, 'distribution')
            initialized++
        },
        async error => assert.fail(error)
    )

    await controller.start()

    assert.equal(controller.getState(), 'ready')
    assert.equal(initialized, 1)
})

test('deduplicates concurrent startup requests', async () => {
    let resolveDistribution
    const delayedDistribution = new Promise(resolve => {
        resolveDistribution = resolve
    })
    let initialized = 0
    const controller = new StartupController(
        () => delayedDistribution,
        async () => { initialized++ },
        async error => assert.fail(error)
    )

    const first = controller.start()
    const second = controller.start()
    assert.strictEqual(first, second)
    resolveDistribution({ id: 'distribution' })
    await first

    assert.equal(controller.getState(), 'ready')
    assert.equal(initialized, 1)
})

test('retries a failed startup without reloading the process', async () => {
    let attempts = 0
    let failures = 0
    const controller = new StartupController(
        async () => {
            attempts++
            if(attempts === 1) {
                throw new Error('offline')
            }
            return { id: 'distribution' }
        },
        async () => undefined,
        async () => { failures++ }
    )

    await controller.start()
    assert.equal(controller.getState(), 'error')
    await controller.retry()

    assert.equal(controller.getState(), 'ready')
    assert.equal(attempts, 2)
    assert.equal(failures, 1)
})
