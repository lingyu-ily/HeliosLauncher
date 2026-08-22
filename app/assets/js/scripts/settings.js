// Requirements
const semver = require('semver')

const { MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR } = require('./assets/js/ipcconstants')
const settingsLogger = LoggerUtil.getLogger('Settings')

const settingsState = {
    invalid: new Set()
}

function bindSettingsSelect(){
    for(let ele of document.getElementsByClassName('settingsSelectContainer')) {
        const selectedDiv = ele.getElementsByClassName('settingsSelectSelected')[0]

        selectedDiv.onclick = (e) => {
            e.stopPropagation()
            closeSettingsSelect(e.target)
            e.target.nextElementSibling.toggleAttribute('hidden')
            e.target.classList.toggle('select-arrow-active')
        }
    }
}

function closeSettingsSelect(el){
    for(let ele of document.getElementsByClassName('settingsSelectContainer')) {
        const selectedDiv = ele.getElementsByClassName('settingsSelectSelected')[0]
        const optionsDiv = ele.getElementsByClassName('settingsSelectOptions')[0]

        if(!(selectedDiv === el)) {
            selectedDiv.classList.remove('select-arrow-active')
            optionsDiv.setAttribute('hidden', '')
        }
    }
}

/* If the user clicks anywhere outside the select box,
then close all select boxes: */
document.addEventListener('click', closeSettingsSelect)

bindSettingsSelect()


function bindFileSelectors(){
    for(let ele of document.getElementsByClassName('settingsFileSelButton')){
        
        ele.onclick = async e => {
            const directoryDialog = ele.hasAttribute('dialogDirectory') && ele.getAttribute('dialogDirectory') == 'true'
            const properties = directoryDialog ? ['openDirectory', 'createDirectory'] : ['openFile']

            const options = {
                properties
            }

            if(ele.hasAttribute('dialogTitle')) {
                options.title = ele.getAttribute('dialogTitle')
            }

            const res = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), options)
            if(!res.canceled) {
                ele.previousElementSibling.value = res.filePaths[0]
            }
        }
    }
}

bindFileSelectors()


/**
 * General Settings Functions
 */

/**
  * Bind value validators to the settings UI elements. These will
  * validate against the criteria defined in the ConfigManager (if
  * any). If the value is invalid, the UI will reflect this and saving
  * will be disabled until the value is corrected. This is an automated
  * process. More complex UI may need to be bound separately.
  */
function initSettingsValidators(){
    const sEls = document.getElementById('settingsContainer').querySelectorAll('[cValue]')
    Array.from(sEls).map((v, index, arr) => {
        const vFn = ConfigManager['validate' + v.getAttribute('cValue')]
        if(typeof vFn === 'function'){
            if(v.tagName === 'INPUT'){
                if(v.type === 'number' || v.type === 'text'){
                    v.addEventListener('keyup', (e) => {
                        const v = e.target
                        if(!vFn(v.value)){
                            settingsState.invalid.add(v.id)
                            v.setAttribute('error', '')
                            settingsSaveDisabled(true)
                        } else {
                            if(v.hasAttribute('error')){
                                v.removeAttribute('error')
                                settingsState.invalid.delete(v.id)
                                if(settingsState.invalid.size === 0){
                                    settingsSaveDisabled(false)
                                }
                            }
                        }
                    })
                }
            }
        }

    })
}

/**
 * Load configuration values onto the UI. This is an automated process.
 */
async function initSettingsValues(){
    const sEls = document.getElementById('settingsContainer').querySelectorAll('[cValue]')

    for(const v of sEls) {
        const cVal = v.getAttribute('cValue')
        const serverDependent = v.hasAttribute('serverDependent') // Means the first argument is the server id.
        const gFn = ConfigManager['get' + cVal]
        const gFnOpts = []
        if(serverDependent) {
            gFnOpts.push(ConfigManager.getSelectedServer())
        }
        if(typeof gFn === 'function'){
            if(v.tagName === 'INPUT'){
                if(v.type === 'number' || v.type === 'text'){
                    // Special Conditions
                    if(cVal === 'DataDirectory'){
                        v.value = gFn.apply(null, gFnOpts)
                    } else {
                        v.value = gFn.apply(null, gFnOpts)
                    }
                } else if(v.type === 'checkbox'){
                    v.checked = gFn.apply(null, gFnOpts)
                }
            } else if(v.tagName === 'DIV'){
                if(v.classList.contains('rangeSlider')){
                    v.setAttribute('value', Number.parseFloat(gFn.apply(null, gFnOpts)))
                }
            }
        }
    }

}

/**
 * Save the settings values.
 */
function saveSettingsValues(){
    const sEls = document.getElementById('settingsContainer').querySelectorAll('[cValue]')
    Array.from(sEls).map((v, index, arr) => {
        const cVal = v.getAttribute('cValue')
        const serverDependent = v.hasAttribute('serverDependent') // Means the first argument is the server id.
        const sFn = ConfigManager['set' + cVal]
        const sFnOpts = []
        if(serverDependent) {
            sFnOpts.push(ConfigManager.getSelectedServer())
        }
        if(typeof sFn === 'function'){
            if(v.tagName === 'INPUT'){
                if(v.type === 'number' || v.type === 'text'){
                    sFnOpts.push(v.value)
                    sFn.apply(null, sFnOpts)
                } else if(v.type === 'checkbox'){
                    sFnOpts.push(v.checked)
                    sFn.apply(null, sFnOpts)
                    // Special Conditions
                    if(cVal === 'AllowPrerelease'){
                        changeAllowPrerelease(v.checked)
                    }
                }
            } else if(v.tagName === 'DIV'){
                if(v.classList.contains('rangeSlider')){
                    sFnOpts.push(v.getAttribute('value'))
                    sFn.apply(null, sFnOpts)
                }
            }
        }
    })
}

let selectedSettingsTab = 'settingsTabAccount'

/**
 * Modify the settings container UI when the scroll threshold reaches
 * a certain poin.
 * 
 * @param {UIEvent} e The scroll event.
 */
function settingsTabScrollListener(e){
    if(e.target.scrollTop > 0){
        document.getElementById('settingsContainer').setAttribute('scrolled', '')
    } else {
        document.getElementById('settingsContainer').removeAttribute('scrolled')
    }
}

/**
 * Bind functionality for the settings navigation items.
 */
function setupSettingsTabs(){
    const navItems = Array.from(document.getElementsByClassName('settingsNavItem'))
    const tabList = document.getElementById('settingsNavItemsContent')
    const settingsTabs = Array.from(document.getElementsByClassName('settingsTab'))

    for(const tab of settingsTabs){
        const selected = tab.id === selectedSettingsTab
        tab.hidden = !selected
        tab.setAttribute('aria-hidden', (!selected).toString())
    }

    navItems.forEach((val) => {
        if(val.hasAttribute('rSc')){
            val.onclick = () => {
                settingsNavItemListener(val)
            }
        }
    })

    tabList.addEventListener('keydown', (e) => {
        if(!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)){
            return
        }

        e.preventDefault()
        const currentIndex = Math.max(0, navItems.indexOf(document.activeElement))
        let nextIndex
        if(e.key === 'Home'){
            nextIndex = 0
        } else if(e.key === 'End'){
            nextIndex = navItems.length - 1
        } else {
            const offset = e.key === 'ArrowRight' ? 1 : -1
            nextIndex = (currentIndex + offset + navItems.length) % navItems.length
        }

        navItems[nextIndex].focus()
        settingsNavItemListener(navItems[nextIndex])
    })

    tabList.addEventListener('wheel', (e) => {
        if(tabList.scrollWidth <= tabList.clientWidth){
            return
        }
        e.preventDefault()
        tabList.scrollLeft += e.deltaX || e.deltaY
    }, { passive: false })

    document.getElementById(selectedSettingsTab).onscroll = settingsTabScrollListener
}

/**
 * Settings nav item onclick lisener. Function is exposed so that
 * other UI elements can quickly toggle to a certain tab from other views.
 * 
 * @param {Element} ele The nav item which has been clicked.
 * @param {boolean} fade Optional. True to fade transition.
 */
function settingsNavItemListener(ele, fade = true){
    if(ele.hasAttribute('selected')){
        const selectedTab = document.getElementById(ele.getAttribute('rSc'))
        selectedTab.hidden = false
        selectedTab.setAttribute('aria-hidden', 'false')
        ele.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        return
    }
    const navItems = document.getElementsByClassName('settingsNavItem')
    for(let i=0; i<navItems.length; i++){
        navItems[i].removeAttribute('selected')
        navItems[i].setAttribute('aria-selected', 'false')
        navItems[i].tabIndex = -1
    }
    ele.setAttribute('selected', '')
    ele.setAttribute('aria-selected', 'true')
    ele.tabIndex = 0
    ele.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const prevTab = selectedSettingsTab
    selectedSettingsTab = ele.getAttribute('rSc')

    const previousElement = document.getElementById(prevTab)
    const selectedElement = document.getElementById(selectedSettingsTab)
    previousElement.onscroll = null
    previousElement.hidden = true
    previousElement.setAttribute('aria-hidden', 'true')
    previousElement.removeAttribute('launcher-entering')
    selectedElement.hidden = false
    selectedElement.setAttribute('aria-hidden', 'false')
    selectedElement.onscroll = settingsTabScrollListener
    settingsTabScrollListener({ target: selectedElement })
    playLauncherSectionEnter(selectedElement, fade)
}

/**
 * Mark whether invalid values currently block leaving Settings.
 * 
 * @param {boolean} v True to disable, false to enable.
 */
function settingsSaveDisabled(v){
    document.getElementById('settingsContainer').toggleAttribute('save-disabled', v)
}

function fullSettingsSave() {
    saveSettingsValues()
    ConfigManager.save()
}

function showSettingsSaveError(title, message, focusTarget = null){
    setOverlayContent(title, message, Lang.queryJS('settings.save.okButton'))
    setOverlayHandler(() => {
        toggleOverlay(false)
        focusTarget?.focus()
    })
    toggleOverlay(true)
}

/**
 * Save settings before navigating away from this view.
 *
 * @param {boolean} showError Whether an overlay should explain a blocked save.
 * @returns {boolean} True when navigation may continue.
 */
function saveSettingsBeforeExit(showError = true){
    if(settingsState.invalid.size > 0){
        const invalidElement = document.querySelector('#settingsContainer [error]')
        const invalidTab = invalidElement?.closest('.settingsTab')
        const invalidNav = invalidTab == null
            ? null
            : document.querySelector(`.settingsNavItem[rSc="${invalidTab.id}"]`)
        if(invalidNav != null){
            settingsNavItemListener(invalidNav, false)
        }
        if(showError){
            showSettingsSaveError(
                Lang.queryJS('settings.save.invalidTitle'),
                Lang.queryJS('settings.save.invalidMessage'),
                invalidElement
            )
        }
        return false
    }

    try {
        fullSettingsSave()
        return true
    } catch(err) {
        settingsLogger.error('Failed to save settings before leaving the view.', err)
        if(showError){
            showSettingsSaveError(
                Lang.queryJS('settings.save.failedTitle'),
                Lang.queryJS('settings.save.failedMessage')
            )
        }
        return false
    }
}

window.addEventListener('beforeunload', (e) => {
    if(getCurrentView() === VIEWS.settings && !saveSettingsBeforeExit(false)){
        e.preventDefault()
        e.returnValue = false
    }
})

/**
 * Account Management Tab
 */

const msftLoginLogger = LoggerUtil.getLogger('Microsoft Login')
const msftLogoutLogger = LoggerUtil.getLogger('Microsoft Logout')

// Bind the add mojang account button.
document.getElementById('settingsAddMojangAccount').onclick = (e) => {
    switchView(getCurrentView(), VIEWS.login, 500, 500, () => {
        loginViewOnCancel = VIEWS.settings
        loginViewOnSuccess = VIEWS.settings
        loginCancelEnabled(true)
    })
}

// Bind the add microsoft account button.
document.getElementById('settingsAddMicrosoftAccount').onclick = (e) => {
    switchView(getCurrentView(), VIEWS.waiting, 500, 500, () => {
        ipcRenderer.send(MSFT_OPCODE.OPEN_LOGIN, VIEWS.settings, VIEWS.settings)
    })
}

// Bind reply for Microsoft Login.
ipcRenderer.on(MSFT_OPCODE.REPLY_LOGIN, (_, ...arguments_) => {
    if (arguments_[0] === MSFT_REPLY_TYPE.ERROR) {

        const viewOnClose = arguments_[2]
        console.log(arguments_)
        switchView(getCurrentView(), viewOnClose, 500, 500, () => {

            if(arguments_[1] === MSFT_ERROR.NOT_FINISHED) {
                // User cancelled.
                msftLoginLogger.info('Login cancelled by user.')
                return
            }

            // Unexpected error.
            setOverlayContent(
                Lang.queryJS('settings.msftLogin.errorTitle'),
                Lang.queryJS('settings.msftLogin.errorMessage'),
                Lang.queryJS('settings.msftLogin.okButton')
            )
            setOverlayHandler(() => {
                toggleOverlay(false)
            })
            toggleOverlay(true)
        })
    } else if(arguments_[0] === MSFT_REPLY_TYPE.SUCCESS) {
        const queryMap = arguments_[1]
        const viewOnClose = arguments_[2]

        // Error from request to Microsoft.
        if (Object.prototype.hasOwnProperty.call(queryMap, 'error')) {
            switchView(getCurrentView(), viewOnClose, 500, 500, () => {
                // TODO Dont know what these errors are. Just show them I guess.
                // This is probably if you messed up the app registration with Azure.      
                let error = queryMap.error // Error might be 'access_denied' ?
                let errorDesc = queryMap.error_description
                console.log('Error getting authCode, is Azure application registered correctly?')
                console.log(error)
                console.log(errorDesc)
                console.log('Full query map: ', queryMap)
                setOverlayContent(
                    error,
                    errorDesc,
                    Lang.queryJS('settings.msftLogin.okButton')
                )
                setOverlayHandler(() => {
                    toggleOverlay(false)
                })
                toggleOverlay(true)

            })
        } else {

            msftLoginLogger.info('Acquired authCode, proceeding with authentication.')

            const authCode = queryMap.code
            AuthManager.addMicrosoftAccount(authCode).then(value => {
                updateSelectedAccount(value)
                switchView(getCurrentView(), viewOnClose, 500, 500, async () => {
                    await prepareSettings()
                })
            })
                .catch((displayableError) => {

                    let actualDisplayableError
                    if(isDisplayableError(displayableError)) {
                        msftLoginLogger.error('Error while logging in.', displayableError)
                        actualDisplayableError = displayableError
                    } else {
                        // Uh oh.
                        msftLoginLogger.error('Unhandled error during login.', displayableError)
                        actualDisplayableError = Lang.queryJS('login.error.unknown')
                    }

                    switchView(getCurrentView(), viewOnClose, 500, 500, () => {
                        setOverlayContent(actualDisplayableError.title, actualDisplayableError.desc, Lang.queryJS('login.tryAgain'))
                        setOverlayHandler(() => {
                            toggleOverlay(false)
                        })
                        toggleOverlay(true)
                    })
                })
        }
    }
})

/**
 * Bind functionality for the account selection buttons. If another account
 * is selected, the UI of the previously selected account will be updated.
 */
function bindAuthAccountSelect(){
    Array.from(document.getElementsByClassName('settingsAuthAccountSelect')).map((val) => {
        val.onclick = (e) => {
            if(val.hasAttribute('selected')){
                return
            }
            const selectBtns = document.getElementsByClassName('settingsAuthAccountSelect')
            for(let i=0; i<selectBtns.length; i++){
                if(selectBtns[i].hasAttribute('selected')){
                    selectBtns[i].removeAttribute('selected')
                    selectBtns[i].textContent = Lang.queryJS('settings.authAccountSelect.selectButton')
                }
            }
            val.setAttribute('selected', '')
            val.textContent = Lang.queryJS('settings.authAccountSelect.selectedButton')
            setSelectedAccount(val.closest('.settingsAuthAccount').getAttribute('uuid'))
        }
    })
}

/**
 * Bind functionality for the log out button. If the logged out account was
 * the selected account, another account will be selected and the UI will
 * be updated accordingly.
 */
function bindAuthAccountLogOut(){
    Array.from(document.getElementsByClassName('settingsAuthAccountLogOut')).map((val) => {
        val.onclick = () => {
            requestAuthAccountLogout(val.closest('.settingsAuthAccount').getAttribute('uuid'), VIEWS.settings)
        }
    })
}

let pendingAuthLogout = null

function getAuthLogoutReturnView(view){
    return view === VIEWS.settings ? VIEWS.settings : VIEWS.landing
}

function requestAuthAccountLogout(uuid, returnView = getCurrentView()){
    const targetAccount = ConfigManager.getAuthAccount(uuid)
    if(targetAccount == null){
        return false
    }
    const isLastAccount = Object.keys(ConfigManager.getAuthAccounts()).length === 1
    const normalizedReturnView = getAuthLogoutReturnView(returnView)
    if(typeof closeAccountMenu === 'function'){
        closeAccountMenu(false)
    }
    setOverlayContent(
        Lang.queryJS(`settings.authAccountLogout.${isLastAccount ? 'lastAccountWarningTitle' : 'confirmTitle'}`),
        Lang.queryJS(`settings.authAccountLogout.${isLastAccount ? 'lastAccountWarningMessage' : 'confirmMessage'}`),
        Lang.queryJS('settings.authAccountLogout.confirmButton'),
        Lang.queryJS('settings.authAccountLogout.cancelButton')
    )
    setOverlayHandler(() => {
        toggleOverlay(false)
        beginAuthAccountLogout(uuid, isLastAccount, normalizedReturnView)
    })
    setDismissHandler(() => {
        toggleOverlay(false)
    })
    toggleOverlay(true, true)
    return true
}

function beginAuthAccountLogout(uuid, isLastAccount, returnView){
    const targetAccount = ConfigManager.getAuthAccount(uuid)
    if(targetAccount == null){
        return false
    }
    const operation = {
        uuid,
        isLastAccount,
        returnView,
        type: targetAccount.type
    }
    pendingAuthLogout = operation
    const started = switchView(getCurrentView(), VIEWS.waiting, 500, 500, () => {
        if(operation.type === 'microsoft'){
            ipcRenderer.send(MSFT_OPCODE.OPEN_LOGOUT, uuid, isLastAccount)
        } else {
            void AuthManager.removeMojangAccount(uuid)
                .then(() => completeAuthAccountLogout(operation))
                .catch(err => {
                    settingsLogger.error('Failed to log out of the Mojang account.', err)
                    returnFromAuthAccountLogout(operation, false)
                })
        }
    })
    if(!started){
        pendingAuthLogout = null
    }
    return started
}

function prepareAuthLogoutDestination(returnView){
    return returnView === VIEWS.settings ? prepareSettings() : Promise.resolve()
}

function returnFromAuthAccountLogout(operation, cancelled, microsoft = false){
    pendingAuthLogout = null
    const showFailure = () => {
        if(cancelled){
            return
        }
        setOverlayContent(
            Lang.queryJS(microsoft ? 'settings.msftLogout.errorTitle' : 'settings.authAccountLogout.errorTitle'),
            Lang.queryJS(microsoft ? 'settings.msftLogout.errorMessage' : 'settings.authAccountLogout.errorMessage'),
            Lang.queryJS('settings.msftLogout.okButton')
        )
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    }
    const current = getCurrentView()
    if(current === operation.returnView){
        showFailure()
        return
    }
    switchView(current, operation.returnView, 500, 500, async () => {
        await prepareAuthLogoutDestination(operation.returnView)
        showFailure()
    })
}

function completeAuthAccountLogout(operation){
    pendingAuthLogout = null
    const selectedAccount = ConfigManager.getSelectedAccount()
    updateSelectedAccount(selectedAccount)
    if(selectedAccount != null){
        refreshAuthAccountSelected(selectedAccount.uuid)
    }

    if(operation.isLastAccount || selectedAccount == null){
        loginOptionsCancelEnabled(false)
        loginOptionsViewOnLoginSuccess = operation.returnView
        loginOptionsViewOnLoginCancel = VIEWS.loginOptions
        switchView(getCurrentView(), VIEWS.loginOptions)
        return
    }

    switchView(getCurrentView(), operation.returnView, 500, 500, async () => {
        await prepareAuthLogoutDestination(operation.returnView)
    }, () => {
        void validateSelectedAccount()
    })
}

// Bind reply for Microsoft Logout.
ipcRenderer.on(MSFT_OPCODE.REPLY_LOGOUT, (_, ...arguments_) => {
    const operation = pendingAuthLogout ?? {
        uuid: arguments_[1],
        isLastAccount: Boolean(arguments_[2]),
        returnView: VIEWS.settings,
        type: 'microsoft'
    }
    if (arguments_[0] === MSFT_REPLY_TYPE.ERROR) {
        const cancelled = arguments_.length > 1 && arguments_[1] === MSFT_ERROR.NOT_FINISHED
        if(cancelled){
            msftLogoutLogger.info('Logout cancelled by user.')
        }
        returnFromAuthAccountLogout(operation, cancelled, true)
    } else if(arguments_[0] === MSFT_REPLY_TYPE.SUCCESS) {
        const uuid = arguments_[1]
        msftLogoutLogger.info('Logout Successful. uuid:', uuid)
        AuthManager.removeMicrosoftAccount(uuid)
            .then(() => completeAuthAccountLogout(operation))
            .catch(err => {
                msftLogoutLogger.error('Failed to remove the Microsoft account.', err)
                returnFromAuthAccountLogout(operation, false, true)
            })
    }
})

/**
 * Refreshes the status of the selected account on the auth account
 * elements.
 * 
 * @param {string} uuid The UUID of the new selected account.
 */
function refreshAuthAccountSelected(uuid){
    Array.from(document.getElementsByClassName('settingsAuthAccount')).map((val) => {
        const selBtn = val.getElementsByClassName('settingsAuthAccountSelect')[0]
        if(uuid === val.getAttribute('uuid')){
            selBtn.setAttribute('selected', '')
            selBtn.textContent = Lang.queryJS('settings.authAccountSelect.selectedButton')
        } else {
            if(selBtn.hasAttribute('selected')){
                selBtn.removeAttribute('selected')
            }
            selBtn.textContent = Lang.queryJS('settings.authAccountSelect.selectButton')
        }
    })
}

const settingsCurrentMicrosoftAccounts = document.getElementById('settingsCurrentMicrosoftAccounts')
const settingsCurrentMojangAccounts = document.getElementById('settingsCurrentMojangAccounts')

/**
 * Add auth account elements for each one stored in the authentication database.
 */
function populateAuthAccounts(){
    const authAccounts = ConfigManager.getAuthAccounts()
    const authKeys = Object.keys(authAccounts)
    const selectedUUID = ConfigManager.getSelectedAccount()?.uuid
    const microsoftAccounts = document.createDocumentFragment()
    const mojangAccounts = document.createDocumentFragment()

    authKeys.forEach((val) => {
        const acc = authAccounts[val]
        const account = document.createElement('div')
        account.className = 'settingsAuthAccount'
        account.setAttribute('uuid', acc.uuid)

        const accountLeft = document.createElement('div')
        accountLeft.className = 'settingsAuthAccountLeft'
        const image = document.createElement('img')
        image.className = 'settingsAuthAccountImage'
        image.alt = acc.displayName
        image.src = `https://mc-heads.net/body/${encodeURIComponent(acc.uuid)}/60`
        image.onerror = () => {
            image.onerror = null
            image.src = 'assets/images/SealCircle.png'
        }
        accountLeft.appendChild(image)

        const accountRight = document.createElement('div')
        accountRight.className = 'settingsAuthAccountRight'
        const details = document.createElement('div')
        details.className = 'settingsAuthAccountDetails'
        for(const [title, value] of [
            [Lang.queryJS('settings.authAccountPopulate.username'), acc.displayName],
            [Lang.queryJS('settings.authAccountPopulate.uuid'), acc.uuid]
        ]){
            const pane = document.createElement('div')
            pane.className = 'settingsAuthAccountDetailPane'
            const detailTitle = document.createElement('div')
            detailTitle.className = 'settingsAuthAccountDetailTitle'
            detailTitle.textContent = title
            const detailValue = document.createElement('div')
            detailValue.className = 'settingsAuthAccountDetailValue'
            detailValue.textContent = value
            pane.append(detailTitle, detailValue)
            details.appendChild(pane)
        }

        const actions = document.createElement('div')
        actions.className = 'settingsAuthAccountActions'
        const select = document.createElement('button')
        select.type = 'button'
        select.className = 'settingsAuthAccountSelect mcButtonSecondary mcButtonCompact'
        const selected = selectedUUID === acc.uuid
        select.toggleAttribute('selected', selected)
        select.textContent = Lang.queryJS(`settings.authAccountPopulate.${selected ? 'selectedAccount' : 'selectAccount'}`)
        const logoutWrapper = document.createElement('div')
        logoutWrapper.className = 'settingsAuthAccountWrapper'
        const logout = document.createElement('button')
        logout.type = 'button'
        logout.className = 'settingsAuthAccountLogOut mcButtonDanger mcButtonCompact'
        logout.textContent = Lang.queryJS('settings.authAccountPopulate.logout')
        logoutWrapper.appendChild(logout)
        actions.append(select, logoutWrapper)
        accountRight.append(details, actions)
        account.append(accountLeft, accountRight)

        if(acc.type === 'microsoft'){
            microsoftAccounts.appendChild(account)
        } else {
            mojangAccounts.appendChild(account)
        }

    })

    settingsCurrentMicrosoftAccounts.replaceChildren(microsoftAccounts)
    settingsCurrentMojangAccounts.replaceChildren(mojangAccounts)
}

/**
 * Prepare the accounts tab for display.
 */
function prepareAccountsTab() {
    populateAuthAccounts()
    bindAuthAccountSelect()
    bindAuthAccountLogOut()
}

/**
 * Minecraft Tab
 */

/**
  * Disable decimals, negative signs, and scientific notation.
  */
document.getElementById('settingsGameWidth').addEventListener('keydown', (e) => {
    if(/^[-.eE]$/.test(e.key)){
        e.preventDefault()
    }
})
document.getElementById('settingsGameHeight').addEventListener('keydown', (e) => {
    if(/^[-.eE]$/.test(e.key)){
        e.preventDefault()
    }
})

/**
 * About Tab
 */

const settingsTabAbout             = document.getElementById('settingsTabAbout')
const settingsAboutChangelogTitle  = settingsTabAbout.getElementsByClassName('settingsChangelogTitle')[0]
const settingsAboutChangelogText   = settingsTabAbout.getElementsByClassName('settingsChangelogText')[0]
const settingsAboutChangelogButton = settingsTabAbout.getElementsByClassName('settingsChangelogButton')[0]

// Bind the devtools toggle button.
document.getElementById('settingsAboutDevToolsButton').onclick = (e) => {
    let window = remote.getCurrentWindow()
    window.toggleDevTools()
}

/**
 * Return whether or not the provided version is a prerelease.
 * 
 * @param {string} version The semver version to test.
 * @returns {boolean} True if the version is a prerelease, otherwise false.
 */
function isPrerelease(version){
    const preRelComp = semver.prerelease(version)
    return preRelComp != null && preRelComp.length > 0
}

/**
 * Utility method to display version information on the
 * About and Update settings tabs.
 * 
 * @param {string} version The semver version to display.
 * @param {Element} valueElement The value element.
 * @param {Element} titleElement The title element.
 * @param {Element} checkElement The check mark element.
 */
function populateVersionInformation(version, valueElement, titleElement, checkElement){
    valueElement.innerHTML = version
    if(isPrerelease(version)){
        titleElement.innerHTML = Lang.queryJS('settings.about.preReleaseTitle')
        titleElement.style.color = '#ff886d'
        checkElement.style.background = '#ff886d'
    } else {
        titleElement.innerHTML = Lang.queryJS('settings.about.stableReleaseTitle')
        titleElement.style.color = null
        checkElement.style.background = null
    }
}

/**
 * Retrieve the version information and display it on the UI.
 */
function populateAboutVersionInformation(){
    populateVersionInformation(remote.app.getVersion(), document.getElementById('settingsAboutCurrentVersionValue'), document.getElementById('settingsAboutCurrentVersionTitle'), document.getElementById('settingsAboutCurrentVersionCheck'))
}

/**
 * Fetches the GitHub atom release feed and parses it for the release notes
 * of the current version. This value is displayed on the UI.
 */
function populateReleaseNotes(){
    $.ajax({
        url: 'https://github.com/lingyu-ily/MapleCraftLauncher/releases.atom',
        success: (data) => {
            const version = 'v' + remote.app.getVersion()
            const entries = $(data).find('entry')
            
            for(let i=0; i<entries.length; i++){
                const entry = $(entries[i])
                let id = entry.find('id').text()
                id = id.substring(id.lastIndexOf('/')+1)

                if(id === version){
                    settingsAboutChangelogTitle.innerHTML = entry.find('title').text()
                    settingsAboutChangelogText.innerHTML = entry.find('content').text()
                    settingsAboutChangelogButton.href = entry.find('link').attr('href')
                }
            }

        },
        timeout: 2500
    }).catch(err => {
        settingsAboutChangelogText.innerHTML = Lang.queryJS('settings.about.releaseNotesFailed')
    })
}

/**
 * Prepare account tab for display.
 */
function prepareAboutTab(){
    populateAboutVersionInformation()
    populateReleaseNotes()
}

/**
 * Update Tab
 */

const settingsTabUpdate            = document.getElementById('settingsTabUpdate')
const settingsUpdateTitle          = document.getElementById('settingsUpdateTitle')
const settingsUpdateVersionCheck   = document.getElementById('settingsUpdateVersionCheck')
const settingsUpdateVersionTitle   = document.getElementById('settingsUpdateVersionTitle')
const settingsUpdateVersionValue   = document.getElementById('settingsUpdateVersionValue')
const settingsUpdateChangelogTitle = settingsTabUpdate.getElementsByClassName('settingsChangelogTitle')[0]
const settingsUpdateChangelogText  = settingsTabUpdate.getElementsByClassName('settingsChangelogText')[0]
const settingsUpdateChangelogCont  = settingsTabUpdate.getElementsByClassName('settingsChangelogContainer')[0]
const settingsUpdateActionButton   = document.getElementById('settingsUpdateActionButton')

/**
 * Update the properties of the update action button.
 * 
 * @param {string} text The new button text.
 * @param {boolean} disabled Optional. Disable or enable the button
 * @param {function} handler Optional. New button event handler.
 */
function settingsUpdateButtonStatus(text, disabled = false, handler = null){
    settingsUpdateActionButton.innerHTML = text
    settingsUpdateActionButton.disabled = disabled
    if(handler != null){
        settingsUpdateActionButton.onclick = handler
    }
}

/**
 * Populate the update tab with relevant information.
 * 
 * @param {Object} data The update data.
 */
function populateSettingsUpdateInformation(data){
    if(data != null){
        settingsUpdateTitle.innerHTML = isPrerelease(data.version) ? Lang.queryJS('settings.updates.newPreReleaseTitle') : Lang.queryJS('settings.updates.newReleaseTitle')
        settingsUpdateChangelogCont.style.display = null
        settingsUpdateChangelogTitle.innerHTML = data.releaseName
        settingsUpdateChangelogText.innerHTML = data.releaseNotes
        populateVersionInformation(data.version, settingsUpdateVersionValue, settingsUpdateVersionTitle, settingsUpdateVersionCheck)
        
        if(process.platform === 'darwin'){
            settingsUpdateButtonStatus(Lang.queryJS('settings.updates.downloadButton'), false, () => {
                shell.openExternal(data.darwindownload)
            })
        } else {
            settingsUpdateButtonStatus(Lang.queryJS('settings.updates.downloadingButton'), true)
        }
    } else {
        settingsUpdateTitle.innerHTML = Lang.queryJS('settings.updates.latestVersionTitle')
        settingsUpdateChangelogCont.style.display = 'none'
        populateVersionInformation(remote.app.getVersion(), settingsUpdateVersionValue, settingsUpdateVersionTitle, settingsUpdateVersionCheck)
        settingsUpdateButtonStatus(Lang.queryJS('settings.updates.checkForUpdatesButton'), false, () => {
            if(!isDev){
                ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                settingsUpdateButtonStatus(Lang.queryJS('settings.updates.checkingForUpdatesButton'), true)
            }
        })
    }
}

/**
 * Prepare update tab for display.
 * 
 * @param {Object} data The update data.
 */
function prepareUpdateTab(data = null){
    populateSettingsUpdateInformation(data)
}

/**
 * Settings preparation functions.
 */

/**
  * Prepare the entire settings UI.
  * 
  * @param {boolean} first Whether or not it is the first load.
  */
async function prepareSettings(first = false) {
    if(first){
        setupSettingsTabs()
        initSettingsValidators()
        prepareUpdateTab()
    }
    await initSettingsValues()
    prepareAccountsTab()
    prepareAboutTab()
}

// Prepare the settings UI on startup.
//prepareSettings(true)
