class DiscordPresenceController {

    constructor(wrapper) {
        this.wrapper = wrapper
        this.active = false
    }

    initialize(enabled, generalSettings, serverSettings) {
        if(!enabled || generalSettings == null || serverSettings == null) {
            return false
        }
        this.wrapper.initRPC(generalSettings, serverSettings)
        this.active = true
        return true
    }

    isActive() {
        return this.active
    }

    updateDetails(details) {
        if(this.active) {
            this.wrapper.updateDetails(details)
        }
    }

    bindProcess(process, onClose) {
        process.once('close', () => {
            const wasActive = this.shutdown()
            onClose(wasActive)
        })
    }

    shutdown() {
        if(!this.active) {
            return false
        }
        this.wrapper.shutdownRPC()
        this.active = false
        return true
    }
}

exports.DiscordPresenceController = DiscordPresenceController
