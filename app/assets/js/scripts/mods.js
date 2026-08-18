const LandingDropinModUtil = require('./assets/js/dropinmodutil')

const landingModsLogger = LoggerUtil.getLogger('Landing Mods')
const landingModsContainer = document.getElementById('settingsModsContainer')
const landingModsStatus = document.getElementById('landingModsStatus')
const landingModsStatusText = document.getElementById('landingModsStatusText')
const landingModsRetryButton = document.getElementById('landingModsRetryButton')
const landingModsContent = document.getElementById('landingModsContent')
const landingModsEmpty = document.getElementById('landingModsEmpty')
const landingModsReqContainer = document.getElementById('settingsReqModsContainer')
const landingModsOptContainer = document.getElementById('settingsOptModsContainer')

let landingModsRequestSequence = 0
let landingModsServerId = null
let landingModsDirectory = null
let landingModsInstanceDirectory = null
let landingModsReady = false

function escapeModMarkup(value){
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;')
}

function showLandingModsStatus(message, retry = false){
    landingModsStatusText.textContent = message
    landingModsRetryButton.hidden = !retry
    landingModsStatus.hidden = false
    landingModsContent.hidden = true
}

function showLandingModsError(title, message){
    setOverlayContent(title, message, Lang.queryJS('landing.mods.okButton'))
    setOverlayHandler(() => toggleOverlay(false))
    toggleOverlay(true)
}

function renderLandingModsServer(server){
    const rawServer = server.rawServer
    const icon = document.getElementById('landingModsServerIcon')
    icon.src = rawServer.icon
    icon.alt = rawServer.name
    document.getElementById('landingModsServerName').textContent = rawServer.name
    document.getElementById('landingModsServerVersion').textContent = `${rawServer.minecraftVersion} · ${rawServer.version}`
}

function parseLandingModulesForUI(modules, submodules, configuration){
    let requiredMods = ''
    let optionalMods = ''
    const config = configuration ?? {}

    for(const module of modules){
        const type = module.rawModule.type
        if(type !== Type.ForgeMod && type !== Type.LiteMod && type !== Type.LiteLoader && type !== Type.FabricMod){
            continue
        }

        const identifier = module.getVersionlessMavenIdentifier()
        const moduleName = escapeModMarkup(module.rawModule.name)
        const moduleVersion = escapeModMarkup(module.mavenComponents.version)
        const moduleId = escapeModMarkup(identifier)
        const required = module.getRequired().value
        const moduleConfig = config[identifier]
        const enabled = required || (typeof moduleConfig === 'object' ? moduleConfig?.value : moduleConfig)
        const childConfig = typeof moduleConfig === 'object' && moduleConfig != null
            ? moduleConfig.mods ?? {}
            : {}
        const children = parseLandingModulesForUI(module.subModules ?? [], true, childConfig)
        const childMarkup = `${children.requiredMods}${children.optionalMods}`
        const markup = `<div id="${moduleId}" class="settingsBaseMod settings${submodules ? 'Sub' : ''}Mod" ${enabled ? 'enabled' : ''}>
                    <div class="settingsModContent">
                        <div class="settingsModMainWrapper">
                            <div class="settingsModStatus"></div>
                            <div class="settingsModDetails">
                                <span class="settingsModName">${moduleName}</span>
                                <span class="settingsModVersion">v${moduleVersion}</span>
                            </div>
                        </div>
                        <label class="toggleSwitch" ${required ? 'reqmod' : ''}>
                            <input type="checkbox" ${required ? 'checked disabled' : `formod="${moduleId}" ${enabled ? 'checked' : ''}`}>
                            <span class="toggleSwitchSlider"></span>
                        </label>
                    </div>
                    ${childMarkup.length > 0 ? `<div class="settingsSubModContainer">${childMarkup}</div>` : ''}
                </div>`

        if(required){
            requiredMods += markup
        } else {
            optionalMods += markup
        }
    }

    return {
        requiredMods,
        optionalMods
    }
}

function readLandingModConfiguration(configuration){
    for(const [identifier, value] of Object.entries(configuration ?? {})){
        const toggle = landingModsContainer.querySelector(`[formod="${identifier}"]:not([dropin])`)
        if(typeof value === 'boolean'){
            if(toggle != null){
                configuration[identifier] = toggle.checked
            }
            continue
        }
        if(value == null){
            continue
        }
        if(toggle != null){
            value.value = toggle.checked
        }
        value.mods = readLandingModConfiguration(value.mods)
    }
    return configuration
}

function saveLandingModConfiguration(){
    if(!landingModsReady || landingModsServerId == null || landingModsServerId !== ConfigManager.getSelectedServer()){
        return
    }

    const current = ConfigManager.getModConfiguration(landingModsServerId)
    if(current == null){
        return
    }
    const previous = JSON.parse(JSON.stringify(current))
    const next = JSON.parse(JSON.stringify(current))
    next.mods = readLandingModConfiguration(next.mods)
    try {
        ConfigManager.setModConfiguration(landingModsServerId, next)
        ConfigManager.save()
    } catch(err) {
        ConfigManager.setModConfiguration(landingModsServerId, previous)
        throw err
    }
}

function updateLandingModVisual(toggle){
    toggle.closest('.settingsBaseMod')?.toggleAttribute('enabled', toggle.checked)
}

function bindLandingDistributionModToggles(){
    for(const toggle of landingModsContainer.querySelectorAll('[formod]:not([dropin])')){
        toggle.onchange = () => {
            const previous = !toggle.checked
            updateLandingModVisual(toggle)
            try {
                saveLandingModConfiguration()
            } catch(err) {
                landingModsLogger.error('Failed to save the mod configuration.', err)
                toggle.checked = previous
                updateLandingModVisual(toggle)
                showLandingModsError(
                    Lang.queryJS('landing.mods.saveFailedTitle'),
                    Lang.queryJS('landing.mods.saveFailedMessage')
                )
            }
        }
    }
}

async function resolveLandingDropinMods(server, requestSequence){
    const rawServer = server.rawServer
    const modsDirectory = path.join(ConfigManager.getInstanceDirectory(), rawServer.id, 'mods')
    const dropinMods = LandingDropinModUtil.scanForDropinMods(modsDirectory, rawServer.minecraftVersion)
    if(requestSequence !== landingModsRequestSequence){
        return false
    }

    landingModsDirectory = modsDirectory
    let markup = ''
    for(const dropin of dropinMods){
        const fullName = escapeModMarkup(dropin.fullName)
        markup += `<div id="${fullName}" class="settingsBaseMod settingsDropinMod" ${dropin.disabled ? '' : 'enabled'}>
                    <div class="settingsModContent">
                        <div class="settingsModMainWrapper">
                            <div class="settingsModStatus"></div>
                            <div class="settingsModDetails">
                                <span class="settingsModName">${escapeModMarkup(dropin.name)}</span>
                                <div class="settingsDropinRemoveWrapper">
                                    <button class="settingsDropinRemoveButton mcButtonDanger mcButtonCompact" type="button" remmod="${fullName}">${Lang.queryJS('landing.mods.removeButton')}</button>
                                </div>
                            </div>
                        </div>
                        <label class="toggleSwitch">
                            <input type="checkbox" formod="${fullName}" dropin ${dropin.disabled ? '' : 'checked'}>
                            <span class="toggleSwitchSlider"></span>
                        </label>
                    </div>
                </div>`
    }
    document.getElementById('settingsDropinModsContent').innerHTML = markup
    return true
}

async function reloadLandingDropinMods(serverId = landingModsServerId){
    if(serverId == null || serverId !== landingModsServerId || serverId !== ConfigManager.getSelectedServer()){
        return
    }
    const requestSequence = landingModsRequestSequence
    const distro = await DistroAPI.getDistribution()
    if(requestSequence !== landingModsRequestSequence || serverId !== landingModsServerId){
        return
    }
    const server = distro.getServerById(serverId)
    if(server == null || !await resolveLandingDropinMods(server, requestSequence)){
        return
    }
    bindLandingDropinControls()
}

function bindLandingDropinControls(){
    for(const removeButton of landingModsContainer.querySelectorAll('[remmod]')){
        removeButton.onclick = async () => {
            const fullName = removeButton.getAttribute('remmod')
            const serverId = landingModsServerId
            removeButton.disabled = true
            const result = await LandingDropinModUtil.deleteDropinMod(landingModsDirectory, fullName)
            if(result){
                await reloadLandingDropinMods(serverId)
            } else {
                removeButton.disabled = false
                showLandingModsError(
                    Lang.queryJS('landing.mods.deleteFailedTitle', { fullName }),
                    Lang.queryJS('landing.mods.deleteFailedMessage')
                )
            }
        }
    }

    for(const toggle of landingModsContainer.querySelectorAll('[formod][dropin]')){
        toggle.onchange = async () => {
            const fullName = toggle.getAttribute('formod')
            const enabled = toggle.checked
            const serverId = landingModsServerId
            const modsDirectory = landingModsDirectory
            toggle.disabled = true
            updateLandingModVisual(toggle)
            try {
                await LandingDropinModUtil.toggleDropinMod(modsDirectory, fullName, enabled)
                await reloadLandingDropinMods(serverId)
            } catch(err) {
                landingModsLogger.error('Failed to toggle a drop-in mod.', err)
                toggle.checked = !enabled
                toggle.disabled = false
                updateLandingModVisual(toggle)
                showLandingModsError(
                    Lang.queryJS('landing.mods.toggleFailedTitle'),
                    err.message
                )
            }
        }
    }
}

function bindLandingDropinButton(){
    const button = document.getElementById('settingsDropinFileSystemButton')
    button.onclick = () => {
        LandingDropinModUtil.validateDir(landingModsDirectory)
        shell.openPath(landingModsDirectory)
    }
    button.ondragenter = event => {
        event.dataTransfer.dropEffect = 'move'
        button.setAttribute('drag', '')
        event.preventDefault()
    }
    button.ondragover = event => event.preventDefault()
    button.ondragleave = () => button.removeAttribute('drag')
    button.ondrop = async event => {
        button.removeAttribute('drag')
        event.preventDefault()
        const serverId = landingModsServerId
        try {
            LandingDropinModUtil.addDropinMods(event.dataTransfer.files, landingModsDirectory)
            await reloadLandingDropinMods(serverId)
        } catch(err) {
            landingModsLogger.error('Failed to add drop-in mods.', err)
            showLandingModsError(Lang.queryJS('landing.mods.addFailedTitle'), err.message)
        }
    }
}

function closeLandingShaderpackSelect(){
    const selected = document.getElementById('settingsShadersSelected')
    document.getElementById('settingsShadersOptions').hidden = true
    selected.classList.remove('select-arrow-active')
    selected.setAttribute('aria-expanded', 'false')
}

function selectLandingShaderpack(option){
    const options = document.getElementById('settingsShadersOptions')
    const selectedButton = document.getElementById('settingsShadersSelected')
    const previous = options.querySelector('[selected]')
    const previousValue = previous?.getAttribute('value') ?? 'OFF'

    try {
        LandingDropinModUtil.setEnabledShaderpack(landingModsInstanceDirectory, option.getAttribute('value'))
        previous?.removeAttribute('selected')
        option.setAttribute('selected', '')
        option.setAttribute('aria-selected', 'true')
        if(previous != null){
            previous.setAttribute('aria-selected', 'false')
        }
        selectedButton.textContent = option.textContent
        closeLandingShaderpackSelect()
    } catch(err) {
        landingModsLogger.error('Failed to select a shaderpack.', err)
        try {
            LandingDropinModUtil.setEnabledShaderpack(landingModsInstanceDirectory, previousValue)
        } catch(restoreError) {
            landingModsLogger.error('Failed to restore the previous shaderpack.', restoreError)
        }
        showLandingModsError(Lang.queryJS('landing.mods.shaderFailedTitle'), err.message)
    }
}

function renderLandingShaderpacks(server, requestSequence){
    const instanceDirectory = path.join(ConfigManager.getInstanceDirectory(), server.rawServer.id)
    const shaderpacks = LandingDropinModUtil.scanForShaderpacks(instanceDirectory)
    const selected = LandingDropinModUtil.getEnabledShaderpack(instanceDirectory)
    if(requestSequence !== landingModsRequestSequence){
        return false
    }

    landingModsInstanceDirectory = instanceDirectory
    const options = document.getElementById('settingsShadersOptions')
    const selectedButton = document.getElementById('settingsShadersSelected')
    options.replaceChildren()
    let selectedName = Lang.queryJS('landing.mods.shaderOff')
    for(const shaderpack of shaderpacks){
        const option = document.createElement('div')
        option.setAttribute('role', 'option')
        option.setAttribute('value', shaderpack.fullName)
        option.setAttribute('aria-selected', (shaderpack.fullName === selected).toString())
        option.tabIndex = 0
        option.textContent = shaderpack.fullName === 'OFF'
            ? Lang.queryJS('landing.mods.shaderOff')
            : shaderpack.name
        if(shaderpack.fullName === selected){
            option.setAttribute('selected', '')
            selectedName = option.textContent
        }
        option.onclick = () => selectLandingShaderpack(option)
        option.onkeydown = event => {
            if(event.key === 'Enter' || event.key === ' '){
                event.preventDefault()
                selectLandingShaderpack(option)
            }
        }
        options.appendChild(option)
    }
    selectedButton.textContent = selectedName
    return true
}

function bindLandingShaderpackControls(){
    const selected = document.getElementById('settingsShadersSelected')
    const options = document.getElementById('settingsShadersOptions')
    selected.onclick = event => {
        event.stopPropagation()
        const opening = options.hidden
        closeLandingShaderpackSelect()
        if(opening){
            options.hidden = false
            selected.classList.add('select-arrow-active')
            selected.setAttribute('aria-expanded', 'true')
        }
    }

    const addButton = document.getElementById('settingsShaderpackButton')
    addButton.onclick = () => {
        const shaderpacksDirectory = path.join(landingModsInstanceDirectory, 'shaderpacks')
        LandingDropinModUtil.validateDir(shaderpacksDirectory)
        shell.openPath(shaderpacksDirectory)
    }
    addButton.ondragenter = event => {
        event.dataTransfer.dropEffect = 'move'
        addButton.setAttribute('drag', '')
        event.preventDefault()
    }
    addButton.ondragover = event => event.preventDefault()
    addButton.ondragleave = () => addButton.removeAttribute('drag')
    addButton.ondrop = async event => {
        addButton.removeAttribute('drag')
        event.preventDefault()
        const serverId = landingModsServerId
        const requestSequence = landingModsRequestSequence
        try {
            LandingDropinModUtil.addShaderpacks(event.dataTransfer.files, landingModsInstanceDirectory)
            if(serverId === landingModsServerId && requestSequence === landingModsRequestSequence){
                const distro = await DistroAPI.getDistribution()
                if(serverId === landingModsServerId && requestSequence === landingModsRequestSequence){
                    const server = distro.getServerById(serverId)
                    renderLandingShaderpacks(server, requestSequence)
                }
            }
        } catch(err) {
            landingModsLogger.error('Failed to add shaderpacks.', err)
            showLandingModsError(Lang.queryJS('landing.mods.addFailedTitle'), err.message)
        }
    }
}

async function prepareLandingModsView(){
    const requestSequence = ++landingModsRequestSequence
    const selectedServerId = ConfigManager.getSelectedServer()
    landingModsReady = false
    landingModsServerId = null
    closeLandingShaderpackSelect()

    if(selectedServerId == null){
        showLandingModsStatus(Lang.queryJS('landing.mods.noServer'))
        return
    }

    showLandingModsStatus(Lang.queryJS('landing.mods.loading'))
    try {
        const distro = await DistroAPI.getDistribution()
        const server = distro.getServerById(selectedServerId)
        if(requestSequence !== landingModsRequestSequence){
            return
        }
        if(server == null){
            showLandingModsStatus(Lang.queryJS('landing.mods.noServer'))
            return
        }

        const config = ConfigManager.getModConfiguration(selectedServerId)?.mods ?? {}
        const modules = parseLandingModulesForUI(server.modules, false, config)
        document.getElementById('settingsReqModsContent').innerHTML = modules.requiredMods
        document.getElementById('settingsOptModsContent').innerHTML = modules.optionalMods
        landingModsReqContainer.hidden = modules.requiredMods.length === 0
        landingModsOptContainer.hidden = modules.optionalMods.length === 0
        landingModsEmpty.hidden = !landingModsReqContainer.hidden || !landingModsOptContainer.hidden
        renderLandingModsServer(server)

        if(!await resolveLandingDropinMods(server, requestSequence) || !renderLandingShaderpacks(server, requestSequence)){
            return
        }
        landingModsServerId = selectedServerId
        landingModsReady = true
        bindLandingDistributionModToggles()
        bindLandingDropinControls()
        bindLandingDropinButton()
        bindLandingShaderpackControls()
        landingModsStatus.hidden = true
        landingModsContent.hidden = false
    } catch(err) {
        if(requestSequence !== landingModsRequestSequence){
            return
        }
        landingModsLogger.error('Failed to prepare the mods view.', err)
        showLandingModsStatus(Lang.queryJS('landing.mods.loadFailed'), true)
    }
}

function commitLandingModsView(showError = true){
    if(!landingModsReady){
        return true
    }
    try {
        saveLandingModConfiguration()
        return true
    } catch(err) {
        landingModsLogger.error('Failed to commit the mods view.', err)
        if(showError){
            showLandingModsError(
                Lang.queryJS('landing.mods.saveFailedTitle'),
                Lang.queryJS('landing.mods.saveFailedMessage')
            )
        }
        return false
    }
}

function invalidateLandingModsView(){
    landingModsRequestSequence++
    landingModsReady = false
    landingModsServerId = null
}

landingModsRetryButton.onclick = () => prepareLandingModsView()

document.addEventListener('click', event => {
    if(!document.getElementById('settingsShadersOptions').contains(event.target)){
        closeLandingShaderpackSelect()
    }
})

document.addEventListener('keydown', async event => {
    if(event.key === 'F5' && getCurrentView() === VIEWS.landing && typeof getLandingSection === 'function' && getLandingSection() === 'mods'){
        event.preventDefault()
        await prepareLandingModsView()
    }
})

window.addEventListener('beforeunload', event => {
    if(typeof getLandingSection === 'function' && getLandingSection() === 'mods' && !commitLandingModsView(false)){
        event.preventDefault()
        event.returnValue = false
    }
})
