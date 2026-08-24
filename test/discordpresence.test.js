const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')

const { DiscordPresenceController } = require('../app/assets/js/discordpresence')

function createWrapper() {
    const calls = []
    return {
        calls,
        initRPC: (...args) => calls.push(['init', ...args]),
        updateDetails: details => calls.push(['update', details]),
        shutdownRPC: () => calls.push(['shutdown'])
    }
}

test('initializes Discord Rich Presence only when enabled and fully configured', () => {
    const generalSettings = { clientId: 'client' }
    const serverSettings = { shortId: 'main' }
    for(const [enabled, general, server] of [
        [false, generalSettings, serverSettings],
        [true, null, serverSettings],
        [true, generalSettings, null]
    ]) {
        const wrapper = createWrapper()
        const controller = new DiscordPresenceController(wrapper)

        assert.equal(controller.initialize(enabled, general, server), false)
        assert.equal(controller.isActive(), false)
        assert.deepEqual(wrapper.calls, [])
    }

    const wrapper = createWrapper()
    const controller = new DiscordPresenceController(wrapper)
    assert.equal(controller.initialize(true, generalSettings, serverSettings), true)
    assert.equal(controller.isActive(), true)
    assert.deepEqual(wrapper.calls, [['init', generalSettings, serverSettings]])
})

test('updates only active presence and shuts it down once', () => {
    const wrapper = createWrapper()
    const controller = new DiscordPresenceController(wrapper)

    controller.updateDetails('before initialization')
    assert.deepEqual(wrapper.calls, [])

    controller.initialize(true, { clientId: 'client' }, { shortId: 'main' })
    controller.updateDetails('playing')
    assert.equal(controller.shutdown(), true)
    assert.equal(controller.shutdown(), false)
    controller.updateDetails('after shutdown')

    assert.deepEqual(wrapper.calls.map(call => call[0]), ['init', 'update', 'shutdown'])
    assert.equal(wrapper.calls[1][1], 'playing')
    assert.equal(controller.isActive(), false)
})

test('cleans up the game process whether presence is active or disabled', () => {
    for(const enabled of [false, true]) {
        const wrapper = createWrapper()
        const controller = new DiscordPresenceController(wrapper)
        const process = new EventEmitter()
        const closeStates = []
        controller.initialize(enabled, { clientId: 'client' }, { shortId: 'main' })
        controller.bindProcess(process, wasActive => closeStates.push(wasActive))

        process.emit('close', 0)
        process.emit('close', 0)

        assert.deepEqual(closeStates, [enabled])
        assert.equal(controller.isActive(), false)
        assert.equal(wrapper.calls.filter(call => call[0] === 'shutdown').length, enabled ? 1 : 0)
    }
})
