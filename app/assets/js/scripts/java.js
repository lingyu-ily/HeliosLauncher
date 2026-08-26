const os = require('os')

const landingJavaLogger = LoggerUtil.getLogger('Landing Java')
const settingsMaxRAMRange = document.getElementById('settingsMaxRAMRange')
const settingsMinRAMRange = document.getElementById('settingsMinRAMRange')
const settingsMaxRAMLabel = document.getElementById('settingsMaxRAMLabel')
const settingsMinRAMLabel = document.getElementById('settingsMinRAMLabel')
const settingsMemoryTotal = document.getElementById('settingsMemoryTotal')
const settingsMemoryAvail = document.getElementById('settingsMemoryAvail')
const settingsJavaExecDetails = document.getElementById('settingsJavaExecDetails')
const settingsJavaExecVal = document.getElementById('settingsJavaExecVal')
const settingsJavaExecSel = document.getElementById('settingsJavaExecSel')
const settingsJavaReqDesc = document.getElementById('settingsJavaReqDesc')
const settingsJVMOptsVal = document.getElementById('settingsJVMOptsVal')
const settingsJvmOptsLink = document.getElementById('settingsJvmOptsLink')
const landingJavaStatus = document.getElementById('landingJavaStatus')
const landingJavaStatusText = document.getElementById('landingJavaStatusText')
const landingJavaRetryButton = document.getElementById('landingJavaRetryButton')
const landingJavaContent = document.getElementById('landingJavaContent')

const landingJavaState = {
    requestSequence: 0,
    serverId: null,
    ready: false,
    memoryDirty: false,
    jvmDirty: false
}

function showLandingJavaStatus(message, retry = false){
    landingJavaStatusText.textContent = message
    landingJavaRetryButton.hidden = !retry
    landingJavaStatus.hidden = false
    landingJavaContent.hidden = true
}

function showLandingJavaError(title, message, focusTarget = null){
    setOverlayContent(title, message, Lang.queryJS('landing.java.okButton'))
    setOverlayHandler(() => {
        toggleOverlay(false)
        focusTarget?.focus()
    })
    toggleOverlay(true)
}

function renderLandingJavaServer(server){
    const rawServer = server.rawServer
    const icon = document.getElementById('landingJavaServerIcon')
    icon.alt = rawServer.name
    bindCachedServerImage(icon, rawServer, 'icon', rawServer.icon)
    document.getElementById('landingJavaServerName').textContent = rawServer.name
    document.getElementById('landingJavaServerVersion').textContent = `${rawServer.minecraftVersion} · ${rawServer.version}`
}

function parseMemoryValue(value){
    if(typeof value === 'number'){
        return value
    }
    const normalized = String(value ?? '').trim().toUpperCase()
    if(normalized.endsWith('M')){
        return Number.parseFloat(normalized.slice(0, -1))/1024
    }
    return Number.parseFloat(normalized)
}

function formatMemoryConfigValue(value){
    const mebibytes = Math.round(Number(value)*1024)
    return mebibytes % 1024 === 0 ? `${mebibytes/1024}G` : `${mebibytes}M`
}

function formatMemoryLabel(value){
    const numeric = Number(value)
    return `${Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1)}G`
}

function getRangeSliderMeta(element){
    const min = Number(element.getAttribute('min'))
    const max = Number(element.getAttribute('max'))
    const step = Number(element.getAttribute('step')) || 1
    return {
        min,
        max,
        step,
        range: Math.max(0, max-min)
    }
}

function normalizeSliderValue(element, value){
    const meta = getRangeSliderMeta(element)
    if(meta.range === 0){
        return meta.min
    }
    const clamped = Math.min(meta.max, Math.max(meta.min, Number(value)))
    const snapped = meta.min + Math.round((clamped-meta.min)/meta.step)*meta.step
    return Number(Math.min(meta.max, Math.max(meta.min, snapped)).toFixed(4))
}

function updateRangeSliderVisual(element){
    const meta = getRangeSliderMeta(element)
    const value = normalizeSliderValue(element, element.getAttribute('value'))
    const thumb = element.getElementsByClassName('rangeSliderTrack')[0]
    const bar = element.getElementsByClassName('rangeSliderBar')[0]
    const thumbWidth = thumb.offsetWidth || 10
    const usableWidth = Math.max(0, element.clientWidth-thumbWidth)
    const ratio = meta.range === 0 ? 0 : (value-meta.min)/meta.range
    const thumbLeft = ratio*usableWidth

    thumb.style.left = `${thumbLeft}px`
    bar.style.width = `${thumbLeft + thumbWidth/2}px`
    element.setAttribute('aria-valuemin', String(meta.min))
    element.setAttribute('aria-valuemax', String(meta.max))
    element.setAttribute('aria-valuenow', String(value))
    element.setAttribute('aria-valuetext', formatMemoryLabel(value))
}

function updateMemoryBarColor(element, value){
    const bar = element.getElementsByClassName('rangeSliderBar')[0]
    const total = os.totalmem()/1073741824
    if(value >= total/2){
        bar.style.background = '#e86060'
    } else if(value >= total/4){
        bar.style.background = '#e8e18b'
    } else {
        bar.style.background = null
    }
}

function refreshLandingJavaMemoryPresentation(changedElement = null){
    let minValue = normalizeSliderValue(settingsMinRAMRange, settingsMinRAMRange.getAttribute('value'))
    let maxValue = normalizeSliderValue(settingsMaxRAMRange, settingsMaxRAMRange.getAttribute('value'))

    if(minValue > maxValue){
        if(changedElement === settingsMaxRAMRange){
            minValue = maxValue
            settingsMinRAMRange.setAttribute('value', String(minValue))
        } else {
            maxValue = minValue
            settingsMaxRAMRange.setAttribute('value', String(maxValue))
        }
    }

    settingsMinRAMRange.setAttribute('value', String(minValue))
    settingsMaxRAMRange.setAttribute('value', String(maxValue))
    settingsMinRAMLabel.textContent = formatMemoryLabel(minValue)
    settingsMaxRAMLabel.textContent = formatMemoryLabel(maxValue)
    updateMemoryBarColor(settingsMinRAMRange, minValue)
    updateMemoryBarColor(settingsMaxRAMRange, maxValue)
    updateRangeSliderVisual(settingsMinRAMRange)
    updateRangeSliderVisual(settingsMaxRAMRange)
}

function setLandingJavaSliderValue(element, value, userInitiated = false){
    element.setAttribute('value', String(normalizeSliderValue(element, value)))
    refreshLandingJavaMemoryPresentation(element)
    if(userInitiated){
        landingJavaState.memoryDirty = true
    }
}

function setSliderValueFromPointer(element, event){
    const rect = element.getBoundingClientRect()
    const thumb = element.getElementsByClassName('rangeSliderTrack')[0]
    const thumbWidth = thumb.offsetWidth || 10
    const usableWidth = Math.max(1, rect.width-thumbWidth)
    const localX = Math.min(usableWidth, Math.max(0, event.clientX-rect.left-thumbWidth/2))
    const meta = getRangeSliderMeta(element)
    setLandingJavaSliderValue(element, meta.min+(localX/usableWidth)*meta.range, true)
}

function bindLandingJavaRangeSlider(element){
    let activePointer = null

    element.addEventListener('pointerdown', event => {
        if(event.button !== 0){
            return
        }
        event.preventDefault()
        activePointer = event.pointerId
        element.focus()
        element.setPointerCapture(event.pointerId)
        setSliderValueFromPointer(element, event)
    })

    element.addEventListener('pointermove', event => {
        if(activePointer !== event.pointerId){
            return
        }
        event.preventDefault()
        setSliderValueFromPointer(element, event)
    })

    const finishPointer = event => {
        if(activePointer !== event.pointerId){
            return
        }
        if(event.type === 'pointerup'){
            setSliderValueFromPointer(element, event)
        }
        if(element.hasPointerCapture(event.pointerId)){
            element.releasePointerCapture(event.pointerId)
        }
        activePointer = null
        commitLandingJavaView()
    }
    element.addEventListener('pointerup', finishPointer)
    element.addEventListener('pointercancel', finishPointer)

    element.addEventListener('keydown', event => {
        if(!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)){
            return
        }
        event.preventDefault()
        const meta = getRangeSliderMeta(element)
        const current = Number(element.getAttribute('value'))
        const pageStep = Math.max(meta.step, meta.range/10)
        let value = current
        if(event.key === 'Home'){
            value = meta.min
        } else if(event.key === 'End'){
            value = meta.max
        } else if(event.key === 'PageDown'){
            value -= pageStep
        } else if(event.key === 'PageUp'){
            value += pageStep
        } else if(event.key === 'ArrowLeft' || event.key === 'ArrowDown'){
            value -= meta.step
        } else {
            value += meta.step
        }
        setLandingJavaSliderValue(element, value, true)
        commitLandingJavaView()
    })
}

function populateLandingJavaMemoryStatus(){
    settingsMemoryTotal.textContent = `${(os.totalmem()/1073741824).toFixed(1)}G`
    settingsMemoryAvail.textContent = `${(os.freemem()/1073741824).toFixed(1)}G`
}

function populateLandingJavaRequirement(server){
    const major = server.effectiveJavaOptions.suggestedMajor
    settingsJavaReqDesc.textContent = Lang.queryJS('landing.java.requiresJava', { major })
    settingsJvmOptsLink.textContent = Lang.queryJS('landing.java.availableOptions', { major })
    if(major >= 12){
        settingsJvmOptsLink.href = `https://docs.oracle.com/en/java/javase/${major}/docs/specs/man/java.html#extra-options-for-java`
    } else if(major >= 11){
        settingsJvmOptsLink.href = 'https://docs.oracle.com/en/java/javase/11/tools/java.html#GUID-3B1CE181-CD30-4178-9602-230B800D4FAE'
    } else if(major >= 9){
        settingsJvmOptsLink.href = `https://docs.oracle.com/javase/${major}/tools/java.htm`
    } else {
        settingsJvmOptsLink.href = `https://docs.oracle.com/javase/${major}/docs/technotes/tools/${process.platform === 'win32' ? 'windows' : 'unix'}/java.html`
    }
}

async function populateJavaExecDetails(execPath, server = null, requestSequence = landingJavaState.requestSequence){
    if(execPath == null || String(execPath).trim().length === 0){
        if(requestSequence === landingJavaState.requestSequence){
            settingsJavaExecDetails.textContent = Lang.queryJS('landing.java.notConfigured')
        }
        return null
    }

    try {
        const selectedServer = server ?? (await DistroAPI.getDistribution()).getServerById(landingJavaState.serverId ?? ConfigManager.getSelectedServer())
        if(selectedServer == null){
            return null
        }
        const details = await validateSelectedJvm(ensureJavaDirIsRoot(execPath), selectedServer.effectiveJavaOptions.supported)
        if(requestSequence !== landingJavaState.requestSequence){
            return null
        }
        settingsJavaExecDetails.textContent = details == null
            ? Lang.queryJS('landing.java.invalidSelection')
            : Lang.queryJS('landing.java.selectedJava', { version: details.semverStr, vendor: details.vendor })
        return details
    } catch(err) {
        landingJavaLogger.warn('Failed to validate the selected Java executable.', err)
        if(requestSequence === landingJavaState.requestSequence){
            settingsJavaExecDetails.textContent = Lang.queryJS('landing.java.invalidSelection')
        }
        return null
    }
}

function restoreLandingJavaValues(serverId, previous){
    if(previous.minRAM != null){
        setLandingJavaSliderValue(settingsMinRAMRange, parseMemoryValue(previous.minRAM))
    }
    if(previous.maxRAM != null){
        setLandingJavaSliderValue(settingsMaxRAMRange, parseMemoryValue(previous.maxRAM))
    }
    if(previous.jvmOptions != null){
        settingsJVMOptsVal.value = previous.jvmOptions.join(' ')
    }
    try {
        ConfigManager.setMinRAM(serverId, previous.minRAM)
        ConfigManager.setMaxRAM(serverId, previous.maxRAM)
        ConfigManager.setJVMOptions(serverId, previous.jvmOptions)
    } catch(err) {
        landingJavaLogger.error('Failed to restore Java configuration in memory.', err)
    }
}

function commitLandingJavaView(showError = true){
    if(!landingJavaState.ready || (!landingJavaState.memoryDirty && !landingJavaState.jvmDirty)){
        return true
    }

    const serverId = landingJavaState.serverId
    const previous = {
        minRAM: ConfigManager.getMinRAM(serverId),
        maxRAM: ConfigManager.getMaxRAM(serverId),
        jvmOptions: [...ConfigManager.getJVMOptions(serverId)]
    }

    try {
        if(landingJavaState.memoryDirty){
            ConfigManager.setMinRAM(serverId, formatMemoryConfigValue(settingsMinRAMRange.getAttribute('value')))
            ConfigManager.setMaxRAM(serverId, formatMemoryConfigValue(settingsMaxRAMRange.getAttribute('value')))
        }
        if(landingJavaState.jvmDirty){
            const value = settingsJVMOptsVal.value.trim()
            ConfigManager.setJVMOptions(serverId, value.length === 0 ? [] : value.split(/\s+/))
        }
        ConfigManager.save()
        landingJavaState.memoryDirty = false
        landingJavaState.jvmDirty = false
        return true
    } catch(err) {
        landingJavaLogger.error('Failed to save the Java configuration.', err)
        restoreLandingJavaValues(serverId, previous)
        landingJavaState.memoryDirty = false
        landingJavaState.jvmDirty = false
        if(showError){
            showLandingJavaError(
                Lang.queryJS('landing.java.saveFailedTitle'),
                Lang.queryJS('landing.java.saveFailedMessage')
            )
        }
        return false
    }
}

async function prepareLandingJavaView(){
    const requestSequence = ++landingJavaState.requestSequence
    landingJavaState.ready = false
    landingJavaState.serverId = null
    landingJavaState.memoryDirty = false
    landingJavaState.jvmDirty = false
    settingsJavaExecSel.disabled = true
    settingsJVMOptsVal.disabled = true
    showLandingJavaStatus(Lang.queryJS('landing.java.loading'))

    const selectedServerId = ConfigManager.getSelectedServer()
    if(selectedServerId == null){
        showLandingJavaStatus(Lang.queryJS('landing.java.noServer'))
        return
    }

    try {
        const server = (await DistroAPI.getDistribution()).getServerById(selectedServerId)
        if(requestSequence !== landingJavaState.requestSequence){
            return
        }
        if(server == null){
            showLandingJavaStatus(Lang.queryJS('landing.java.noServer'))
            return
        }

        landingJavaState.serverId = selectedServerId
        renderLandingJavaServer(server)
        const minimum = ConfigManager.getAbsoluteMinRAM(server.rawServer.javaOptions?.ram)
        const maximum = Math.max(minimum, ConfigManager.getAbsoluteMaxRAM(server.rawServer.javaOptions?.ram))
        for(const slider of [settingsMinRAMRange, settingsMaxRAMRange]){
            slider.setAttribute('min', String(minimum))
            slider.setAttribute('max', String(maximum))
        }
        setLandingJavaSliderValue(settingsMinRAMRange, parseMemoryValue(ConfigManager.getMinRAM(selectedServerId)))
        setLandingJavaSliderValue(settingsMaxRAMRange, parseMemoryValue(ConfigManager.getMaxRAM(selectedServerId)))
        populateLandingJavaMemoryStatus()
        populateLandingJavaRequirement(server)
        settingsJavaExecVal.value = ConfigManager.getJavaExecutable(selectedServerId) ?? ''
        settingsJVMOptsVal.value = (ConfigManager.getJVMOptions(selectedServerId) ?? []).join(' ')
        await populateJavaExecDetails(settingsJavaExecVal.value, server, requestSequence)
        if(requestSequence !== landingJavaState.requestSequence){
            return
        }

        landingJavaState.ready = true
        settingsJavaExecSel.disabled = false
        settingsJVMOptsVal.disabled = false
        landingJavaStatus.hidden = true
        landingJavaContent.hidden = false
        requestAnimationFrame(() => refreshLandingJavaMemoryPresentation())
    } catch(err) {
        if(requestSequence !== landingJavaState.requestSequence){
            return
        }
        landingJavaLogger.error('Failed to prepare the Java view.', err)
        showLandingJavaStatus(Lang.queryJS('landing.java.loadFailed'), true)
    }
}

function invalidateLandingJavaView(){
    landingJavaState.requestSequence++
    landingJavaState.ready = false
    landingJavaState.serverId = null
    landingJavaState.memoryDirty = false
    landingJavaState.jvmDirty = false
}

async function syncLandingJavaExecutable(serverId, execPath){
    if(landingJavaState.serverId !== serverId){
        return
    }
    const requestSequence = landingJavaState.requestSequence
    settingsJavaExecVal.value = execPath ?? ''
    const server = (await DistroAPI.getDistribution()).getServerById(serverId)
    if(requestSequence !== landingJavaState.requestSequence || server == null){
        return
    }
    await populateJavaExecDetails(execPath, server, requestSequence)
}

settingsJavaExecSel.addEventListener('click', async () => {
    if(!landingJavaState.ready){
        return
    }
    const options = {
        title: settingsJavaExecSel.getAttribute('dialogTitle'),
        properties: ['openFile']
    }
    if(process.platform === 'win32'){
        options.filters = [
            { name: Lang.queryJS('landing.java.executables'), extensions: ['exe'] },
            { name: Lang.queryJS('landing.java.allFiles'), extensions: ['*'] }
        ]
    }
    const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), options)
    if(result.canceled || result.filePaths.length === 0){
        return
    }

    const serverId = landingJavaState.serverId
    const requestSequence = landingJavaState.requestSequence
    const previous = ConfigManager.getJavaExecutable(serverId)
    const candidate = result.filePaths[0]
    const server = (await DistroAPI.getDistribution()).getServerById(serverId)
    if(requestSequence !== landingJavaState.requestSequence || server == null){
        return
    }
    settingsJavaExecVal.value = candidate
    settingsJavaExecDetails.textContent = Lang.queryJS('landing.java.validating')
    const details = await populateJavaExecDetails(candidate, server, requestSequence)
    if(requestSequence !== landingJavaState.requestSequence){
        return
    }
    if(details == null){
        showLandingJavaError(
            Lang.queryJS('landing.java.invalidTitle'),
            Lang.queryJS('landing.java.invalidMessage'),
            settingsJavaExecSel
        )
        return
    }

    try {
        ConfigManager.setJavaExecutable(serverId, candidate)
        ConfigManager.save()
    } catch(err) {
        landingJavaLogger.error('Failed to save the selected Java executable.', err)
        ConfigManager.setJavaExecutable(serverId, previous)
        settingsJavaExecVal.value = previous ?? ''
        await populateJavaExecDetails(previous, server, requestSequence)
        showLandingJavaError(
            Lang.queryJS('landing.java.saveFailedTitle'),
            Lang.queryJS('landing.java.saveFailedMessage'),
            settingsJavaExecSel
        )
    }
})

settingsJVMOptsVal.addEventListener('input', () => {
    if(landingJavaState.ready){
        landingJavaState.jvmDirty = true
    }
})
settingsJVMOptsVal.addEventListener('blur', () => commitLandingJavaView())

bindLandingJavaRangeSlider(settingsMinRAMRange)
bindLandingJavaRangeSlider(settingsMaxRAMRange)

if(typeof ResizeObserver === 'function'){
    const landingJavaSliderResizeObserver = new ResizeObserver(() => refreshLandingJavaMemoryPresentation())
    landingJavaSliderResizeObserver.observe(settingsMinRAMRange)
    landingJavaSliderResizeObserver.observe(settingsMaxRAMRange)
}

landingJavaRetryButton.onclick = () => prepareLandingJavaView()

window.addEventListener('beforeunload', event => {
    if(!commitLandingJavaView(false)){
        event.preventDefault()
        event.returnValue = false
    }
})
