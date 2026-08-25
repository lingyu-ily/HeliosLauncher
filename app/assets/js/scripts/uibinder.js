/**
 * Initialize UI functions which depend on internal modules.
 * Loaded after core UI functions are initialized in uicore.js.
 */
// Requirements
const path          = require('path')
const { Type }      = require('helios-distribution-types')

const AuthManager   = require('./assets/js/authmanager')
const AnonymousUsage = require('./assets/js/anonymoususage')
const ConfigManager = require('./assets/js/configmanager')
const { DistroAPI } = require('./assets/js/distromanager')
const { StartupController } = require('./assets/js/startupcontroller')

// Mapping of each view to their container IDs.
const VIEWS = {
    landing: '#landingContainer',
    loginOptions: '#loginOptionsContainer',
    login: '#loginContainer',
    settings: '#settingsContainer',
    welcome: '#welcomeContainer',
    waiting: '#waitingContainer'
}

const LAUNCHER_SHELL_VIEWS = new Set([VIEWS.landing, VIEWS.settings])
const launcherSectionEnterState = new WeakMap()
let launcherShellNavigationSequence = 0

// The currently shown view container.
let currentView

function isLauncherShellView(view){
    return LAUNCHER_SHELL_VIEWS.has(view)
}

function beginLauncherShellNavigation(){
    return ++launcherShellNavigationSequence
}

function playLauncherSectionEnter(element, animate = true){
    const previous = launcherSectionEnterState.get(element)
    if(previous != null){
        clearTimeout(previous.timer)
        element.removeEventListener('animationend', previous.handler)
        launcherSectionEnterState.delete(element)
    }
    element.removeAttribute('launcher-entering')
    if(!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches){
        return
    }
    void element.offsetWidth
    element.setAttribute('launcher-entering', '')
    const cleanup = () => {
        element.removeAttribute('launcher-entering')
        const active = launcherSectionEnterState.get(element)
        if(active?.handler === handler){
            clearTimeout(active.timer)
            launcherSectionEnterState.delete(element)
        }
        element.removeEventListener('animationend', handler)
    }
    const handler = event => {
        if(event.target === element){
            cleanup()
        }
    }
    const timer = setTimeout(cleanup, 250)
    launcherSectionEnterState.set(element, { handler, timer })
    element.addEventListener('animationend', handler)
}

function getLauncherShellTransitionTarget(view){
    if(view === VIEWS.landing){
        return document.querySelector('#landingWorkspaceScroll .landingSectionView:not([hidden])')
    }
    if(view === VIEWS.settings){
        return document.querySelector('#settingsContainerRight .settingsTab:not([hidden])')
    }
    return document.querySelector(view)
}

function canSwitchView(current, next){
    if(current === VIEWS.landing && next !== VIEWS.landing && typeof getLandingSection === 'function'){
        if(getLandingSection() === 'mods' && typeof commitLandingModsView === 'function' && !commitLandingModsView()){
            return false
        }
        if(getLandingSection() === 'java' && typeof commitLandingJavaView === 'function' && !commitLandingJavaView()){
            return false
        }
    }
    if(current === VIEWS.settings && next !== VIEWS.settings && typeof saveSettingsBeforeExit === 'function' && !saveSettingsBeforeExit()){
        return false
    }
    return true
}

function syncLauncherShell(view){
    const launcherShell = document.getElementById('launcherShell')
    if(launcherShell == null){
        return
    }

    launcherShell.style.display = isLauncherShellView(view) ? 'flex' : 'none'

    const settingsButton = document.getElementById('settingsMediaButton')
    const homeButton = document.getElementById('landingHomeButton')
    const newsButton = document.getElementById('newsButton')
    const settingsSelected = view === VIEWS.settings

    settingsButton?.toggleAttribute('selected', settingsSelected)
    settingsButton?.setAttribute('aria-current', settingsSelected ? 'page' : 'false')
    if(settingsSelected){
        homeButton?.removeAttribute('selected')
        newsButton?.removeAttribute('selected')
        if(typeof updateServerSidebarSelection === 'function'){
            updateServerSidebarSelection(null)
        }
    }
}

/**
 * Switch between the persistent Landing and Settings views. The target is
 * prepared while hidden, then revealed with the shared section animation.
 */
function switchLauncherShellView(next, prepareNext = () => true, onNextShown = () => {}, requestSequence = beginLauncherShellNavigation()){
    const current = getCurrentView()
    if(!isLauncherShellView(current) || !isLauncherShellView(next)){
        return switchView(current, next, 200, 200, prepareNext, onNextShown)
    }
    if(requestSequence !== launcherShellNavigationSequence || !canSwitchView(current, next)){
        return false
    }
    if(current === next){
        return prepareNext() !== false
    }

    if(typeof closeAccountMenu === 'function'){
        closeAccountMenu(false)
    }

    const currentElement = document.querySelector(current)
    const nextElement = document.querySelector(next)
    $(currentElement).stop(true, true).hide()
    $(nextElement).stop(true, true).hide()

    try {
        if(prepareNext() === false || requestSequence !== launcherShellNavigationSequence){
            syncLauncherShell(current)
            $(currentElement).show()
            return false
        }
    } catch(err) {
        loggerUICore.error('Failed to prepare launcher view transition.', err)
        syncLauncherShell(current)
        $(currentElement).show()
        return false
    }

    currentView = next
    syncLauncherShell(next)
    $(nextElement).show()
    playLauncherSectionEnter(getLauncherShellTransitionTarget(next) || nextElement)
    if(typeof syncHeroMediaPlayback === 'function'){
        syncHeroMediaPlayback()
    }
    Promise.resolve(onNextShown()).catch(err => {
        loggerUICore.error('Failed after launcher view transition.', err)
    })
    return true
}

async function openLauncherSettings(settingsNavId = null){
    const requestSequence = beginLauncherShellNavigation()
    try {
        await prepareSettings()
    } catch(err) {
        loggerUICore.error('Failed to prepare Settings.', err)
        return false
    }
    if(requestSequence !== launcherShellNavigationSequence){
        return false
    }
    return switchLauncherShellView(VIEWS.settings, () => {
        if(settingsNavId != null){
            settingsNavItemListener(document.getElementById(settingsNavId), false)
        }
        return true
    }, () => {}, requestSequence)
}

/**
 * Switch launcher views.
 * 
 * @param {string} current The ID of the current view container. 
 * @param {*} next The ID of the next view container.
 * @param {*} currentFadeTime Optional. The fade out time for the current view.
 * @param {*} nextFadeTime Optional. The fade in time for the next view.
 * @param {*} onCurrentFade Optional. Callback function to execute when the current
 * view fades out.
 * @param {*} onNextFade Optional. Callback function to execute when the next view
 * fades in.
 */
function switchView(current, next, currentFadeTime = 500, nextFadeTime = 500, onCurrentFade = () => {}, onNextFade = () => {}){
    if(!canSwitchView(current, next)){
        return false
    }
    if(current !== next && typeof closeAccountMenu === 'function'){
        closeAccountMenu(false)
    }

    currentView = next
    if(typeof syncHeroMediaPlayback === 'function'){
        syncHeroMediaPlayback()
    }
    $(`${current}`).fadeOut(currentFadeTime, async () => {
        await onCurrentFade()
        syncLauncherShell(next)
        $(`${next}`).fadeIn(nextFadeTime, async () => {
            await onNextFade()
        })
    })
    return true
}

/**
 * Get the currently shown view container.
 * 
 * @returns {string} The currently shown view container.
 */
function getCurrentView(){
    return currentView
}

async function showMainUI(data){

    if(!isDev){
        loggerAutoUpdater.info('Initializing..')
        ipcRenderer.send('autoUpdateAction', 'initAutoUpdater', ConfigManager.getAllowPrerelease())
    }

    await prepareSettings(true)
    renderServerSidebar(data)
    updateSelectedServer(data.getServerById(ConfigManager.getSelectedServer()))
    refreshServerStatus()
    setTimeout(() => {
        document.body.style.backgroundImage = `url('assets/images/backgrounds/${document.body.getAttribute('bkid')}.jpg')`
        $('#main').show()

        const isLoggedIn = Object.keys(ConfigManager.getAuthAccounts()).length > 0

        // If this is enabled in a development environment we'll get ratelimited.
        // The relaunch frequency is usually far too high.
        if(!isDev && isLoggedIn){
            validateSelectedAccount()
        }

        if(ConfigManager.isFirstLaunch()){
            currentView = VIEWS.welcome
            $(VIEWS.welcome).fadeIn(1000)
        } else {
            if(isLoggedIn){
                currentView = VIEWS.landing
                syncLauncherShell(VIEWS.landing)
                $(VIEWS.landing).fadeIn(1000)
                if(typeof syncHeroMediaPlayback === 'function'){
                    syncHeroMediaPlayback()
                }
            } else {
                loginOptionsCancelEnabled(false)
                loginOptionsViewOnLoginSuccess = VIEWS.landing
                loginOptionsViewOnLoginCancel = VIEWS.loginOptions
                currentView = VIEWS.loginOptions
                $(VIEWS.loginOptions).fadeIn(1000)
            }
        }

        setTimeout(() => {
            $('#loadingContainer').fadeOut(500, () => {
                $('#loadSpinnerImage').removeClass('rotating')
            })
        }, 250)
        
    }, 750)
}

function showFatalStartupError(){
    setTimeout(() => {
        $('#loadingContainer').fadeOut(250, () => {
            $('#loadSpinnerImage').removeClass('rotating')
            document.getElementById('overlayContainer').style.background = 'none'
            setOverlayContent(
                Lang.queryJS('uibinder.startup.fatalErrorTitle'),
                Lang.queryJS('uibinder.startup.fatalErrorMessage'),
                Lang.queryJS('uibinder.startup.retryButton'),
                Lang.queryJS('uibinder.startup.exitButton')
            )
            setOverlayHandler(() => {
                toggleOverlay(false)
                document.getElementById('overlayContainer').style.background = ''
                $('#loadingContainer').stop(true, true).show()
                $('#loadSpinnerImage').addClass('rotating')
                void startupController.retry()
            })
            setDismissHandler(() => {
                remote.getCurrentWindow().close()
            })
            toggleOverlay(true, true)
        })
    }, 750)
}

async function loadStartupDistribution(){
    loggerUICore.info('Starting distribution initialization.')
    const data = await DistroAPI.getDistribution()
    const mainServer = data.getMainServer()
    if(mainServer == null){
        throw new Error('The distribution index does not contain a server.')
    }

    if(ConfigManager.getSelectedServer() == null || data.getServerById(ConfigManager.getSelectedServer()) == null){
        loggerUICore.info('Determining the default selected server.')
        ConfigManager.setSelectedServer(mainServer.rawServer.id)
        ConfigManager.save()
    }

    loggerUICore.info(`Distribution initialization source: ${DistroAPI.getLastLoadSource() ?? 'memory'}.`)
    return data
}

async function initializeLauncherUI(data){
    syncModConfigurations(data)
    ensureJavaSettings(data)
    await showMainUI(data)
    void AnonymousUsage.reportAnonymousUsage(data)
    loggerUICore.info('Launcher UI initialization complete.')
}

/**
 * Common functions to perform after refreshing the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function onDistroRefresh(data){
    renderServerSidebar(data)
    syncModConfigurations(data)
    updateSelectedServer(data.getServerById(ConfigManager.getSelectedServer()))
    refreshServerStatus()
    ensureJavaSettings(data)
}

/**
 * Sync the mod configurations with the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function syncModConfigurations(data){

    const syncedCfgs = []

    for(let serv of data.servers){

        const id = serv.rawServer.id
        const mdls = serv.modules
        const cfg = ConfigManager.getModConfiguration(id)

        if(cfg != null){

            const modsOld = cfg.mods
            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type

                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        const mdlID = mdl.getVersionlessMavenIdentifier()
                        if(modsOld[mdlID] == null){
                            mods[mdlID] = scanOptionalSubModules(mdl.subModules, mdl)
                        } else {
                            mods[mdlID] = mergeModConfiguration(modsOld[mdlID], scanOptionalSubModules(mdl.subModules, mdl), false)
                        }
                    } else {
                        if(mdl.subModules.length > 0){
                            const mdlID = mdl.getVersionlessMavenIdentifier()
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                if(modsOld[mdlID] == null){
                                    mods[mdlID] = v
                                } else {
                                    mods[mdlID] = mergeModConfiguration(modsOld[mdlID], v, true)
                                }
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        } else {

            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type
                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                    } else {
                        if(mdl.subModules.length > 0){
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                mods[mdl.getVersionlessMavenIdentifier()] = v
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        }
    }

    ConfigManager.setModConfigurations(syncedCfgs)
    ConfigManager.save()
}

/**
 * Ensure java configurations are present for the available servers.
 * 
 * @param {Object} data The distro index object.
 */
function ensureJavaSettings(data) {

    // Nothing too fancy for now.
    for(const serv of data.servers){
        ConfigManager.ensureJavaConfig(serv.rawServer.id, serv.effectiveJavaOptions, serv.rawServer.javaOptions?.ram)
    }

    ConfigManager.save()
}

/**
 * Recursively scan for optional sub modules. If none are found,
 * this function returns a boolean. If optional sub modules do exist,
 * a recursive configuration object is returned.
 * 
 * @returns {boolean | Object} The resolved mod configuration.
 */
function scanOptionalSubModules(mdls, origin){
    if(mdls != null){
        const mods = {}

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            // Optional types.
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                // It is optional.
                if(!mdl.getRequired().value){
                    mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                } else {
                    if(mdl.hasSubModules()){
                        const v = scanOptionalSubModules(mdl.subModules, mdl)
                        if(typeof v === 'object'){
                            mods[mdl.getVersionlessMavenIdentifier()] = v
                        }
                    }
                }
            }
        }

        if(Object.keys(mods).length > 0){
            const ret = {
                mods
            }
            if(!origin.getRequired().value){
                ret.value = origin.getRequired().def
            }
            return ret
        }
    }
    return origin.getRequired().def
}

/**
 * Recursively merge an old configuration into a new configuration.
 * 
 * @param {boolean | Object} o The old configuration value.
 * @param {boolean | Object} n The new configuration value.
 * @param {boolean} nReq If the new value is a required mod.
 * 
 * @returns {boolean | Object} The merged configuration.
 */
function mergeModConfiguration(o, n, nReq = false){
    if(typeof o === 'boolean'){
        if(typeof n === 'boolean') return o
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = o
            }
            return n
        }
    } else if(typeof o === 'object'){
        if(typeof n === 'boolean') return typeof o.value !== 'undefined' ? o.value : true
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = typeof o.value !== 'undefined' ? o.value : true
            }

            const newMods = Object.keys(n.mods)
            for(let i=0; i<newMods.length; i++){

                const mod = newMods[i]
                if(o.mods[mod] != null){
                    n.mods[mod] = mergeModConfiguration(o.mods[mod], n.mods[mod])
                }
            }

            return n
        }
    }
    // If for some reason we haven't been able to merge,
    // wipe the old value and use the new one. Just to be safe
    return n
}

async function validateSelectedAccount(){
    const selectedAcc = ConfigManager.getSelectedAccount()
    if(selectedAcc != null){
        const val = await AuthManager.validateSelected()
        if(!val){
            ConfigManager.removeAuthAccount(selectedAcc.uuid)
            ConfigManager.save()
            const accLen = Object.keys(ConfigManager.getAuthAccounts()).length
            setOverlayContent(
                Lang.queryJS('uibinder.validateAccount.failedMessageTitle'),
                accLen > 0
                    ? Lang.queryJS('uibinder.validateAccount.failedMessage', { 'account': selectedAcc.displayName })
                    : Lang.queryJS('uibinder.validateAccount.failedMessageSelectAnotherAccount', { 'account': selectedAcc.displayName }),
                Lang.queryJS('uibinder.validateAccount.loginButton'),
                Lang.queryJS('uibinder.validateAccount.selectAnotherAccountButton')
            )
            setOverlayHandler(() => {

                const isMicrosoft = selectedAcc.type === 'microsoft'

                if(isMicrosoft) {
                    // Empty for now
                } else {
                    // Mojang
                    // For convenience, pre-populate the username of the account.
                    document.getElementById('loginUsername').value = selectedAcc.username
                    validateEmail(selectedAcc.username)
                }
                
                loginOptionsViewOnLoginSuccess = getCurrentView()
                loginOptionsViewOnLoginCancel = VIEWS.loginOptions

                if(accLen > 0) {
                    loginOptionsViewOnCancel = getCurrentView()
                    loginOptionsViewCancelHandler = () => {
                        if(isMicrosoft) {
                            ConfigManager.addMicrosoftAuthAccount(
                                selectedAcc.uuid,
                                selectedAcc.accessToken,
                                selectedAcc.username,
                                selectedAcc.expiresAt,
                                selectedAcc.microsoft.access_token,
                                selectedAcc.microsoft.refresh_token,
                                selectedAcc.microsoft.expires_at
                            )
                        } else {
                            ConfigManager.addMojangAuthAccount(selectedAcc.uuid, selectedAcc.accessToken, selectedAcc.username, selectedAcc.displayName)
                        }
                        ConfigManager.save()
                        validateSelectedAccount()
                    }
                    loginOptionsCancelEnabled(true)
                } else {
                    loginOptionsCancelEnabled(false)
                }
                toggleOverlay(false)
                switchView(getCurrentView(), VIEWS.loginOptions)
            })
            setDismissHandler(() => {
                if(accLen > 1){
                    prepareAccountSelectionList()
                    $('#overlayContent').fadeOut(250, () => {
                        bindOverlayKeys(true, 'accountSelectContent', true)
                        $('#accountSelectContent').fadeIn(250)
                    })
                } else {
                    const accountsObj = ConfigManager.getAuthAccounts()
                    const accounts = Array.from(Object.keys(accountsObj), v => accountsObj[v])
                    // This function validates the account switch.
                    setSelectedAccount(accounts[0].uuid)
                    toggleOverlay(false)
                }
            })
            toggleOverlay(true, accLen > 0)
        } else {
            return true
        }
    } else {
        return true
    }
}

/**
 * Temporary function to update the selected account along
 * with the relevent UI elements.
 * 
 * @param {string} uuid The UUID of the account.
 */
function setSelectedAccount(uuid){
    const authAcc = ConfigManager.setSelectedAccount(uuid)
    ConfigManager.save()
    updateSelectedAccount(authAcc)
    validateSelectedAccount()
}

const startupController = new StartupController(
    loadStartupDistribution,
    initializeLauncherUI,
    error => {
        loggerUICore.error('Failed to initialize the launcher UI.', error)
        showFatalStartupError()
    }
)

function startLauncherWhenReady(){
    if(document.readyState === 'interactive' || document.readyState === 'complete'){
        void startupController.start()
    }
}

document.addEventListener('readystatechange', startLauncherWhenReady, false)
startLauncherWhenReady()

// Util for development
async function devModeToggle() {
    DistroAPI.toggleDevMode(true)
    const data = await DistroAPI.refreshDistributionOrFallback()
    ensureJavaSettings(data)
    syncModConfigurations(data)
    updateSelectedServer(data.servers[0])
}
