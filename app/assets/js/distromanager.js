const ConfigManager = require('./configmanager')
const { LauncherDistributionAPI } = require('./launcherdistributionapi')

// Old WesterosCraft url.
// exports.REMOTE_DISTRO_URL = 'http://mc.westeroscraft.com/WesterosCraftLauncher/distribution.json'
exports.REMOTE_DISTRO_URL = 'https://s3.gfscs.com/mcl/public/maplecraftlauncher/distribution.json'

const api = new LauncherDistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api
