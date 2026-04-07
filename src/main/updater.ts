import { autoUpdater } from 'electron-updater'
import log from './logger'

autoUpdater.logger = log
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableWebInstaller = true

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

let statusCallback: ((status: UpdateStatus) => void) | null = null

autoUpdater.on('checking-for-update', () => {
  statusCallback?.({ type: 'checking' })
})

autoUpdater.on('update-available', (info) => {
  statusCallback?.({ type: 'available', version: info.version })
})

autoUpdater.on('update-not-available', () => {
  statusCallback?.({ type: 'not-available' })
})

autoUpdater.on('download-progress', (progress) => {
  statusCallback?.({ type: 'downloading', percent: progress.percent })
})

autoUpdater.on('update-downloaded', (info) => {
  statusCallback?.({ type: 'downloaded', version: info.version })
})

autoUpdater.on('error', (err) => {
  log.error('Auto-updater error:', err)
  statusCallback?.({ type: 'error', message: err.message })
})

export function onUpdateStatus(cb: (status: UpdateStatus) => void) {
  statusCallback = cb
}

export function checkForAppUpdate() {
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('Check for updates failed:', err)
  })
}

export function downloadAppUpdate() {
  autoUpdater.downloadUpdate().catch((err) => {
    log.error('Download update failed:', err)
  })
}

export function installAppUpdate() {
  autoUpdater.quitAndInstall()
}
