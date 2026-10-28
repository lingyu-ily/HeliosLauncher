const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const { LauncherUpdateController, UPDATE_CHECK_INTERVAL_MS } = require('../app/assets/js/launcherupdatecontroller')
const { LauncherUpdateService } = require('../app/assets/js/launcherupdateservice')
const { StartupController } = require('../app/assets/js/startupcontroller')

function fixture(options = {}) {
    const actions = []
    const schedules = []
    const states = []
    const controller = new LauncherUpdateController({
        send: (...args) => actions.push(args),
        onChange: state => states.push(state),
        schedule: (callback, delay) => { schedules.push({ callback, delay }); return schedules.length },
        cancel: id => schedules[id - 1].cancelled = true,
        platform: 'win32',
        ...options
    })
    return { controller, actions, schedules, states }
}

test('initializes once and checks independently of failed distribution startup and retries', async () => {
    const { controller, actions, schedules } = fixture()
    let initialized = false
    const startup = new StartupController(
        async () => { throw new Error('No remote distribution or cache') },
        async () => { initialized = true },
        async () => undefined
    )
    for(let attempt = 0; attempt < 3; attempt++) {
        controller.initialize(false)
        controller.receive('ready')
        await startup.start()
    }
    assert.equal(startup.getState(), 'error')
    assert.equal(initialized, false)
    assert.deepEqual(actions, [['initAutoUpdater', false], ['checkForUpdate']])
    assert.equal(schedules.length, 1)
    assert.equal(schedules[0].delay, UPDATE_CHECK_INTERVAL_MS)
    assert.equal(controller.check(), false)
    controller.receive('update-available', { version: '4.0.0' })
    schedules[0].callback()
    assert.equal(actions.length, 2)
    controller.receive('update-downloaded', { version: '4.0.0' })
    schedules[0].callback()
    assert.equal(controller.state.status, 'downloaded')
    assert.equal(actions.length, 2)
    controller.install()
    controller.install()
    assert.equal(actions.at(-1)[0], 'installUpdateNow')
    assert.equal(actions.length, 3)
    controller.dispose()
    assert.equal(schedules[0].cancelled, true)
})

test('allows retry after feed and download errors and continues periodic checks when current', () => {
    const { controller, actions, schedules } = fixture()
    controller.initialize(true)
    controller.receive('ready')
    controller.receive('realerror', { message: 'network unavailable' })
    assert.equal(controller.state.status, 'error')
    assert.equal(controller.check(), true)
    controller.receive('update-available', { version: '4.0.0' })
    controller.receive('realerror', { code: 'ECONNRESET' })
    assert.equal(controller.check(), true)
    controller.receive('update-not-available')
    assert.equal(controller.state.status, 'current')
    assert.equal(controller.state.info, null)
    schedules[0].callback()
    assert.equal(actions.filter(([action]) => action === 'checkForUpdate').length, 4)
})

test('does not enable updates in development and uses manual downloads on macOS', () => {
    const dev = fixture({ enabled: false })
    dev.controller.initialize(false)
    dev.controller.receive('ready')
    dev.controller.check()
    dev.controller.install()
    assert.deepEqual(dev.actions, [])
    assert.equal(dev.controller.state.status, 'disabled')
    const mac = fixture({ platform: 'darwin' })
    mac.controller.receive('update-available', { version: '4.0.0' })
    assert.equal(mac.controller.state.status, 'available')
    mac.controller.install()
    assert.deepEqual(mac.actions, [])
})

test('preserves the downloaded installer when installation fails', () => {
    const { controller, actions } = fixture()
    controller.receive('update-downloaded', { version: '4.0.0' })
    controller.install()
    controller.receive('realerror', { message: 'Installer launch failed' })
    assert.equal(controller.state.status, 'downloaded')
    assert.equal(controller.state.error.message, 'Installer launch failed')
    controller.install()
    assert.equal(actions.length, 2)
})

test('main process binds events once and suppresses duplicate checks throughout downloading', async () => {
    const updater = new EventEmitter()
    let finishDownload
    let checks = 0
    let installs = 0
    updater.checkForUpdates = async () => {
        checks++
        updater.emit('update-available', { version: '4.0.0' })
        return { downloadPromise: new Promise(resolve => { finishDownload = resolve }) }
    }
    updater.quitAndInstall = () => installs++
    const service = new LauncherUpdateService(updater)
    const notifications = []
    service.initialize((...args) => notifications.push(args))
    service.initialize((...args) => notifications.push(args))
    assert.equal(updater.listenerCount('update-downloaded'), 1)
    assert.equal(updater.listenerCount('error'), 1)
    service.install()
    assert.equal(installs, 0)
    const checking = service.check()
    await service.check()
    assert.equal(checks, 1)
    updater.emit('update-downloaded', { version: '4.0.0' })
    finishDownload()
    await checking
    await service.check()
    assert.equal(checks, 1)
    service.install()
    assert.equal(installs, 1)
    assert.deepEqual(notifications.map(([event]) => event), ['update-available', 'update-downloaded'])
})

test('main process catches feed and download rejections, serializes errors, and permits retry', async () => {
    const updater = new EventEmitter()
    const service = new LauncherUpdateService(updater)
    const notifications = []
    service.initialize((...args) => notifications.push(args))
    updater.checkForUpdates = async () => { throw Object.assign(new Error('Offline'), { code: 'ENOTFOUND' }) }
    await service.check()
    assert.deepEqual(notifications.at(-1), ['realerror', { code: 'ENOTFOUND', message: 'Offline' }])
    updater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(new Error('Download failed')) })
    await service.check()
    assert.equal(notifications.at(-1)[1].message, 'Download failed')
    updater.checkForUpdates = async () => { updater.emit('update-not-available'); return null }
    await service.check()
    assert.equal(notifications.at(-1)[0], 'update-not-available')
    assert.equal(service.busy, false)
})

// Exercise the real renderer functions with a minimal DOM, without launching an installer.
function rendererFixture(platform = 'win32') {
    const elements = new Map()
    const element = id => {
        if(!elements.has(id)) {
            elements.set(id, { textContent: '', innerHTML: '', dataset: {}, style: {}, getElementsByClassName: name => [element(name)] })
        }
        return elements.get(id)
    }
    const ipc = new EventEmitter()
    const actions = []
    ipc.send = (...args) => actions.push(args)
    const downloads = []
    const logs = { info() {}, error() {} }
    const context = vm.createContext({
        require: () => ({ LauncherUpdateController }),
        isDev: false,
        ipcRenderer: ipc,
        process: { platform, arch: 'x64' },
        loggerAutoUpdater: logs,
        Lang: { queryJS: key => key },
        window: { addEventListener() {} },
        document: { getElementById: element },
        shell: { openExternal: url => downloads.push(url) },
        remote: { app: { getVersion: () => '3.0.1' } },
        isPrerelease: () => false,
        populateVersionInformation() {}
    })
    const source = name => readFileSync(join(__dirname, '../app/assets/js/scripts', name), 'utf8')
    const core = source('uicore.js')
    const settings = source('settings.js')
    vm.runInContext(core.slice(core.indexOf('const { LauncherUpdateController }'), core.indexOf('/* jQuery Example')), context)
    const updateSettings = settings.slice(settings.indexOf('const settingsTabUpdate '))
    vm.runInContext(updateSettings.slice(0, updateSettings.indexOf('/**', updateSettings.indexOf('function prepareUpdateTab'))), context)
    // No timers: notifications are driven deterministically by each scenario.
    return { context, ipc, actions, downloads, element, source }
}

test('settings preparation and late startup dialog rendering retain the completed update and install action', () => {
    const { context, ipc, actions, element } = rendererFixture()
    ipc.emit('autoUpdateNotification', {}, 'update-available', { version: '4.0.0', releaseName: 'New', releaseNotes: '' })
    ipc.emit('autoUpdateNotification', {}, 'update-downloaded', { version: '4.0.0', releaseName: 'New', releaseNotes: '' })
    vm.runInContext('prepareUpdateTab(); renderLauncherUpdateState()', context)
    const settings = element('settingsUpdateActionButton')
    const startup = element('startupUpdateButton')
    assert.equal(settings.innerHTML, 'uicore.launcherUpdate.installButton')
    assert.equal(startup.textContent, settings.innerHTML)
    assert.equal(startup.disabled, false)
    startup.onclick()
    assert.equal(actions.at(-1)[1], 'installUpdateNow')
    assert.equal(settings.disabled, true)
})

test('both views expose bounded plain-text errors and restore their retry action', () => {
    const { context, ipc, element } = rendererFixture()
    ipc.emit('autoUpdateNotification', {}, 'realerror', { message: '<b>offline</b>\nsecret detail' })
    assert.equal(element('startupUpdateButton').textContent, 'uicore.launcherUpdate.retryButton')
    assert.equal(element('startupUpdateStatus').textContent, 'uicore.launcherUpdate.error — <b>offline</b>')
    assert.equal(element('startupUpdateButton').disabled, false)
    vm.runInContext('prepareUpdateTab()', context)
    assert.equal(element('settingsUpdateActionButton').innerHTML, 'uicore.launcherUpdate.retryButton')
    ipc.emit('autoUpdateNotification', {}, 'update-not-available')
    assert.equal(element('startupUpdateButton').textContent, 'uicore.launcherUpdate.checkButton')
    assert.equal(element('startupUpdateStatus').textContent, 'uicore.launcherUpdate.current')
})

test('macOS startup error view opens the existing DMG URL instead of requesting installation', () => {
    const { ipc, element, downloads, actions } = rendererFixture('darwin')
    ipc.emit('autoUpdateNotification', {}, 'update-available', { version: '4.0.0' })
    assert.equal(element('startupUpdateButton').textContent, 'uicore.launcherUpdate.downloadButton')
    element('startupUpdateButton').onclick()
    assert.deepEqual(downloads, ['https://github.com/lingyu-ily/MapleCraftLauncher/releases/download/v4.0.0/MapleCraft-Launcher-setup-4.0.0-x64.dmg'])
    assert.deepEqual(actions, [])
})

test('DOM-ready startup initializes the updater before requesting distribution', () => {
    const { context, source } = rendererFixture()
    const calls = []
    context.ConfigManager = { getAllowPrerelease: () => false }
    context.bindDistributionNotice = () => {}
    let startupState = 'idle'
    context.startupController = {
        getState: () => startupState,
        start: () => { calls.push('distribution'); startupState = 'error' }
    }
    context.document.readyState = 'interactive'
    vm.runInContext('launcherUpdateController.send = action => recordAction(action)', Object.assign(context, { recordAction: action => calls.push(action) }))
    const binder = source('uibinder.js')
    vm.runInContext(binder.slice(binder.indexOf('function startLauncherWhenReady()'), binder.indexOf('document.addEventListener(\'readystatechange\', startLauncherWhenReady')), context)
    vm.runInContext('startLauncherWhenReady(); startLauncherWhenReady()', context)
    assert.deepEqual(calls, ['initAutoUpdater', 'distribution'])
})

test('the startup dialog preserves update state and retries distribution without initializing updates again', () => {
    const { context, source, ipc, element, actions } = rendererFixture()
    const overlays = []
    let retries = 0
    context.setTimeout = callback => callback()
    const jquery = { fadeOut: (_delay, callback) => callback(), removeClass() {}, stop() { return this }, show() {}, addClass() {} }
    context.$ = () => jquery
    context.toggleOverlay = (...args) => overlays.push(args)
    context.startupController = { retry: () => retries++ }
    ipc.emit('autoUpdateNotification', {}, 'update-downloaded', { version: '4.0.0' })
    const binder = source('uibinder.js')
    vm.runInContext(binder.slice(binder.indexOf('function showFatalStartupError()'), binder.indexOf('async function loadStartupDistribution()')), context)
    vm.runInContext('showFatalStartupError()', context)
    assert.deepEqual(overlays.at(-1), [true, true, 'startupErrorContent'])
    assert.equal(element('startupUpdateButton').textContent, 'uicore.launcherUpdate.installButton')
    element('startupRetryButton').onclick()
    assert.equal(retries, 1)
    assert.equal(element('startupRetryButton').disabled, true)
    assert.deepEqual(overlays.at(-1), [false, true, 'startupErrorContent'])
    vm.runInContext('showFatalStartupError()', context)
    assert.equal(element('startupRetryButton').disabled, false)
    assert.equal(element('startupUpdateButton').textContent, 'uicore.launcherUpdate.installButton')
    assert.deepEqual(actions, [])
})

test('Enter on the focused update button does not also retry distribution; Escape still exits', () => {
    const { context, source, element } = rendererFixture()
    const clicks = []
    element('startupErrorContent').getElementsByClassName = name => [{ click: () => clicks.push(name) }]
    vm.runInContext('let overlayHandlerContent = \'startupErrorContent\'', context)
    const overlay = source('overlay.js')
    const handler = overlay.slice(overlay.indexOf('function overlayKeyDismissableHandler'))
    vm.runInContext(handler.slice(0, handler.indexOf('/**')), context)
    vm.runInContext('overlayKeyDismissableHandler({ key: \'Enter\', target: { tagName: \'BUTTON\' } })', context)
    assert.deepEqual(clicks, [])
    vm.runInContext('overlayKeyDismissableHandler({ key: \'Escape\' })', context)
    assert.deepEqual(clicks, ['overlayKeybindEsc'])
})
