const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
    DISTRIBUTION_NOTICE_SUCCESS_MS,
    DistributionNoticeController,
    DistributionRefreshController
} = require('../app/assets/js/distributionrefreshcontroller')

test('keeps the success notice visible for two seconds before hiding it', () => {
    const states = []
    let scheduledCallback
    let scheduledDelay
    const notice = new DistributionNoticeController(
        state => states.push(state),
        {
            schedule: (callback, delay) => {
                scheduledCallback = callback
                scheduledDelay = delay
                return 1
            },
            cancel: () => undefined
        }
    )

    notice.showSuccess()

    assert.deepEqual(states, ['success'])
    assert.equal(scheduledDelay, DISTRIBUTION_NOTICE_SUCCESS_MS)
    scheduledCallback()
    assert.deepEqual(states, ['success', 'hidden'])
})

test('cancels the pending success dismissal when another state is shown', () => {
    const states = []
    let scheduledCallback
    const notice = new DistributionNoticeController(
        state => states.push(state),
        {
            schedule: callback => {
                scheduledCallback = callback
                return 1
            },
            cancel: () => undefined
        }
    )

    notice.showSuccess()
    notice.showUnavailable()
    scheduledCallback()

    assert.deepEqual(states, ['success', 'offline'])
})

test('deduplicates concurrent distribution refresh requests', async () => {
    let refreshCalls = 0
    let applyCalls = 0
    let resolveRefresh
    const refresh = new Promise(resolve => {
        resolveRefresh = resolve
    })
    const controller = new DistributionRefreshController(
        async () => {
            refreshCalls++
            return refresh
        },
        () => 'remote',
        async () => { applyCalls++ }
    )

    const first = controller.refresh()
    const second = controller.refresh()
    resolveRefresh({ id: 'distribution' })

    const [firstResult, secondResult] = await Promise.all([first, second])

    assert.equal(refreshCalls, 1)
    assert.equal(applyCalls, 1)
    assert.strictEqual(firstResult, secondResult)
})

test('keeps the unavailable state when a retry falls back to cached data', async () => {
    const states = []
    const cachedDistribution = { id: 'cached' }
    const controller = new DistributionRefreshController(
        async () => cachedDistribution,
        () => 'cache',
        async () => undefined,
        {
            onUnavailable: () => states.push('unavailable'),
            onRetrying: () => states.push('retrying'),
            onSuccess: () => states.push('success')
        }
    )

    const result = await controller.refresh({ showProgress: true, announceRecovery: true })

    assert.strictEqual(result, cachedDistribution)
    assert.deepEqual(states, ['retrying', 'unavailable'])
})

test('announces a successful retry after the remote distribution recovers', async () => {
    const states = []
    const remoteDistribution = { id: 'remote' }
    const controller = new DistributionRefreshController(
        async () => remoteDistribution,
        () => 'remote',
        async () => undefined,
        {
            onUnavailable: () => states.push('unavailable'),
            onRetrying: () => states.push('retrying'),
            onSuccess: () => states.push('success')
        }
    )

    const result = await controller.refresh({ showProgress: true, announceRecovery: true })

    assert.strictEqual(result, remoteDistribution)
    assert.deepEqual(states, ['retrying', 'success'])
})

test('restores the unavailable state when a refresh throws', async () => {
    const states = []
    const controller = new DistributionRefreshController(
        async () => { throw new Error('offline') },
        () => null,
        async () => undefined,
        {
            onUnavailable: () => states.push('unavailable'),
            onRetrying: () => states.push('retrying')
        }
    )

    await assert.rejects(
        controller.refresh({ showProgress: true, announceRecovery: true }),
        /offline/
    )
    assert.deepEqual(states, ['retrying', 'unavailable'])
})
