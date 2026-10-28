const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

// Shared by the settings page and the distribution startup error dialog.
class LauncherUpdateController {
    constructor({ send, onChange, enabled = true, platform = process.platform, schedule = (callback, delay) => setInterval(callback, delay), cancel = timer => clearInterval(timer) }) {
        Object.assign(this, { send, onChange, enabled, platform, schedule, cancel })
        this.initialized = false
        this.ready = false
        this.timer = null
        this.state = { status: enabled ? 'idle' : 'disabled', info: null, error: null }
    }

    initialize(allowPrerelease) {
        if(!this.enabled || this.initialized) {
            return
        }
        this.initialized = true
        this.send('initAutoUpdater', allowPrerelease)
    }

    setState(status, info = this.state.info, error = null) {
        this.state = { status, info, error }
        this.onChange(this.state)
    }

    check() {
        if(!this.enabled || !this.ready || ['checking', 'downloading', 'downloaded', 'installing'].includes(this.state.status)) {
            return false
        }
        this.setState('checking', null)
        this.send('checkForUpdate')
        return true
    }

    install() {
        if(this.state.status !== 'downloaded') {
            return
        }
        this.setState('installing')
        this.send('installUpdateNow')
    }

    receive(event, info) {
        if(!this.enabled) {
            return
        }
        switch(event) {
            case 'ready':
                if(this.ready) {
                    return
                }
                this.ready = true
                this.timer = this.schedule(() => this.check(), UPDATE_CHECK_INTERVAL_MS)
                this.check()
                break
            case 'checking-for-update':
                this.setState('checking', null)
                break
            case 'update-available':
                this.setState(this.platform === 'darwin' ? 'available' : 'downloading', info)
                break
            case 'update-downloaded':
                this.setState('downloaded', info)
                break
            case 'update-not-available':
                this.setState('current', null)
                break
            case 'realerror':
                this.setState(['installing', 'downloaded'].includes(this.state.status) ? 'downloaded' : 'error', this.state.info, info)
                break
        }
    }

    dispose() {
        if(this.timer != null) {
            this.cancel(this.timer)
            this.timer = null
        }
    }
}

exports.LauncherUpdateController = LauncherUpdateController
exports.UPDATE_CHECK_INTERVAL_MS = UPDATE_CHECK_INTERVAL_MS
