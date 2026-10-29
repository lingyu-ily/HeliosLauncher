// Keep Helios' server IDs as instance IDs; groups only affect navigation.
function getServerGroups(distribution) {
    const servers = distribution.servers ?? []
    const byId = new Map(servers.map(server => [server.rawServer.id, server]))
    const declared = distribution.rawDistribution?.serverGroups
    if(!Array.isArray(declared)) {
        return servers.map(server => ({
            id: server.rawServer.id, name: server.rawServer.name, icon: server.rawServer.icon,
            defaultVersionId: server.rawServer.id, versions: [server]
        }))
    }
    return declared.map(group => ({ ...group, versions: group.versionIds.map(id => byId.get(id)).filter(Boolean) }))
}

function getServerGroup(distribution, versionId) {
    return getServerGroups(distribution).find(group => group.versions.some(server => server.rawServer.id === versionId))
}

function selectGroupVersion(group, rememberedId) {
    return group.versions.find(server => server.rawServer.id === rememberedId)
        ?? group.versions.find(server => server.rawServer.id === group.defaultVersionId)
        ?? group.versions[0]
}

function getGroupIcon(group) {
    return typeof group.icon === 'string' && group.icon.trim()
        ? group.icon.trim()
        : selectGroupVersion(group, group.defaultVersionId)?.rawServer.icon
}

function resolveSelectedVersion(distribution, selectedId, remembered = {}) {
    const groups = getServerGroups(distribution)
    const current = getServerGroup(distribution, selectedId)
    if(current) return selectGroupVersion(current, selectedId)
    const rememberedGroup = groups.find(group => Object.hasOwn(remembered, group.id) && remembered[group.id] === selectedId)
    const main = getServerGroup(distribution, distribution.getMainServer()?.rawServer.id)
    const group = rememberedGroup ?? main ?? groups[0]
    return group ? selectGroupVersion(group, remembered[group.id]) : null
}

function validateServerGroups(distribution) {
    if(distribution.serverGroups == null) return
    if(!Array.isArray(distribution.serverGroups) || distribution.serverGroups.length === 0) {
        throw new Error('Invalid server groups.')
    }
    const available = new Set(distribution.servers.map(server => server.id))
    const assigned = new Set()
    const groups = new Set()
    for(const group of distribution.serverGroups) {
        if(!group || typeof group.id !== 'string' || !group.id || groups.has(group.id)
            || typeof group.name !== 'string' || !group.name || !Array.isArray(group.versionIds)
            || group.versionIds.length === 0 || !group.versionIds.includes(group.defaultVersionId)) {
            throw new Error('Invalid server group.')
        }
        groups.add(group.id)
        for(const id of group.versionIds) {
            if(!available.has(id) || assigned.has(id)) throw new Error('Invalid server group version reference.')
            assigned.add(id)
        }
    }
    if(assigned.size !== available.size) throw new Error('Ungrouped distribution version.')
}

function getLoaderLabel(rawServer, vanillaLabel = 'Vanilla') {
    const supplied = typeof rawServer.loaderLabel === 'string' ? rawServer.loaderLabel.trim() : ''
    if(supplied) return supplied === 'Vanilla' ? vanillaLabel : supplied
    const loader = rawServer.modules?.find(module => ['Forge', 'ForgeHosted', 'Fabric'].includes(module.type))
    if(!loader) return vanillaLabel
    const name = loader.type === 'Fabric' ? 'Fabric' : 'Forge'
    let version = typeof loader.id === 'string' ? loader.id.split(':')[2] : null
    if(version && name === 'Forge') {
        const prefix = rawServer.minecraftVersion + '-'
        if(version.startsWith(prefix)) version = version.slice(prefix.length)
    }
    return version ? name + ' ' + version : name
}

module.exports = { getGroupIcon, getLoaderLabel, getServerGroups, getServerGroup, selectGroupVersion, resolveSelectedVersion, validateServerGroups }
