const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ServerGroups = require('../app/assets/js/servergroups')
const { normalizeRemoteImageSource, serverImageIdentity } = require('../app/assets/js/serverimagecache')
const { ServerBackgroundPool } = require('../app/assets/js/serverbackgroundpool')

const landingSource = readFileSync(join(__dirname, '../app/assets/js/scripts/landing.js'), 'utf8')

// Exercise the real renderer functions without starting its login/download initialization.
const functions = ['normalizeHeroCopy', 'setServerSidebarState', 'updateServerSidebarSelection',
    'renderServerSidebar', 'isInvalidRemoteImageSource', 'createServerImageDescriptor',
    'getServerPresentationGroupId', 'getServerImageBindingIdentity', 'reportServerImageFailure',
    'applyServerImageElementSource', 'bindCachedServerImage', 'createHeroBackgroundResource',
    'applyHeroBackgroundAsset', 'preloadServerBackgrounds', 'scheduleServerBackgroundPreload',
    'normalizeHeroVideoDescriptor', 'applyHeroBackground', 'applyServerPresentation', 'updateSelectedServer']
    .map(name => {
        const match = landingSource.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))
        assert.ok(match, `Renderer function ${name} exists`)
        return match[0]
    }).join('\n')

class Element {
    constructor(tag = 'div', mutations = []) {
        this.tagName = tag
        this.children = []
        this.attributes = new Map()
        this.mutations = mutations
        this.style = new Proxy({}, { set: (target, name, value) => {
            mutations.push({ element: this, name, value })
            target[name] = value
            return true
        } })
    }
    set hidden(value) {
        this.mutations.push({ element: this, name: 'hidden', value })
        this.isHidden = value
    }
    get hidden() { return this.isHidden ?? false }
    set src(value) {
        this.setAttribute('src', value)
        const onload = this.onload
        queueMicrotask(() => onload?.())
    }
    get src() { return this.getAttribute('src') }
    setAttribute(name, value) {
        this.mutations.push({ element: this, name, value })
        this.attributes.set(name, String(value))
    }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    removeAttribute(name) {
        if(!this.attributes.has(name)) return
        this.mutations.push({ element: this, name, value: null })
        this.attributes.delete(name)
    }
    toggleAttribute(name, enabled) {
        if(this.attributes.has(name) === enabled) return
        if(enabled) this.setAttribute(name, '')
        else this.removeAttribute(name)
    }
    append(...children) { children.forEach(child => this.insertBefore(child, null)) }
    appendChild(child) { this.append(child) }
    insertBefore(child, reference) {
        child.remove()
        const index = reference == null ? this.children.length : this.children.indexOf(reference)
        this.children.splice(index, 0, child)
        child.parent = this
        this.mutations.push({ element: this, name: 'insert', value: child })
    }
    remove() {
        if(this.parent) {
            this.parent.children.splice(this.parent.children.indexOf(this), 1)
            this.parent = null
        }
    }
    get lastElementChild() { return this.children.at(-1) }
    getElementsByClassName(name) {
        return this.children.flatMap(child => [
            ...(child.className === name ? [child] : []), ...child.getElementsByClassName(name)
        ])
    }
    querySelector(selector) { return this.getElementsByClassName(selector.slice(1))[0] ?? null }
    focus() { this.focused = true }
}

function fixture() {
    const hero = { background: 'https://cdn.example.test/background.png', logo: 'https://cdn.example.test/logo.png',
        title: 'Survival', video: { type: 'youtube', videoId: 'abcdefghijk' } }
    const raw = [
        { id: 'stable', version: '1', minecraftVersion: '1.20.1', name: 'Survival', icon: 'https://cdn.example.test/default.png', ui: { hero } },
        { id: 'beta', version: '2', minecraftVersion: '1.21.1', name: 'Survival', icon: 'https://cdn.example.test/beta.png', ui: { hero: { ...hero } } },
        { id: 'creative', version: '1', minecraftVersion: '1.21.1', name: 'Creative', ui: { hero: { ...hero, title: 'Creative', logo: 'https://cdn.example.test/creative.png', background: 'https://cdn.example.test/creative-background.png' } } }
    ]
    return {
        servers: raw.map(rawServer => ({ rawServer })),
        rawDistribution: { serverGroups: [
            { id: 'survival', name: 'Survival', icon: 'https://cdn.example.test/group.png', defaultVersionId: 'stable', versionIds: ['stable', 'beta'] },
            { id: 'creative-group', name: 'Creative', defaultVersionId: 'creative', versionIds: ['creative'] }
        ] }
    }
}

function harness(resolveImage, loadImage) {
    const mutations = []
    const media = []
    const warnings = []
    const requests = []
    const timers = []
    let animations = 0
    let selectedId = 'stable'
    const remembered = {}
    const elements = Object.fromEntries(['serverSidebarList', 'selectedServerIcon', 'selectedServerName',
        'selectedServerVersion', 'launcherGameEyebrow', 'launcherHero', 'launcherHeroLogo',
        'launcherHeroContent', 'launcherHeroWordmark', 'launcherHeroTagline', 'newsPreviewTitle']
        .map(name => [name, new Element('div', mutations)]))
    elements.launcherHeroContent.hidden = true
    const distro = fixture()
    const context = vm.createContext({
        ...elements, ServerGroups, normalizeRemoteImageSource, serverImageIdentity, NodeURL: URL,
        landingDistribution: distro, heroPresentationSequence: 0, heroTransitionSequence: 0, serverBackgroundPreloadSequence: 0,
        heroPresentationId: null, heroMediaIdentity: null, heroBackgroundBinding: null,
        heroBackgroundUrl: 'default.jpg', serverImageBindings: new WeakMap(), reportedServerImageFailures: new WeakSet(),
        defaultServerPresentation: { background: 'default.jpg', eyebrow: 'Minecraft', newsTitle: 'News' },
        serverImageCache: {
            resolve: async descriptor => {
                requests.push(descriptor)
                return resolveImage ? resolveImage(descriptor) : { currentUrl: `maplecraft-image://${descriptor.source}`, refresh: null }
            },
            invalidate: async descriptor => { warnings.push(['invalidated', descriptor]) }
        },
        document: { createElement: tag => new Element(tag, mutations) },
        Image: class extends Element { constructor() { super('img', mutations) } },
        requestAnimationFrame: callback => callback(),
        setTimeout: (callback, delay) => {
            timers.push({ callback, delay })
            return delay === 200 ? 0 : setTimeout(callback, delay)
        }, clearTimeout,
        loggerLanding: { warn: (...args) => warnings.push(args) },
        configureHeroMedia: (...args) => media.push(args),
        playHeroPresentationEnter: () => { animations++ },
        serverLandingSections: new Set(['play', 'mods', 'java']),
        getLandingSection: () => 'play', getCurrentView: () => 'landing', VIEWS: { settings: 'settings', landing: 'landing' },
        Lang: { queryJS: key => key }, launchInProgress: false,
        ConfigManager: {
            getSelectedServer: () => selectedId, setSelectedServer: id => { selectedId = id },
            getSelectedServerVersions: () => remembered,
            setSelectedServerVersion: (group, id) => { remembered[group] = id }, save() {}
        },
        invalidateLandingModsView() {}, invalidateLandingJavaView() {}, closeVersionMenu() {},
        setActiveServerStatusServer() {}, setLaunchEnabled() {}, initGlobalNews() {}, initServerNews() {}
    })
    vm.runInContext(functions, context)
    const pool = new ServerBackgroundPool({
        cache: context.serverImageCache,
        loadImage: loadImage ?? (async source => ({ source })),
        onUpdate: context.applyHeroBackgroundAsset,
        onError: error => warnings.push(['Unable to prepare background', error])
    })
    context.serverBackgroundPool = pool
    const settle = async () => { await new Promise(resolve => setImmediate(resolve)) }
    const select = async index => {
        context.updateSelectedServer(distro.servers[index])
        context.renderServerSidebar(distro)
        await settle()
    }
    return { context, distro, elements, mutations, media, warnings, requests, timers, pool, select, settle, animations: () => animations }
}

test('A → B → A preserves sidebar nodes, all displayed images, animations and video initialization', async () => {
    const h = harness()
    await h.select(0)
    const items = [...h.elements.serverSidebarList.children]
    const icons = items.map(item => item.querySelector('.serverSidebarIcon'))
    assert.equal(h.elements.launcherHeroContent.hidden, false)
    assert.equal(h.animations(), 1)
    for(const index of [1, 0]) {
        h.mutations.length = 0
        await h.select(index)
        assert.deepEqual(h.elements.serverSidebarList.children, items)
        assert.deepEqual(items.map(item => item.querySelector('.serverSidebarIcon')), icons)
        assert.equal(items[0].getAttribute('servid'), h.distro.servers[index].rawServer.id)
        assert.equal(items[0].querySelector('.serverSidebarVersion').textContent, h.distro.servers[index].rawServer.version)
        assert.equal(h.elements.selectedServerVersion.textContent, `${h.distro.servers[index].rawServer.minecraftVersion} · ${h.distro.servers[index].rawServer.version}`)
        assert.equal(h.mutations.filter(event => ['src', 'visibility', 'backgroundImage', 'changing', 'hidden', 'insert'].includes(event.name)).length, 0)
        assert.equal(h.animations(), 1)
        assert.equal(h.media.length, 1)
    }
    assert.ok(icons[0].src.includes('/group.png'))
    assert.equal(h.elements.selectedServerIcon.src, icons[0].src)
})

test('switching versions during image resolution reuses pending work and its load callbacks', async () => {
    const pending = new Map()
    const h = harness(descriptor => ({ currentUrl: null, refresh: new Promise(resolve => pending.set(descriptor.type, resolve)) }))
    const first = h.context.applyServerPresentation(h.distro.servers[0])
    const second = h.context.applyServerPresentation(h.distro.servers[1])
    await h.settle()
    assert.equal(h.requests.length, 2)
    assert.equal(h.media.length, 1)
    pending.get('logo')('maplecraft-image://logo')
    pending.get('background')('maplecraft-image://background')
    await Promise.all([first, second])
    await h.settle()
    assert.equal(h.elements.launcherHeroLogo.src, 'maplecraft-image://logo')
    assert.equal(h.elements.launcherHeroContent.hidden, false)
    assert.equal(h.animations(), 1)
})

test('late images from another group cannot replace the newest selection', async () => {
    const pending = []
    const h = harness(descriptor => ({ currentUrl: null, refresh: new Promise(resolve => pending.push({ descriptor, resolve })) }))
    const selections = [0, 2, 1].map(index => h.context.applyServerPresentation(h.distro.servers[index]))
    await h.settle()
    for(const request of pending.filter(request => request.descriptor.groupId === 'survival')) {
        request.resolve(`maplecraft-image://survival/${request.descriptor.type}`)
    }
    await h.settle()
    for(const request of pending.filter(request => request.descriptor.groupId !== 'survival')) {
        request.resolve(`maplecraft-image://creative/${request.descriptor.type}`)
    }
    await Promise.all(selections)
    assert.equal(h.elements.launcherHeroLogo.src, 'maplecraft-image://survival/logo')
    assert.equal(h.elements.launcherHero.style.backgroundImage, 'url("maplecraft-image://survival/background")')
    assert.equal(h.elements.launcherHeroWordmark.textContent, 'Survival')
    assert.equal(h.media.length, 3)
})

test('text and background updates do not rebind the unchanged logo or restart video', async () => {
    const h = harness()
    await h.select(0)
    h.mutations.length = 0
    h.distro.servers[0].rawServer.ui.hero = { ...h.distro.servers[0].rawServer.ui.hero,
        title: 'New title', background: 'https://cdn.example.test/new-background.png' }
    await h.context.applyServerPresentation(h.distro.servers[0])
    assert.equal(h.elements.launcherHeroWordmark.textContent, 'New title')
    assert.ok(h.elements.launcherHero.style.backgroundImage.includes('/new-background.png'))
    assert.equal(h.mutations.filter(event => event.element === h.elements.launcherHeroLogo && ['src', 'visibility'].includes(event.name)).length, 0)
    assert.equal(h.media.length, 1)
    assert.equal(h.animations(), 1)
    await h.context.applyServerPresentation(h.distro.servers[2])
    assert.equal(h.media.length, 2)
    assert.ok(h.mutations.some(event => event.name === 'changing'))
})

test('unchanged refresh results and offline revalidation leave displayed images visible', async () => {
    let offline = false
    const h = harness(descriptor => {
        const url = `maplecraft-image://${descriptor.type}`
        return { currentUrl: url, refresh: offline ? Promise.reject(new Error('offline')) : Promise.resolve(url) }
    })
    await h.select(0)
    h.mutations.length = 0
    offline = true
    await h.select(1)
    assert.equal(h.elements.launcherHeroContent.hidden, false)
    assert.equal(h.mutations.filter(event => ['src', 'visibility', 'backgroundImage', 'changing', 'hidden'].includes(event.name)).length, 0)
    assert.equal(h.animations(), 1)
    assert.ok(h.warnings.some(warning => String(warning[0]).includes('Unable to cache')))
})

test('sidebar reordering, removal and refreshed click handlers retain the correct group nodes', async () => {
    const h = harness()
    await h.select(0)
    const [survival, creative] = h.elements.serverSidebarList.children
    h.distro.rawDistribution.serverGroups.reverse()
    h.context.renderServerSidebar(h.distro)
    assert.deepEqual(h.elements.serverSidebarList.children, [creative, survival])
    h.distro.rawDistribution.serverGroups.pop()
    h.distro.servers = h.distro.servers.filter(server => server.rawServer.id === 'creative')
    h.context.renderServerSidebar(h.distro)
    assert.deepEqual(h.elements.serverSidebarList.children, [creative])
})

test('local, missing and invalid image sources retain their fallback behavior', async () => {
    const h = harness()
    const icon = h.elements.selectedServerIcon
    h.context.bindCachedServerImage(icon, null, 'icon', 'assets/local.png')
    await h.settle()
    h.mutations.length = 0
    h.context.bindCachedServerImage(icon, null, 'icon', 'assets/local.png')
    assert.equal(h.mutations.length, 0)
    h.context.bindCachedServerImage(icon, null, 'icon', 'https://user:password@example.test/image.png')
    assert.equal(icon.src, null)
    assert.equal(icon.style.visibility, 'hidden')
    h.context.bindCachedServerImage(icon, null, 'icon', null)
    assert.equal(icon.src, null)
    assert.equal(h.requests.length, 0)
})

test('preloaded backgrounds switch synchronously across groups without loading images again', async () => {
    const loaded = []
    const h = harness(null, async source => { loaded.push(source); return { source } })
    await h.context.preloadServerBackgrounds(h.distro)
    assert.equal(loaded.length, 2)
    assert.equal(h.requests.filter(descriptor => descriptor.type === 'background').length, 2)
    for(const index of [0, 2, 0]) {
        const selecting = h.context.applyServerPresentation(h.distro.servers[index])
        const source = h.distro.servers[index].rawServer.ui.hero.background
        assert.equal(h.elements.launcherHero.style.backgroundImage, `url("maplecraft-image://${source}")`)
        await selecting
    }
    assert.equal(loaded.length, 2)
    assert.equal(h.timers.filter(timer => timer.delay === 200).length, 3)
    assert.equal(h.animations(), 3)
    assert.equal(h.media.length, 3)
})

test('an uncached background keeps the displayed image until the requested image is ready', async () => {
    let completeDownload
    const h = harness(descriptor => {
        if(descriptor.type === 'background' && descriptor.groupId === 'creative-group') {
            return { currentUrl: null, refresh: new Promise(resolve => { completeDownload = resolve }) }
        }
        return { currentUrl: `maplecraft-image://${descriptor.source}`, refresh: null }
    })
    await h.select(0)
    const previous = h.elements.launcherHero.style.backgroundImage
    h.mutations.length = 0
    const selecting = h.context.applyServerPresentation(h.distro.servers[2])
    await h.settle()
    assert.equal(h.elements.launcherHero.style.backgroundImage, previous)
    assert.equal(h.mutations.filter(event => event.name === 'backgroundImage').length, 0)
    completeDownload('maplecraft-image://creative/background')
    await selecting
    assert.equal(h.elements.launcherHero.style.backgroundImage, 'url("maplecraft-image://creative/background")')
    assert.equal(h.mutations.filter(event => event.name === 'backgroundImage').length, 1)
})

test('distribution updates release obsolete decoded backgrounds and prepare new sources', async () => {
    const h = harness()
    await h.context.preloadServerBackgrounds(h.distro)
    const old = h.context.createHeroBackgroundResource(h.distro.servers[0].rawServer,
        h.distro.servers[0].rawServer.ui.hero.background)
    assert.ok(h.pool.get(old.key))
    h.distro.servers[0].rawServer.ui.hero.background = 'https://cdn.example.test/updated.png'
    h.distro.servers[1].rawServer.ui.hero.background = 'https://cdn.example.test/updated.png'
    await h.context.preloadServerBackgrounds(h.distro)
    assert.equal(h.pool.get(old.key), null)
    const selecting = h.context.applyServerPresentation(h.distro.servers[1])
    assert.equal(h.elements.launcherHero.style.backgroundImage, 'url("maplecraft-image://https://cdn.example.test/updated.png")')
    await selecting
    assert.equal(h.warnings.length, 0)
})

test('failed background decoding keeps the previous background and does not delete cache files', async () => {
    const h = harness(null, async source => {
        if(source.includes('creative-background')) throw new Error('decode failed')
        return { source }
    })
    await h.select(0)
    const previous = h.elements.launcherHero.style.backgroundImage
    await h.context.applyServerPresentation(h.distro.servers[2])
    assert.equal(h.elements.launcherHero.style.backgroundImage, previous)
    assert.ok(h.warnings.some(warning => warning[1]?.message === 'decode failed'))
    assert.equal(h.warnings.some(warning => warning[0] === 'invalidated'), false)
})

test('scheduled preloading ignores an obsolete distribution snapshot', async () => {
    const h = harness()
    const frames = []
    h.context.requestAnimationFrame = callback => frames.push(callback)
    h.context.scheduleServerBackgroundPreload(h.distro)
    const replacement = fixture()
    replacement.servers[0].rawServer.ui.hero.background = 'https://cdn.example.test/latest.png'
    h.context.landingDistribution = replacement
    h.context.scheduleServerBackgroundPreload(replacement)
    frames[0]()
    assert.equal(h.requests.length, 0)
    frames[1]()
    await h.settle()
    assert.ok(h.requests.some(descriptor => descriptor.source.includes('/latest.png')))
})
