/**
 * Script for landing.ejs
 */
// Requirements
const { clipboard: landingClipboard } = require('electron')
const nodeCrypto                     = require('crypto')
const fsExtra                        = require('fs-extra')
const gotClient                      = require('got')
const nodePath                       = require('path')
const { Transform: StreamTransform } = require('stream')
const { pipeline: streamPipeline }   = require('stream/promises')
const { URL: NodeURL }               = require('url')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')

// Launch Elements
const launch_button           = document.getElementById('launch_button')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')
const launchAccountName       = document.getElementById('launchAccountName')
const launchAccountCopyFeedback = document.getElementById('launchAccountCopyFeedback')
const accountTypeText         = document.getElementById('accountTypeText')
const avatarOverlay           = document.getElementById('avatarOverlay')
const avatarContainer         = document.getElementById('avatarContainer')
const accountMenu             = document.getElementById('accountMenu')
const accountMenuList         = document.getElementById('accountMenuList')
const accountMenuEmpty        = document.getElementById('accountMenuEmpty')
const accountMenuLogout       = document.getElementById('accountMenuLogout')
const accountMenuManage       = document.getElementById('accountMenuManage')
const serverSidebarList       = document.getElementById('serverSidebarList')
const selectedServerIcon      = document.getElementById('selectedServerIcon')
const selectedServerName      = document.getElementById('selectedServerName')
const selectedServerVersion   = document.getElementById('selectedServerVersion')
const launcherGameEyebrow     = document.getElementById('launcherGameEyebrow')
const launcherHero            = document.getElementById('launcherHero')
const launcherHeroVideo       = document.getElementById('launcherHeroVideo')
const launcherHeroYouTube     = document.getElementById('launcherHeroYouTube')
const launcherHeroMediaControls = document.getElementById('launcherHeroMediaControls')
const launcherHeroPlayToggle  = document.getElementById('launcherHeroPlayToggle')
const launcherHeroMuteToggle  = document.getElementById('launcherHeroMuteToggle')
const launcherHeroMediaStatus = document.getElementById('launcherHeroMediaStatus')
const launcherHeroLogo        = document.getElementById('image_seal')
const launcherHeroWordmark    = document.getElementById('launcherHeroWordmark')
const launcherHeroTagline     = document.getElementById('launcherHeroTagline')
const newsPreviewTitle        = document.getElementById('newsPreviewTitle')

const defaultServerPresentation = {
    background: launcherHero.dataset.defaultBackground,
    logo: launcherHeroLogo.getAttribute('src'),
    eyebrow: launcherGameEyebrow.textContent,
    title: launcherHeroWordmark.textContent,
    tagline: launcherHeroTagline.textContent,
    newsTitle: newsPreviewTitle.textContent
}
let heroPresentationSequence = 0
let activeHeroMedia = null
let activeHeroMediaReady = false
let activeHeroMediaDownload = null
let activeHeroMediaPromise = null
let heroMediaMuted = true

const loggerLanding = LoggerUtil.getLogger('Landing')
const launchButtonDefaultText = launch_button.textContent
let launchInProgress = false
let launchServerAvailable = false
let accountCopyFeedbackSequence = 0
let accountCopyFeedbackTimer = null

function clearLaunchAccountCopyFeedback(){
    accountCopyFeedbackSequence++
    clearTimeout(accountCopyFeedbackTimer)
    launchAccountCopyFeedback.removeAttribute('visible')
    launchAccountCopyFeedback.removeAttribute('error')
    launchAccountCopyFeedback.textContent = ''
}

function showLaunchAccountCopyFeedback(message, failed = false){
    const feedbackSequence = ++accountCopyFeedbackSequence
    clearTimeout(accountCopyFeedbackTimer)
    launchAccountCopyFeedback.removeAttribute('visible')
    launchAccountCopyFeedback.toggleAttribute('error', failed)
    launchAccountCopyFeedback.textContent = ''
    requestAnimationFrame(() => {
        if(feedbackSequence !== accountCopyFeedbackSequence){
            return
        }
        launchAccountCopyFeedback.textContent = message
        launchAccountCopyFeedback.setAttribute('visible', '')
        accountCopyFeedbackTimer = setTimeout(() => {
            if(feedbackSequence === accountCopyFeedbackSequence){
                launchAccountCopyFeedback.removeAttribute('visible')
            }
        }, 1500)
    })
}

launchAccountName.onclick = () => {
    const displayName = ConfigManager.getSelectedAccount()?.displayName
    if(typeof displayName !== 'string' || displayName.trim().length === 0){
        return
    }
    try {
        landingClipboard.writeText(displayName)
        showLaunchAccountCopyFeedback(Lang.queryJS('landing.accountCopy.copied'))
    } catch(err) {
        loggerLanding.warn('Failed to copy the player name to the clipboard.', err)
        showLaunchAccountCopyFeedback(Lang.queryJS('landing.accountCopy.failed'), true)
    }
}

/* Launch Progress Wrapper Functions */

function refreshLaunchButtonState(){
    launch_button.disabled = launchInProgress || !launchServerAvailable
    launch_button.toggleAttribute('launching', launchInProgress)
    if(launchInProgress){
        launch_button.textContent = launch_details_text.textContent
        launch_button.title = launch_details_text.textContent
    } else {
        launch_button.textContent = launchButtonDefaultText
        launch_button.removeAttribute('title')
    }
}

/**
 * Show/hide the loading area.
 * 
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    launchInProgress = loading
    launch_details.toggleAttribute('active', loading)
    launch_details.setAttribute('aria-hidden', String(!loading))
    launch_details.setAttribute('aria-busy', String(loading))
    refreshLaunchButtonState()
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.textContent = details
    if(launchInProgress){
        launch_button.textContent = details
        launch_button.title = details
    }
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    const normalizedPercent = Math.min(100, Math.max(0, Number(percent) || 0))
    launch_progress.max = 100
    launch_progress.value = normalizedPercent
    launch_progress_label.textContent = normalizedPercent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    launchServerAvailable = val
    refreshLaunchButtonState()
}

// Bind launch button
launch_button.addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    if(getCurrentView() === VIEWS.settings){
        document.querySelector('.settingsNavItem[selected]')?.focus()
        return
    }
    await openLauncherSettings()
}

const defaultAccountAvatar = 'assets/images/SealCircle.png'
let accountMenuCloseTimer = null
let accountAvatarRequestSequence = 0

function getAccountTypeLabel(authUser){
    return authUser?.type === 'microsoft'
        ? Lang.queryJS('landing.selectedAccount.microsoft')
        : Lang.queryJS('landing.selectedAccount.mojang')
}

function getAccountMenuItems(){
    const accounts = Object.values(ConfigManager.getAuthAccounts())
    const selectedUUID = ConfigManager.getSelectedAccount()?.uuid
    if(selectedUUID == null){
        return accounts
    }
    return [
        ...accounts.filter(account => account.uuid === selectedUUID),
        ...accounts.filter(account => account.uuid !== selectedUUID)
    ]
}

function renderAccountMenu(){
    const accounts = getAccountMenuItems()
    const selectedUUID = ConfigManager.getSelectedAccount()?.uuid
    const fragment = document.createDocumentFragment()

    for(const account of accounts){
        const selected = account.uuid === selectedUUID
        const type = getAccountTypeLabel(account)
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'accountMenuAccount'
        item.setAttribute('role', 'menuitemradio')
        item.setAttribute('aria-checked', selected.toString())
        item.setAttribute('data-account-uuid', account.uuid)
        item.setAttribute('aria-label', selected
            ? `${account.displayName}, ${type}, ${Lang.queryJS('landing.accountMenu.current')}`
            : `${account.displayName}, ${type}`)

        const avatar = document.createElement('img')
        avatar.className = 'accountMenuAvatar'
        avatar.alt = ''
        avatar.src = `https://mc-heads.net/head/${encodeURIComponent(account.uuid)}/40`
        avatar.onerror = () => {
            avatar.onerror = null
            avatar.src = defaultAccountAvatar
        }

        const copy = document.createElement('span')
        copy.className = 'accountMenuCopy'
        const name = document.createElement('span')
        name.className = 'accountMenuName'
        name.textContent = account.displayName
        const accountType = document.createElement('span')
        accountType.className = 'accountMenuType'
        accountType.textContent = type
        copy.append(name, accountType)

        const check = document.createElement('span')
        check.className = 'accountMenuCheck'
        check.setAttribute('aria-hidden', 'true')
        check.textContent = selected ? '✓' : ''
        item.append(avatar, copy, check)
        item.onclick = () => {
            if(account.uuid !== ConfigManager.getSelectedAccount()?.uuid){
                setSelectedAccount(account.uuid)
                if(typeof refreshAuthAccountSelected === 'function'){
                    refreshAuthAccountSelected(account.uuid)
                }
            }
            closeAccountMenu(true)
        }
        fragment.appendChild(item)
    }

    accountMenuList.replaceChildren(fragment)
    accountMenuEmpty.hidden = accounts.length > 0
    accountMenuLogout.hidden = selectedUUID == null
}

function isAccountMenuOpen(){
    return avatarOverlay.getAttribute('aria-expanded') === 'true'
}

function openAccountMenu(focusLast = false){
    clearTimeout(accountMenuCloseTimer)
    renderAccountMenu()
    accountMenu.hidden = false
    accountMenu.setAttribute('aria-hidden', 'false')
    avatarOverlay.setAttribute('aria-expanded', 'true')
    requestAnimationFrame(() => {
        accountMenu.setAttribute('open', '')
        const items = getAccountMenuFocusableItems()
        const selected = accountMenu.querySelector('.accountMenuAccount[aria-checked="true"]')
        const focusTarget = focusLast ? items.at(-1) : selected ?? items[0]
        focusTarget?.focus()
    })
}

function closeAccountMenu(returnFocus = false){
    if(!isAccountMenuOpen()){
        return
    }
    clearTimeout(accountMenuCloseTimer)
    accountMenu.removeAttribute('open')
    accountMenu.setAttribute('aria-hidden', 'true')
    avatarOverlay.setAttribute('aria-expanded', 'false')
    const finish = () => {
        accountMenu.hidden = true
    }
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
        finish()
    } else {
        accountMenuCloseTimer = setTimeout(finish, 180)
    }
    if(returnFocus){
        avatarOverlay.focus()
    }
}

function getAccountMenuFocusableItems(){
    return Array.from(accountMenu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
        .filter(item => !item.hidden && !item.disabled)
}

avatarOverlay.onclick = () => {
    if(isAccountMenuOpen()){
        closeAccountMenu(true)
    } else {
        openAccountMenu()
    }
}

avatarOverlay.addEventListener('keydown', event => {
    if(event.key !== 'ArrowDown' && event.key !== 'ArrowUp'){
        return
    }
    event.preventDefault()
    if(!isAccountMenuOpen()){
        openAccountMenu(event.key === 'ArrowUp')
    }
})

accountMenu.addEventListener('keydown', event => {
    if(event.key === 'Escape'){
        event.preventDefault()
        closeAccountMenu(true)
        return
    }
    if(event.key === 'Tab'){
        closeAccountMenu(false)
        return
    }
    if(!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)){
        return
    }
    const items = getAccountMenuFocusableItems()
    if(items.length === 0){
        return
    }
    event.preventDefault()
    const currentIndex = Math.max(0, items.indexOf(document.activeElement))
    let nextIndex
    if(event.key === 'Home'){
        nextIndex = 0
    } else if(event.key === 'End'){
        nextIndex = items.length - 1
    } else {
        const offset = event.key === 'ArrowDown' ? 1 : -1
        nextIndex = (currentIndex + offset + items.length) % items.length
    }
    items[nextIndex].focus()
})

document.addEventListener('pointerdown', event => {
    if(isAccountMenuOpen() && !document.getElementById('user_content').contains(event.target)){
        closeAccountMenu(false)
    }
})

document.addEventListener('focusin', event => {
    if(isAccountMenuOpen() && !document.getElementById('user_content').contains(event.target)){
        closeAccountMenu(false)
    }
})

window.addEventListener('blur', () => closeAccountMenu(false))

accountMenuLogout.onclick = () => {
    const selectedAccount = ConfigManager.getSelectedAccount()
    if(selectedAccount == null){
        return
    }
    const returnView = getCurrentView()
    closeAccountMenu(false)
    requestAuthAccountLogout(selectedAccount.uuid, returnView)
}

accountMenuManage.onclick = async () => {
    closeAccountMenu(false)
    if(getCurrentView() === VIEWS.settings){
        settingsNavItemListener(document.getElementById('settingsNavAccount'))
        return
    }
    await openLauncherSettings('settingsNavAccount')
}

// Bind selected account
function updateSelectedAccount(authUser){
    const avatarRequestSequence = ++accountAvatarRequestSequence
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    let accountType = Lang.queryJS('landing.selectedAccount.noAccountType')
    clearLaunchAccountCopyFeedback()
    avatarContainer.style.backgroundImage = ''
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        accountType = getAccountTypeLabel(authUser)
        if(authUser.uuid != null){
            const avatarURL = `https://mc-heads.net/head/${encodeURIComponent(authUser.uuid)}/64`
            const avatarImage = new Image()
            avatarImage.onload = () => {
                if(avatarRequestSequence === accountAvatarRequestSequence){
                    avatarContainer.style.backgroundImage = `url('${avatarURL}')`
                }
            }
            avatarImage.onerror = () => {
                if(avatarRequestSequence === accountAvatarRequestSequence){
                    avatarContainer.style.backgroundImage = ''
                }
            }
            avatarImage.src = avatarURL
        }
    }
    user_text.textContent = username
    launchAccountName.textContent = username
    launchAccountName.disabled = typeof authUser?.displayName !== 'string' || authUser.displayName.trim().length === 0
    accountTypeText.textContent = accountType
    renderAccountMenu()
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

document.getElementById('launcherVersionText').textContent = `v${remote.app.getVersion()}`

function setServerSidebarState(message, state = 'loading'){
    serverSidebarList.innerHTML = ''
    const status = document.createElement('div')
    status.className = `serverSidebarState ${state}`
    if(state === 'loading'){
        const spinner = document.createElement('span')
        spinner.className = 'sidebarStateSpinner'
        spinner.setAttribute('aria-hidden', 'true')
        status.appendChild(spinner)
    }
    const label = document.createElement('span')
    label.textContent = message
    status.appendChild(label)
    serverSidebarList.appendChild(status)
}

function updateServerSidebarSelection(serverId){
    for(const item of serverSidebarList.getElementsByClassName('serverSidebarItem')){
        const selected = item.getAttribute('servid') === serverId
        item.toggleAttribute('selected', selected)
        item.setAttribute('aria-selected', selected.toString())
    }
}

function renderServerSidebar(distro){
    if(distro == null || !Array.isArray(distro.servers)){
        setServerSidebarState(Lang.queryJS('landing.serverList.failed'), 'error')
        return
    }
    if(distro.servers.length === 0){
        setServerSidebarState(Lang.queryJS('landing.serverList.empty'), 'empty')
        return
    }

    const selectedId = ConfigManager.getSelectedServer()
    const fragment = document.createDocumentFragment()
    for(const serv of distro.servers){
        const server = serv.rawServer
        const item = document.createElement('button')
        const selected = serverLandingSections.has(getLandingSection()) && server.id === selectedId
        item.type = 'button'
        item.className = 'serverSidebarItem'
        item.setAttribute('role', 'option')
        item.setAttribute('servid', server.id)
        item.setAttribute('aria-selected', selected.toString())
        item.toggleAttribute('selected', selected)

        const icon = document.createElement('img')
        icon.className = 'serverSidebarIcon'
        icon.src = server.icon
        icon.alt = ''

        const copy = document.createElement('span')
        copy.className = 'serverSidebarCopy'
        const name = document.createElement('span')
        name.className = 'serverSidebarName'
        name.textContent = server.name
        const version = document.createElement('span')
        version.className = 'serverSidebarVersion'
        version.textContent = server.minecraftVersion
        copy.append(name, version)
        item.append(icon, copy)
        item.onclick = async () => {
            const requestSequence = beginLauncherShellNavigation()
            if(getCurrentView() === VIEWS.settings){
                let serverChanged = false
                switchLauncherShellView(VIEWS.landing, () => {
                    if(!setLandingSection('play')){
                        return false
                    }
                    if(ConfigManager.getSelectedServer() !== server.id){
                        if(updateSelectedServer(serv) === false){
                            return false
                        }
                        serverChanged = true
                    }
                    return true
                }, async () => {
                    if(serverChanged){
                        await refreshServerStatus(true)
                    }
                }, requestSequence)
                return
            }
            if(ConfigManager.getSelectedServer() === server.id){
                if(getLandingSection() === 'home' || getLandingSection() === 'globalUpdates'){
                    setLandingSection('play')
                }
                item.focus()
                return
            }
            if(!setLandingSection('play')){
                return
            }
            if(updateSelectedServer(serv) === false){
                return
            }
            await refreshServerStatus(true)
        }
        fragment.appendChild(item)
    }
    serverSidebarList.replaceChildren(fragment)
}

serverSidebarList.addEventListener('keydown', (e) => {
    if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown'){
        return
    }
    const items = Array.from(serverSidebarList.getElementsByClassName('serverSidebarItem'))
    if(items.length === 0){
        return
    }
    e.preventDefault()
    const currentIndex = items.indexOf(document.activeElement)
    const offset = e.key === 'ArrowDown' ? 1 : -1
    const nextIndex = currentIndex < 0
        ? 0
        : Math.min(items.length - 1, Math.max(0, currentIndex + offset))
    items[nextIndex].focus()
})

// Bind selected server
function preloadHeroAsset(source, fallback){
    const candidate = typeof source === 'string' && source.trim().length > 0 ? source.trim() : fallback
    return new Promise(resolve => {
        const image = new Image()
        let settled = false
        const finish = value => {
            if(settled){
                return
            }
            settled = true
            clearTimeout(timeout)
            resolve(value)
        }
        const timeout = setTimeout(() => finish(fallback), 5000)
        image.onload = () => finish(candidate)
        image.onerror = () => {
            if(candidate === fallback){
                finish(fallback)
                return
            }
            const fallbackImage = new Image()
            fallbackImage.onload = () => finish(fallback)
            fallbackImage.onerror = () => finish(fallback)
            fallbackImage.src = fallback
        }
        image.src = candidate
    })
}

function normalizeHeroVideoDescriptor(value){
    if(value == null || typeof value !== 'object'){
        return null
    }
    if(value.type === 'youtube' && typeof value.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value.videoId)){
        return { type: 'youtube', videoId: value.videoId }
    }
    if(value.type !== 'file' || typeof value.url !== 'string'){
        return null
    }
    let parsedUrl
    try {
        parsedUrl = new NodeURL(value.url)
        if(parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:'){
            return null
        }
    } catch {
        return null
    }
    const contentType = value.contentType === 'video/webm' || parsedUrl.pathname.toLowerCase().endsWith('.webm')
        ? 'video/webm'
        : 'video/mp4'
    return {
        type: 'file',
        url: value.url,
        contentType,
        sha256: typeof value.sha256 === 'string' && /^[a-f\d]{64}$/i.test(value.sha256) ? value.sha256.toLowerCase() : null,
        size: Number.isSafeInteger(value.size) && value.size > 0 ? value.size : null
    }
}

function setHeroMediaStatus(message = ''){
    launcherHeroMediaStatus.textContent = message
}

function updateHeroMediaControls(){
    const configured = activeHeroMedia != null
    const playRequested = ConfigManager.getPlayHeroVideos()
    launcherHeroMediaControls.hidden = !configured
    launcherHeroPlayToggle.textContent = playRequested ? 'Ⅱ' : '▶'
    launcherHeroPlayToggle.setAttribute('aria-pressed', playRequested.toString())
    launcherHeroPlayToggle.setAttribute('aria-label', Lang.queryJS(`landing.heroVideo.${playRequested ? 'pause' : 'play'}`))
    launcherHeroMuteToggle.textContent = heroMediaMuted ? '🔇' : '🔊'
    launcherHeroMuteToggle.setAttribute('aria-pressed', heroMediaMuted.toString())
    launcherHeroMuteToggle.setAttribute('aria-label', Lang.queryJS(`landing.heroVideo.${heroMediaMuted ? 'unmute' : 'mute'}`))
    launcherHeroMuteToggle.disabled = !configured || !activeHeroMediaReady
}

function sendYouTubeCommand(func){
    const frame = launcherHeroYouTube.querySelector('iframe')
    frame?.contentWindow?.postMessage(JSON.stringify({
        event: 'command',
        func,
        args: []
    }), 'https://www.youtube.com')
}

function heroMediaCanPlay(){
    return ConfigManager.getPlayHeroVideos()
        && getCurrentView() === VIEWS.landing
        && getLandingSection() === 'play'
        && !document.hidden
        && document.hasFocus()
}

function syncHeroMediaPlayback(){
    updateHeroMediaControls()
    const shouldPlay = activeHeroMediaReady && heroMediaCanPlay()
    launcherHeroVideo.muted = heroMediaMuted
    if(activeHeroMedia?.descriptor.type === 'youtube'){
        sendYouTubeCommand(heroMediaMuted ? 'mute' : 'unMute')
        if(shouldPlay){
            sendYouTubeCommand('playVideo')
            launcherHeroYouTube.setAttribute('visible', '')
        } else {
            launcherHeroYouTube.removeAttribute('visible')
            setTimeout(() => {
                if(!heroMediaCanPlay()){
                    sendYouTubeCommand('pauseVideo')
                }
            }, 200)
        }
        return
    }
    if(activeHeroMedia?.descriptor.type === 'file'){
        if(shouldPlay){
            void launcherHeroVideo.play().then(() => {
                if(activeHeroMediaReady && heroMediaCanPlay()){
                    launcherHeroVideo.setAttribute('visible', '')
                }
            }).catch(err => {
                loggerLanding.warn('Unable to play the cached hero video.', err)
                launcherHeroVideo.removeAttribute('visible')
                setHeroMediaStatus(Lang.queryJS('landing.heroVideo.unavailable'))
            })
        } else {
            launcherHeroVideo.removeAttribute('visible')
            setTimeout(() => {
                if(!heroMediaCanPlay()){
                    launcherHeroVideo.pause()
                }
            }, 200)
        }
    }
}

function resetHeroMedia(){
    activeHeroMediaDownload?.destroy()
    activeHeroMediaDownload = null
    activeHeroMediaPromise = null
    activeHeroMediaReady = false
    launcherHeroVideo.removeAttribute('visible')
    launcherHeroVideo.pause()
    launcherHeroVideo.removeAttribute('src')
    launcherHeroVideo.load()
    launcherHeroYouTube.removeAttribute('visible')
    launcherHeroYouTube.replaceChildren()
    setHeroMediaStatus()
    updateHeroMediaControls()
}

function heroVideoCacheDirectory(serverId){
    const safeId = nodeCrypto.createHash('sha256').update(serverId).digest('hex').slice(0, 32)
    return nodePath.join(ConfigManager.getLauncherDirectory(), 'hero-video-cache', safeId)
}

function heroVideoCacheURL(serverId, filePath){
    const safeId = nodeCrypto.createHash('sha256').update(serverId).digest('hex').slice(0, 32)
    const fileName = nodePath.basename(filePath)
    return `maplecraft-video://cache/${safeId}/${fileName}`
}

function heroVideoCacheIdentity(descriptor){
    return {
        url: descriptor.url,
        contentType: descriptor.contentType,
        sha256: descriptor.sha256,
        size: descriptor.size
    }
}

function cacheIdentityMatches(left, right){
    return left?.url === right.url
        && left?.contentType === right.contentType
        && (right.sha256 == null || left?.sha256 === right.sha256)
        && (right.size == null || left?.size === right.size)
}

async function findCachedHeroVideo(serverId, descriptor){
    const cacheDirectory = heroVideoCacheDirectory(serverId)
    const metadata = await fsExtra.readJson(nodePath.join(cacheDirectory, 'metadata.json')).catch(() => null)
    const identity = heroVideoCacheIdentity(descriptor)
    if(!cacheIdentityMatches(metadata, identity) || typeof metadata?.fileName !== 'string'){
        return null
    }
    const filePath = nodePath.join(cacheDirectory, metadata.fileName)
    const fileStat = await fsExtra.stat(filePath).catch(() => null)
    if(!fileStat?.isFile() || (descriptor.size != null && fileStat.size !== descriptor.size)){
        return null
    }
    return filePath
}

async function cacheHeroVideo(serverId, descriptor, requestSequence){
    const cached = await findCachedHeroVideo(serverId, descriptor)
    if(cached){
        return cached
    }
    const cacheDirectory = heroVideoCacheDirectory(serverId)
    await fsExtra.ensureDir(cacheDirectory)
    const extension = descriptor.contentType === 'video/webm' ? '.webm' : '.mp4'
    const fileName = `video${extension}`
    const filePath = nodePath.join(cacheDirectory, fileName)
    const partPath = nodePath.join(cacheDirectory, `${fileName}.part`)
    const metadataPath = nodePath.join(cacheDirectory, 'metadata.json')
    const metadataPartPath = nodePath.join(cacheDirectory, 'metadata.json.part')
    await Promise.all([fsExtra.remove(partPath), fsExtra.remove(metadataPartPath)])
    setHeroMediaStatus(Lang.queryJS('landing.heroVideo.caching'))

    const hash = nodeCrypto.createHash('sha256')
    let size = 0
    const maximumSize = descriptor.size ?? 2 * 1024 * 1024 * 1024
    const meter = new StreamTransform({
        transform(chunk, _encoding, callback){
            size += chunk.length
            if(size > maximumSize){
                callback(new Error(`Hero video exceeds ${maximumSize} bytes`))
                return
            }
            hash.update(chunk)
            callback(null, chunk)
        }
    })
    const request = gotClient.stream(descriptor.url, {
        headers: { Accept: descriptor.contentType },
        retry: { limit: 2 },
        timeout: { response: 30_000 }
    })
    activeHeroMediaDownload = request
    try {
        await streamPipeline(request, meter, fsExtra.createWriteStream(partPath, { flags: 'wx' }))
        const sha256 = hash.digest('hex')
        if(requestSequence !== heroPresentationSequence){
            await fsExtra.remove(partPath)
            return null
        }
        if(descriptor.size != null && size !== descriptor.size){
            throw new Error(`Hero video size mismatch: expected ${descriptor.size}, received ${size}`)
        }
        if(descriptor.sha256 != null && sha256 !== descriptor.sha256){
            throw new Error('Hero video SHA-256 mismatch')
        }
        await fsExtra.move(partPath, filePath, { overwrite: true })
        const staleFile = nodePath.join(cacheDirectory, extension === '.mp4' ? 'video.webm' : 'video.mp4')
        await fsExtra.remove(staleFile)
        await fsExtra.writeJson(metadataPartPath, {
            ...heroVideoCacheIdentity(descriptor),
            sha256,
            size,
            fileName
        })
        await fsExtra.move(metadataPartPath, metadataPath, { overwrite: true })
        return filePath
    } catch(err) {
        await Promise.all([fsExtra.remove(partPath), fsExtra.remove(metadataPartPath)])
        throw err
    } finally {
        if(activeHeroMediaDownload === request){
            activeHeroMediaDownload = null
        }
    }
}

function prepareYouTubeHeroVideo(requestSequence){
    const descriptor = activeHeroMedia?.descriptor
    if(descriptor?.type !== 'youtube' || requestSequence !== heroPresentationSequence){
        return
    }
    const frame = document.createElement('iframe')
    frame.id = 'launcherHeroYouTubeFrame'
    frame.title = descriptor.videoId
    frame.allow = 'autoplay; encrypted-media'
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    frame.src = `https://www.youtube.com/embed/${descriptor.videoId}?enablejsapi=1&autoplay=1&mute=1&loop=1&playlist=${descriptor.videoId}&controls=0&playsinline=1&origin=https%3A%2F%2Fmcl.maplecraft.net&widget_referrer=https%3A%2F%2Fmcl.maplecraft.net%2F`
    frame.onload = () => {
        if(requestSequence !== heroPresentationSequence || activeHeroMedia?.descriptor !== descriptor){
            return
        }
        activeHeroMediaReady = true
        setHeroMediaStatus()
        syncHeroMediaPlayback()
    }
    frame.onerror = () => {
        if(requestSequence === heroPresentationSequence){
            activeHeroMediaReady = false
            launcherHeroYouTube.removeAttribute('visible')
            setHeroMediaStatus(Lang.queryJS('landing.heroVideo.unavailable'))
            updateHeroMediaControls()
        }
    }
    launcherHeroYouTube.replaceChildren(frame)
}

async function prepareFileHeroVideo(requestSequence){
    const media = activeHeroMedia
    if(media?.descriptor.type !== 'file'){
        return
    }
    let filePath = null
    try {
        filePath = await cacheHeroVideo(media.serverId, media.descriptor, requestSequence)
        if(!filePath || requestSequence !== heroPresentationSequence || activeHeroMedia !== media){
            return
        }
        launcherHeroVideo.src = heroVideoCacheURL(media.serverId, filePath)
        launcherHeroVideo.muted = heroMediaMuted
        launcherHeroVideo.load()
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Cached hero video did not become playable')), 10_000)
            launcherHeroVideo.oncanplay = () => {
                clearTimeout(timeout)
                resolve()
            }
            launcherHeroVideo.onerror = () => {
                clearTimeout(timeout)
                reject(new Error('Cached hero video could not be decoded'))
            }
        })
        if(requestSequence !== heroPresentationSequence || activeHeroMedia !== media){
            return
        }
        activeHeroMediaReady = true
        setHeroMediaStatus()
        syncHeroMediaPlayback()
    } catch(err) {
        if(requestSequence !== heroPresentationSequence){
            return
        }
        loggerLanding.warn('Unable to cache or play the hero video.', err)
        if(filePath){
            await Promise.all([
                fsExtra.remove(filePath),
                fsExtra.remove(nodePath.join(heroVideoCacheDirectory(media.serverId), 'metadata.json'))
            ])
        }
        activeHeroMediaReady = false
        launcherHeroVideo.removeAttribute('visible')
        setHeroMediaStatus(Lang.queryJS('landing.heroVideo.cacheFailed'))
        updateHeroMediaControls()
    }
}

function prepareActiveHeroMedia(requestSequence){
    if(activeHeroMediaPromise || !activeHeroMedia || !ConfigManager.getPlayHeroVideos()){
        return
    }
    if(activeHeroMedia.descriptor.type === 'youtube'){
        prepareYouTubeHeroVideo(requestSequence)
        return
    }
    activeHeroMediaPromise = prepareFileHeroVideo(requestSequence).finally(() => {
        if(requestSequence === heroPresentationSequence){
            activeHeroMediaPromise = null
        }
    })
}

function configureHeroMedia(serverId, descriptor, requestSequence){
    resetHeroMedia()
    if(!descriptor || !serverId){
        activeHeroMedia = null
        updateHeroMediaControls()
        return
    }
    activeHeroMedia = { serverId, descriptor }
    updateHeroMediaControls()
    prepareActiveHeroMedia(requestSequence)
}

launcherHeroPlayToggle.onclick = () => {
    const play = !ConfigManager.getPlayHeroVideos()
    ConfigManager.setPlayHeroVideos(play)
    ConfigManager.save()
    updateHeroMediaControls()
    if(play){
        prepareActiveHeroMedia(heroPresentationSequence)
    }
    syncHeroMediaPlayback()
}

launcherHeroMuteToggle.onclick = () => {
    heroMediaMuted = !heroMediaMuted
    syncHeroMediaPlayback()
}

async function applyServerPresentation(serv){
    const requestSequence = ++heroPresentationSequence
    const rawServer = serv?.rawServer
    const hero = rawServer?.ui?.hero || {}
    const video = normalizeHeroVideoDescriptor(hero.video)
    const eyebrow = typeof hero.eyebrow === 'string' && hero.eyebrow.trim()
        ? hero.eyebrow.trim()
        : defaultServerPresentation.eyebrow
    const presentation = {
        background: hero.background || defaultServerPresentation.background,
        logo: hero.logo || defaultServerPresentation.logo,
        eyebrow,
        title: hero.title || defaultServerPresentation.title,
        tagline: hero.tagline || defaultServerPresentation.tagline
    }

    launcherGameEyebrow.textContent = presentation.eyebrow
    launcherGameEyebrow.title = presentation.eyebrow
    launcherHeroWordmark.textContent = presentation.title
    launcherHeroTagline.textContent = presentation.tagline
    newsPreviewTitle.textContent = presentation.title || defaultServerPresentation.newsTitle
    configureHeroMedia(rawServer?.id, video, requestSequence)

    const [background, logo] = await Promise.all([
        preloadHeroAsset(presentation.background, defaultServerPresentation.background),
        preloadHeroAsset(presentation.logo, defaultServerPresentation.logo)
    ])
    if(requestSequence !== heroPresentationSequence){
        return
    }
    launcherHero.setAttribute('changing', '')
    requestAnimationFrame(() => {
        if(requestSequence !== heroPresentationSequence){
            return
        }
        launcherHero.style.backgroundImage = `url(${JSON.stringify(background)})`
        launcherHeroLogo.src = logo
        launcherHeroLogo.alt = presentation.title || rawServer?.name || 'MapleCraft'
        setTimeout(() => {
            if(requestSequence === heroPresentationSequence){
                launcherHero.removeAttribute('changing')
            }
        }, 200)
    })
}

function updateSelectedServer(serv){
    if(getLandingSection() === 'mods' && !commitLandingModsView()){
        return false
    }
    if(getLandingSection() === 'java' && !commitLandingJavaView()){
        return false
    }
    invalidateLandingModsView()
    invalidateLandingJavaView()
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    if(serv != null){
        selectedServerName.textContent = serv.rawServer.name
        selectedServerVersion.textContent = `${serv.rawServer.minecraftVersion} · ${serv.rawServer.version}`
        selectedServerIcon.src = serv.rawServer.icon
        selectedServerIcon.alt = serv.rawServer.name
        updateServerSidebarSelection(serverLandingSections.has(getLandingSection()) ? serv.rawServer.id : null)
    } else {
        selectedServerName.textContent = Lang.queryJS('landing.selectedServer.noSelection')
        selectedServerVersion.textContent = ''
        selectedServerIcon.src = 'assets/images/SealCircle.png'
        selectedServerIcon.alt = ''
        updateServerSidebarSelection(null)
    }
    setLaunchEnabled(serv != null)
    void applyServerPresentation(serv)
    void initGlobalNews()
    void initServerNews()
    if(getCurrentView() === VIEWS.landing && getLandingSection() === 'mods'){
        void prepareLandingModsView()
    }
    if(getCurrentView() === VIEWS.landing && getLandingSection() === 'java'){
        void prepareLandingJavaView()
    }
    return true
}
// Real text is set in uibinder.js on distributionIndexDone.
selectedServerName.textContent = Lang.queryJS('landing.selectedServer.loading')
function focusSelectedServerSidebar(){
    const selectedItem = serverSidebarList.querySelector('.serverSidebarItem[selected]')
    if(selectedItem != null){
        selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        selectedItem.focus()
    } else {
        serverSidebarList.focus()
    }
}
server_selection_button.onclick = focusSelectedServerSidebar

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }
    
    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }
    
    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    if(serv == null){
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
        return
    }

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
    }
    
}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 * 
 * @param {boolean} launchAfter Whether we should begin to launch after scanning. 
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true, serverId = ConfigManager.getSelectedServer()){

    const scanServerId = serverId

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)
            
            try {
                downloadJava(effectiveJavaOptions, launchAfter, scanServerId)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter, scanServerId)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(scanServerId, javaExec)
        ConfigManager.save()

        await syncLandingJavaExecutable(scanServerId, javaExec)

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter && ConfigManager.getSelectedServer() === scanServerId){
            await dlAsync()
        } else if(launchAfter){
            toggleLaunchArea(false)
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true, serverId = ConfigManager.getSelectedServer()) {

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    remote.getCurrentWindow().setProgressBar(2)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    remote.getCurrentWindow().setProgressBar(-1)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(serverId, newJavaExec)
    ConfigManager.save()
    await syncLandingJavaExecutable(serverId, newJavaExec)

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter, serverId)

}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }
    

    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

/**
 * News Loading Functions
 */

const serverLandingSections = new Set(['play', 'mods', 'java', 'serverUpdates'])
const newsStates = {}
let newsActive = null
let activeLandingSection = 'play'

function createNewsState(scope, rootId, cardsId){
    const root = document.getElementById(rootId)
    const query = selector => root.querySelector(selector)
    const state = {
        scope,
        root,
        cards: cardsId == null ? null : document.getElementById(cardsId),
        content: query('[data-news-content]'),
        title: query('[data-news-title]'),
        date: query('[data-news-date]'),
        author: query('[data-news-author]'),
        comments: query('[data-news-comments]'),
        navigation: query('[data-news-navigation]'),
        article: query('[data-news-article]'),
        previous: query('[data-news-previous]'),
        next: query('[data-news-next]'),
        errors: query('[data-news-errors]'),
        loading: query('[data-news-loading]'),
        loadingLabel: query('[data-news-loading-label]'),
        failed: query('[data-news-failed]'),
        retry: query('[data-news-retry]'),
        empty: query('[data-news-empty]'),
        articles: null,
        context: { serverId: scope === 'global' ? '__global__' : '', source: '' },
        contextKey: '',
        requestSequence: 0,
        loadingTimer: null,
        loadingPromise: null,
        initialized: false
    }

    state.retry.onclick = () => void initNewsState(state, true)
    state.previous.onclick = () => navigateNews(state, false)
    state.next.onclick = () => navigateNews(state, true)
    state.article.onscroll = event => {
        state.content.toggleAttribute('scrolled', event.target.scrollTop > 24)
    }
    return state
}

newsStates.global = createNewsState('global', 'globalNewsContainer', 'globalNewsCards')
newsStates.server = createNewsState('server', 'newsContainer', 'newsCards')

function getLandingSection(){
    return activeLandingSection
}

function setLandingSection(section){
    if(!['home', 'globalUpdates', 'play', 'mods', 'java', 'serverUpdates'].includes(section)){
        return false
    }
    if(activeLandingSection === 'mods' && section !== 'mods' && !commitLandingModsView()){
        return false
    }
    if(activeLandingSection === 'java' && section !== 'java' && !commitLandingJavaView()){
        return false
    }

    const sections = {
        home: document.getElementById('landingHomeView'),
        globalUpdates: document.getElementById('globalNewsContainer'),
        play: document.getElementById('landingPlayView'),
        mods: document.getElementById('landingModsView'),
        java: document.getElementById('landingJavaView'),
        serverUpdates: document.getElementById('newsContainer')
    }
    const tabs = {
        play: document.getElementById('landingPlayButton'),
        mods: document.getElementById('landingModsButton'),
        java: document.getElementById('landingJavaButton'),
        serverUpdates: document.getElementById('landingUpdatesButton')
    }
    const workspaceScroll = document.getElementById('landingWorkspaceScroll')

    for(const [name, view] of Object.entries(sections)){
        const selected = name === section
        view.hidden = !selected
        view.setAttribute('aria-hidden', (!selected).toString())
        if(tabs[name] != null){
            tabs[name].toggleAttribute('selected', selected)
            tabs[name].setAttribute('aria-selected', selected.toString())
            tabs[name].tabIndex = selected ? 0 : -1
        }
    }

    activeLandingSection = section
    const inServerWorkspace = serverLandingSections.has(section)
    document.getElementById('launcherWorkspace').toggleAttribute('global-view', !inServerWorkspace)
    document.getElementById('launcherGameHeader').hidden = !inServerWorkspace
    document.getElementById('launcherHomeHeader').hidden = inServerWorkspace
    document.getElementById('launcherHomeTitle').textContent = section === 'globalUpdates'
        ? document.getElementById('newsButtonText').textContent
        : document.getElementById('landingHomeButton').textContent.trim()
    syncHeroMediaPlayback()
    document.getElementById('landingHomeButton').toggleAttribute('selected', section === 'home')
    document.getElementById('newsButton').toggleAttribute('selected', section === 'globalUpdates')
    updateServerSidebarSelection(inServerWorkspace ? ConfigManager.getSelectedServer() : null)
    newsActive = section === 'globalUpdates' ? newsStates.global : (section === 'serverUpdates' ? newsStates.server : null)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    workspaceScroll.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
    playLauncherSectionEnter(sections[section])

    if(section === 'mods'){
        void prepareLandingModsView()
    }
    if(section === 'java'){
        void prepareLandingJavaView()
    }
    if(section === 'home'){
        void initGlobalNews()
    } else if(section === 'globalUpdates'){
        void initGlobalNews().then(() => markNewsStateRead(newsStates.global))
    } else if(section === 'serverUpdates'){
        void initServerNews().then(() => markNewsStateRead(newsStates.server))
    }
    return true
}

function openLandingSection(section){
    const requestSequence = beginLauncherShellNavigation()
    if(getCurrentView() === VIEWS.settings){
        switchLauncherShellView(VIEWS.landing, () => setLandingSection(section), () => {}, requestSequence)
    } else {
        setLandingSection(section)
    }
}

document.getElementById('landingPlayButton').onclick = () => openLandingSection('play')
document.getElementById('landingModsButton').onclick = () => openLandingSection('mods')
document.getElementById('landingJavaButton').onclick = () => openLandingSection('java')
document.getElementById('landingHomeButton').onclick = () => openLandingSection('home')
document.getElementById('landingUpdatesButton').onclick = () => openLandingSection('serverUpdates')
document.getElementById('newsButton').onclick = () => openLandingSection('globalUpdates')
document.getElementById('newsPreviewAction').onclick = () => openLandingSection('serverUpdates')
document.getElementById('newsBackButton').onclick = () => openLandingSection('play')
document.getElementById('globalNewsBackButton').onclick = () => openLandingSection('home')

document.getElementById('launcherGameTabs').addEventListener('keydown', event => {
    if(!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)){
        return
    }
    event.preventDefault()
    const tabs = [
        document.getElementById('landingPlayButton'),
        document.getElementById('landingModsButton'),
        document.getElementById('landingJavaButton'),
        document.getElementById('landingUpdatesButton')
    ]
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement))
    let nextIndex
    if(event.key === 'Home'){
        nextIndex = 0
    } else if(event.key === 'End'){
        nextIndex = tabs.length - 1
    } else {
        const offset = event.key === 'ArrowRight' ? 1 : -1
        nextIndex = (currentIndex + offset + tabs.length) % tabs.length
    }
    tabs[nextIndex].focus()
    tabs[nextIndex].click()
})
setLandingSection('play')

document.addEventListener('visibilitychange', syncHeroMediaPlayback)
window.addEventListener('focus', syncHeroMediaPlayback)
window.addEventListener('blur', syncHeroMediaPlayback)
window.addEventListener('message', event => {
    if(event.origin !== 'https://www.youtube.com' || activeHeroMedia?.descriptor.type !== 'youtube'){
        return
    }
    try {
        const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if(message?.event === 'onError'){
            activeHeroMediaReady = false
            launcherHeroYouTube.removeAttribute('visible')
            setHeroMediaStatus(Lang.queryJS('landing.heroVideo.unavailable'))
            updateHeroMediaControls()
        }
    } catch {
        // Ignore unrelated YouTube postMessage traffic.
    }
})

function setNewsPreviewState(state, message){
    if(state.cards == null){
        return
    }
    const status = document.createElement('div')
    status.className = 'newsPreviewState'
    status.textContent = message
    state.cards.replaceChildren(status)
}

function normalizeArticleURL(value){
    try {
        const url = new NodeURL(value)
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
    } catch {
        return null
    }
}

function openArticleExternally(value){
    const url = normalizeArticleURL(value)
    if(url != null){
        void shell.openExternal(url)
    }
}

function renderNewsCards(state, articles){
    if(state.cards == null){
        return
    }
    if(articles == null){
        setNewsPreviewState(state, Lang.queryJS('landing.news.previewFailed'))
        return
    }
    if(articles.length === 0){
        setNewsPreviewState(state, Lang.queryJS('landing.news.previewEmpty'))
        return
    }

    const fragment = document.createDocumentFragment()
    const visibleArticles = state.scope === 'global' ? articles : articles.slice(0, 3)
    visibleArticles.forEach((article, index) => {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'newsPreviewCard'

        const artwork = document.createElement('span')
        artwork.className = 'newsPreviewArtwork'
        artwork.style.backgroundImage = `url(${JSON.stringify(article.image || `assets/images/backgrounds/${index % 12}.jpg`)})`

        const copy = document.createElement('span')
        copy.className = 'newsPreviewCardCopy'
        const date = document.createElement('span')
        date.className = 'newsPreviewCardDate'
        date.textContent = article.date
        const title = document.createElement('span')
        title.className = 'newsPreviewCardTitle'
        title.textContent = article.title
        copy.append(date, title)
        card.append(artwork, copy)
        if(state.scope === 'global'){
            const articleURL = normalizeArticleURL(article.link)
            card.disabled = articleURL == null
            card.onclick = () => openArticleExternally(articleURL)
        } else {
            card.onclick = () => {
                displayNewsArticle(state, article, index + 1)
                setLandingSection('serverUpdates')
            }
        }
        fragment.appendChild(card)
    })
    state.cards.replaceChildren(fragment)
}

function setNewsLoading(state, val){
    if(val){
        if(state.loadingTimer != null){
            clearInterval(state.loadingTimer)
        }
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        state.loadingLabel.textContent = nLStr + dotStr
        state.loadingTimer = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            state.loadingLabel.textContent = nLStr + dotStr
        }, 750)
    } else if(state.loadingTimer != null){
        clearInterval(state.loadingTimer)
        state.loadingTimer = null
    }
}

function showNewsResult(state, result){
    state.content.style.display = result === 'content' ? 'flex' : 'none'
    state.errors.style.display = result === 'content' ? 'none' : 'flex'
    state.loading.style.display = result === 'loading' ? 'flex' : 'none'
    state.failed.style.display = result === 'failed' ? 'flex' : 'none'
    state.empty.style.display = result === 'empty' ? 'block' : 'none'
    setNewsLoading(state, result === 'loading')
}

let globalNewsAlertShown = false

function setGlobalNewsAlert(visible){
    globalNewsAlertShown = visible
    const alert = document.getElementById('newsButtonAlert')
    $(alert).stop(true, true)[visible ? 'fadeIn' : 'fadeOut'](200)
}

function markNewsStateRead(state){
    if(!state.initialized){
        return
    }
    ConfigManager.setNewsCacheDismissed(state.context.serverId, state.context.source, true)
    ConfigManager.save()
    if(state.scope === 'global' && globalNewsAlertShown){
        setGlobalNewsAlert(false)
    }
}

function reloadNews(){
    return Promise.all([initGlobalNews(true), initServerNews(true)])
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

async function resolveNewsContext(scope){
    const distroData = await DistroAPI.getDistribution()
    if(scope === 'global'){
        return {
            serverId: '__global__',
            source: distroData.rawDistribution.rss || ''
        }
    }
    const selectedServerId = ConfigManager.getSelectedServer()
    const server = selectedServerId == null ? null : distroData.getServerById(selectedServerId)
    const source = server?.rawServer?.ui?.news?.rss || distroData.rawDistribution.rss || ''
    return {
        serverId: selectedServerId || '__global__',
        source
    }
}

async function initNewsState(state, force = false){
    let context
    try {
        context = await resolveNewsContext(state.scope)
    } catch(err) {
        loggerLanding.error(`Unable to resolve ${state.scope} news context.`, err)
        ++state.requestSequence
        state.articles = null
        state.contextKey = ''
        state.loadingPromise = null
        state.initialized = true
        renderNewsCards(state, null)
        showNewsResult(state, 'failed')
        if(state.scope === 'global'){
            setGlobalNewsAlert(false)
        }
        return
    }
    const contextKey = `${context.serverId}\u0000${context.source}`
    if(!force && state.contextKey === contextKey){
        if(state.loadingPromise != null){
            return state.loadingPromise
        }
        if(state.initialized){
            return
        }
    }

    const requestSequence = ++state.requestSequence
    state.context = context
    state.contextKey = contextKey
    state.initialized = false
    showNewsResult(state, 'loading')
    setNewsPreviewState(state, Lang.queryJS('landing.news.checking'))
    if(state.scope === 'global'){
        setGlobalNewsAlert(false)
    }

    const operation = (async () => {
        try {
            const cached = ConfigManager.getNewsCache(context.serverId, context.source)
            let news = await loadNews(context.source)
            if(requestSequence !== state.requestSequence){
                return
            }

            let usingCache = false
            if(news?.articles == null && Array.isArray(cached.articles)){
                news = { articles: cached.articles }
                usingCache = true
            }

            state.articles = news?.articles || null
            if(state.articles == null){
                renderNewsCards(state, null)
                showNewsResult(state, 'failed')
                state.initialized = true
                return
            }

            if(state.articles.length === 0){
                renderNewsCards(state, [])
                showNewsResult(state, 'empty')
                if(!usingCache){
                    ConfigManager.setNewsCache(context.serverId, context.source, {
                        date: null,
                        content: null,
                        dismissed: true,
                        articles: []
                    })
                    ConfigManager.save()
                }
                if(state.scope === 'global'){
                    setGlobalNewsAlert(false)
                }
                state.initialized = true
                return
            }

            renderNewsCards(state, state.articles)
            const latest = state.articles[0]
            const newHash = await digestMessage(latest.content || '')
            if(requestSequence !== state.requestSequence){
                return
            }
            const parsedDate = new Date(latest.date).getTime()
            const newDate = Number.isFinite(parsedDate) ? parsedDate : 0
            const cachedDate = Number(cached.date) || 0
            const changed = cached.content == null || cached.content !== newHash || newDate > cachedDate
            const dismissed = usingCache ? Boolean(cached.dismissed) : (changed ? false : Boolean(cached.dismissed))

            if(!usingCache){
                ConfigManager.setNewsCache(context.serverId, context.source, {
                    date: newDate,
                    content: newHash,
                    dismissed,
                    articles: state.articles
                })
                ConfigManager.save()
            }
            if(state.scope === 'global'){
                setGlobalNewsAlert(!dismissed)
            }

            displayNewsArticle(state, state.articles[0], 1)
            showNewsResult(state, 'content')
            state.initialized = true
        } catch(err) {
            if(requestSequence !== state.requestSequence){
                return
            }
            loggerLanding.error(`Unable to initialize ${state.scope} news.`, err)
            state.articles = null
            state.initialized = true
            renderNewsCards(state, null)
            showNewsResult(state, 'failed')
            if(state.scope === 'global'){
                setGlobalNewsAlert(false)
            }
        }
    })()

    state.loadingPromise = operation
    try {
        await operation
    } finally {
        if(state.loadingPromise === operation){
            state.loadingPromise = null
        }
    }
}

function initGlobalNews(force = false){
    return initNewsState(newsStates.global, force)
}

function initServerNews(force = false){
    return initNewsState(newsStates.server, force)
}

function navigateNews(state, forward){
    if(!Array.isArray(state.articles) || state.articles.length === 0){
        return
    }
    const current = Number.parseInt(state.content.getAttribute('article'), 10)
    const currentIndex = Number.isFinite(current) ? current : 0
    const nextIndex = forward
        ? (currentIndex + 1) % state.articles.length
        : (currentIndex - 1 + state.articles.length) % state.articles.length
    displayNewsArticle(state, state.articles[nextIndex], nextIndex + 1)
}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if(getCurrentView() === VIEWS.landing && newsActive != null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')){
        e.preventDefault()
        navigateNews(newsActive, e.key === 'ArrowRight')
    }
})

/**
 * Display a news article on the UI.
 * 
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayNewsArticle(state, articleObject, index){
    state.title.textContent = articleObject.title || ''
    const articleURL = normalizeArticleURL(articleObject.link)
    if(articleURL == null){
        state.title.removeAttribute('href')
    } else {
        state.title.href = articleURL
    }
    state.author.textContent = articleObject.author ? `by ${articleObject.author}` : ''
    state.date.textContent = articleObject.date || ''
    state.comments.textContent = articleObject.comments || ''
    const commentsURL = normalizeArticleURL(articleObject.commentsLink)
    if(commentsURL == null){
        state.comments.removeAttribute('href')
    } else {
        state.comments.href = commentsURL
    }
    state.article.innerHTML = `<div class="newsFullArticleContentWrapper"><div class="newsArticleSpacerTop"></div>${articleObject.content || ''}<div class="newsArticleSpacerBot"></div></div>`
    Array.from(state.article.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    state.navigation.textContent = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: state.articles.length})
    state.content.setAttribute('article', index - 1)
    state.article.scrollTop = 0
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
async function loadNews(newsFeed){

    if(!newsFeed) {
        loggerLanding.debug('No RSS feed provided.')
        return { articles: [] }
    }

    const promise = new Promise(resolve => {
        let newsHost
        try {
            newsHost = new NodeURL(newsFeed).origin + '/'
        } catch(err) {
            loggerLanding.warn('Invalid RSS feed URL.', newsFeed)
            resolve({ articles: null })
            return
        }
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    // Resolve date.
                    const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})

                    // Resolve comments.
                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                    // Fix relative links in content.
                    let content = el.find('content\\:encoded').text()
                    let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                    let matches
                    while((matches = regex.exec(content))){
                        content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                    }

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text()
                    const imageMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i)
                    const image = imageMatch == null ? null : imageMatch[1]

                    // Generate article.
                    articles.push(
                        {
                            link,
                            title,
                            date,
                            author,
                            content,
                            image,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve({
                    articles
                })
            },
            timeout: 2500
        }).catch(err => {
            resolve({
                articles: null
            })
        })
    })

    return await promise
}
