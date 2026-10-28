/**
 * Core UI functions are initialized in this file. This prevents
 * unexpected errors from breaking the core features. Specifically,
 * actions in this file should not require the usage of any internal
 * modules, excluding dependencies.
 */
// Requirements
const $                              = require('jquery')
const {ipcRenderer, shell, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')
const loggerAutoUpdater        = LoggerUtil.getLogger('AutoUpdater')

// Log deprecation and process warnings.
process.traceProcessWarnings = true
process.traceDeprecation = true

// Disable eval function.
window.eval = global.eval = function () {
    throw new Error('Sorry, this app does not support window.eval().')
}

// Display warning when devtools window is opened.
remote.getCurrentWebContents().on('devtools-opened', () => {
    console.log('%cThe console is dark and full of terrors.', 'color: white; -webkit-text-stroke: 4px #a02d2a; font-size: 60px; font-weight: bold')
    console.log('%cIf you\'ve been told to paste something here, you\'re being scammed.', 'font-size: 16px')
    console.log('%cUnless you know exactly what you\'re doing, close this window.', 'font-size: 16px')
})

// Disable zoom, needed for darwin.
webFrame.setZoomLevel(0)
webFrame.setVisualZoomLevelLimits(1, 1)

const { LauncherUpdateController } = require('./assets/js/launcherupdatecontroller')
const launcherUpdateController = new LauncherUpdateController({
    enabled: !isDev,
    platform: process.platform,
    send: (action, data) => ipcRenderer.send('autoUpdateAction', action, data),
    onChange: () => renderLauncherUpdateState()
})

if(!isDev){
    ipcRenderer.on('autoUpdateNotification', (_event, type, info) => {
        loggerAutoUpdater.info(type, info?.version || '')
        if(type === 'realerror'){
            loggerAutoUpdater.error('Launcher update failed.', info)
        }
        if(type === 'update-available' && process.platform === 'darwin'){
            info.darwindownload = `https://github.com/lingyu-ily/MapleCraftLauncher/releases/download/v${info.version}/MapleCraft-Launcher-setup-${info.version}${process.arch === 'arm64' ? '-arm64' : '-x64'}.dmg`
        }
        launcherUpdateController.receive(type, info)
    })
}
window.addEventListener('beforeunload', () => launcherUpdateController.dispose())

function getLauncherUpdatePresentation(){
    const { status, info, error } = launcherUpdateController.state
    const label = key => Lang.queryJS(`uicore.launcherUpdate.${key}`)
    let button = label('checkButton')
    let action = () => launcherUpdateController.check()
    const disabled = ['disabled', 'checking', 'downloading', 'installing'].includes(status)
    if(status === 'checking' || status === 'downloading' || status === 'installing'){
        button = label(status)
    } else if(status === 'downloaded'){
        button = label('installButton')
        action = () => launcherUpdateController.install()
    } else if(status === 'available'){
        button = label('downloadButton')
        action = () => shell.openExternal(info.darwindownload)
    } else if(status === 'error'){
        button = label('retryButton')
    }
    let message = label(status)
    if(info?.version != null){
        message += ` (${info.version})`
    }
    if(error != null){
        // The detailed error stays in logs. Display a bounded, plain-text reason.
        const reason = String(error.code || error.message || label('unknownError')).split(/[\r\n]/)[0].slice(0, 180)
        message += ` — ${reason}`
    }
    return { message, button, disabled, action }
}

function renderLauncherUpdateState(){
    const state = launcherUpdateController.state
    const presentation = getLauncherUpdatePresentation()
    if(state.info != null){
        showUpdateUI(state.info)
    } else {
        hideUpdateUI()
    }
    if(document.getElementById('settingsUpdateActionButton') != null){
        populateSettingsUpdateInformation(state.info)
        settingsUpdateButtonStatus(presentation.button, presentation.disabled, presentation.action)
        document.getElementById('settingsUpdateTitle').textContent = presentation.message
    }
    const status = document.getElementById('startupUpdateStatus')
    const button = document.getElementById('startupUpdateButton')
    if(status != null && button != null){
        status.textContent = presentation.message
        button.textContent = presentation.button
        button.disabled = presentation.disabled
        button.onclick = presentation.action
    }
}

/**
 * Send a notification to the main process changing the value of
 * allowPrerelease. If we are running a prerelease version, then
 * this will always be set to true, regardless of the current value
 * of val.
 * 
 * @param {boolean} val The new allow prerelease value.
 */
function changeAllowPrerelease(val){
    ipcRenderer.send('autoUpdateAction', 'allowPrereleaseChange', val)
}

function showUpdateUI(info){
    const updateElement = document.getElementById('sidebarUpdateButton')
    if(updateElement == null){
        return
    }

    updateElement.hidden = false
    updateElement.dataset.version = info.version
    updateElement.onclick = async () => {
        if(getCurrentView() === VIEWS.settings){
            settingsNavItemListener(document.getElementById('settingsNavUpdate'))
            return
        }
        await openLauncherSettings('settingsNavUpdate')
    }
}

function hideUpdateUI(){
    const updateElement = document.getElementById('sidebarUpdateButton')
    if(updateElement != null){
        updateElement.hidden = true
        delete updateElement.dataset.version
        updateElement.onclick = null
    }
}

/* jQuery Example
$(function(){
    loggerUICore.info('UICore Initialized');
})*/

document.addEventListener('readystatechange', function () {
    if (document.readyState === 'interactive'){
        loggerUICore.info('UICore Initializing..')

        // Remove focus from social media buttons once they're clicked.
        Array.from(document.getElementsByClassName('mediaURL')).map(val => {
            val.addEventListener('click', e => {
                document.activeElement.blur()
            })
        })

    }

}, false)

/**
 * Open web links in the user's default browser.
 */
$(document).on('click', 'a[href^="http"]', function(event) {
    event.preventDefault()
    shell.openExternal(this.href)
})

/**
 * Opens DevTools window if you hold (ctrl + shift + i).
 * This will crash the program if you are using multiple
 * DevTools, for example the chrome debugger in VS Code. 
 */
document.addEventListener('keydown', function (e) {
    if((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey){
        let window = remote.getCurrentWindow()
        window.toggleDevTools()
    }
})
