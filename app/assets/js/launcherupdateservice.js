// Keep the update operation alive through the download, not just the feed request.
class LauncherUpdateService {
    constructor(updater) {
        this.updater = updater
        this.initialized = false
        this.busy = false
        this.downloaded = false
        this.notify = () => {}
    }

    initialize(notify) {
        this.notify = notify
        if(this.initialized) {
            return
        }
        this.initialized = true
        for(const event of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded']) {
            this.updater.on(event, info => {
                if(event === 'update-downloaded') {
                    this.downloaded = true
                }
                this.notify(event, info)
            })
        }
        this.updater.on('error', error => this.reportError(error))
    }

    reportError(error) {
        // Error properties are not reliably preserved by Electron IPC cloning.
        this.notify('realerror', { code: error?.code, message: error?.message || String(error) })
    }

    async check() {
        if(!this.initialized || this.busy || this.downloaded) {
            return
        }
        this.busy = true
        try {
            const result = await this.updater.checkForUpdates()
            await result?.downloadPromise
        } catch(error) {
            this.reportError(error)
        } finally {
            this.busy = false
        }
    }

    install() {
        if(this.downloaded) {
            try {
                this.updater.quitAndInstall()
            } catch(error) {
                this.reportError(error)
            }
        }
    }
}

exports.LauncherUpdateService = LauncherUpdateService
