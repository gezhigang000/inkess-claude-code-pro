import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  chmodSync,
  createWriteStream,
  unlinkSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync
} from 'fs'
import { execSync } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import * as os from 'os'
import log from '../logger'
import { fetchWithTimeout, sha256File } from '../utils/fetch'

const MIRROR_BASE_URL =
  'https://inkess-install-file.oss-cn-beijing.aliyuncs.com/cli-mirror'

interface Manifest {
  version: string
  buildDate: string
  platforms: Record<
    string,
    { binary: string; checksum: string; size: number }
  >
}

interface CliInfo {
  installed: boolean
  path: string
  version: string | null
}

export class CliManager {
  private cliDir: string
  private binaryPath: string
  private _cachedInfo: CliInfo | null = null
  private _installing = false

  private get markerPath(): string {
    return join(this.cliDir, '.installed')
  }

  constructor() {
    this.cliDir = join(app.getPath('userData'), 'cli')
    const binaryName = os.platform() === 'win32' ? 'claude.exe' : 'claude'
    this.binaryPath = join(this.cliDir, binaryName)
  }

  getInfo(): CliInfo {
    if (this._cachedInfo) return this._cachedInfo
    // Fast path: if marker exists, skip execSync version check
    if (existsSync(this.markerPath) && existsSync(this.binaryPath)) {
      // Read version from marker file (written at install time)
      let markerVersion: string | null = null
      try {
        const marker = readFileSync(this.markerPath, 'utf-8').trim()
        // Marker format: "version|timestamp" or legacy "timestamp"
        if (marker.includes('|')) {
          markerVersion = marker.split('|')[0]
        }
      } catch { /* ignore */ }
      const info = { installed: true, path: this.binaryPath, version: markerVersion }
      this._cachedInfo = info
      return info
    }
    const installed = existsSync(this.binaryPath)
    let version: string | null = null
    if (installed) {
      try {
        const raw = execSync(`"${this.binaryPath}" --version`, {
          timeout: 5000,
          encoding: 'utf-8'
        }).trim()
        // "2.1.78 (Claude Code)" → "2.1.78"
        const match = raw.match(/^[\d.]+/)
        version = match ? match[0] : raw
      } catch {
        // binary exists but can't get version
      }
    }
    const info = { installed, path: this.binaryPath, version }
    if (installed) this._cachedInfo = info
    return info
  }

  invalidateCache(): void {
    this._cachedInfo = null
  }

  getBinaryPath(): string {
    return this.binaryPath
  }

  isInstalled(): boolean {
    return existsSync(this.binaryPath)
  }

  async checkUpdate(): Promise<{
    available: boolean
    latestVersion: string | null
  }> {
    try {
      const res = await fetchWithTimeout(`${MIRROR_BASE_URL}/latest`)
      if (!res.ok) return { available: false, latestVersion: null }

      const latestVersion = (await res.text()).trim()
      const currentInfo = this.getInfo()

      // If we can't determine current version, don't show update toast
      if (!currentInfo.version)
        return { available: false, latestVersion }

      const strip = (v: string) => v.replace(/^v/, '')
      return {
        available: strip(latestVersion) !== strip(currentInfo.version || ''),
        latestVersion
      }
    } catch {
      return { available: false, latestVersion: null }
    }
  }

  async install(
    onProgress?: (step: string, progress: number) => void
  ): Promise<void> {
    if (this._installing) throw new Error('Installation already in progress')
    this._installing = true
    try {
    if (!existsSync(this.cliDir)) {
      mkdirSync(this.cliDir, { recursive: true })
    }

    const platform = os.platform()
    const arch = os.arch()
    const platformKey = `${platform}-${arch}`

    onProgress?.('Checking latest version...', 0.05)

    // Fetch latest version
    const latestRes = await fetchWithTimeout(`${MIRROR_BASE_URL}/latest`)
    if (!latestRes.ok) {
      throw new Error('Failed to check latest CLI version')
    }
    const version = (await latestRes.text()).trim()
    log.info(`CLI: latest version is ${version}`)

    // Fetch manifest
    onProgress?.('Fetching manifest...', 0.1)
    const manifestRes = await fetchWithTimeout(
      `${MIRROR_BASE_URL}/${version}/manifest.json`
    )
    if (!manifestRes.ok) {
      throw new Error(`Failed to fetch manifest for version ${version}`)
    }
    const manifest: Manifest = await manifestRes.json()

    const platInfo = manifest.platforms[platformKey]
    if (!platInfo) {
      throw new Error(`Your system (${platformKey}) is not supported yet`)
    }

    // Download binary
    const binaryUrl = `${MIRROR_BASE_URL}/${version}/${platformKey}/${platInfo.binary}`
    onProgress?.(`Downloading Claude Code Pro v${version}...`, 0.2)
    log.info(`CLI: downloading ${binaryUrl}`)

    const res = await fetchWithTimeout(binaryUrl, {}, 300000) // 5min for large binary
    if (!res.ok || !res.body) {
      throw new Error(
        `Download failed (HTTP ${res.status}). Please try again later.`
      )
    }

    const tmpPath = this.binaryPath + '.tmp'
    const fileStream = createWriteStream(tmpPath)

    // Track download progress
    const totalSize = platInfo.size
    let downloaded = 0
    const reader = res.body.getReader()
    const progressStream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        downloaded += value.byteLength
        const pct = Math.min(0.2 + (downloaded / totalSize) * 0.6, 0.8)
        onProgress?.(
          `Downloading... ${((downloaded / totalSize) * 100).toFixed(0)}%`,
          pct
        )
        controller.enqueue(value)
      }
    })

    try {
      await pipeline(Readable.fromWeb(progressStream as any), fileStream)
    } catch (err) {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      throw err
    }

    // Verify sha256 checksum (streaming — memory-efficient for large binaries)
    onProgress?.('Verifying checksum...', 0.82)
    const actual = await sha256File(tmpPath)
    if (actual !== platInfo.checksum) {
      unlinkSync(tmpPath)
      throw new Error(
        `Checksum mismatch: expected ${platInfo.checksum}, got ${actual}`
      )
    }
    log.info('CLI: checksum verified')

    // Move to final path (backup existing binary first)
    if (existsSync(this.binaryPath)) {
      const bakPath = this.binaryPath + '.install-bak'
      try {
        copyFileSync(this.binaryPath, bakPath)
        renameSync(tmpPath, this.binaryPath)
        try { unlinkSync(bakPath) } catch { /* ignore */ }
      } catch (err) {
        // Restore backup on failure
        if (existsSync(bakPath)) {
          try { copyFileSync(bakPath, this.binaryPath) } catch { /* ignore */ }
          try { unlinkSync(bakPath) } catch { /* ignore */ }
        }
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
        throw err
      }
    } else {
      renameSync(tmpPath, this.binaryPath)
    }

    // Set executable permission on unix
    if (platform !== 'win32') {
      chmodSync(this.binaryPath, 0o755)
    }

    // macOS: clear quarantine attribute
    if (platform === 'darwin') {
      try {
        execSync(`xattr -cr "${this.binaryPath}"`, { timeout: 5000 })
        log.info('CLI: cleared quarantine attribute')
      } catch {
        log.warn('CLI: failed to clear quarantine attribute (non-fatal)')
      }
    }

    onProgress?.('Verifying installation...', 0.9)

    try {
      execSync(`"${this.binaryPath}" --version`, { timeout: 10000 })
    } catch (verifyErr) {
      log.error('CLI: binary verification failed:', verifyErr)
      if (existsSync(this.binaryPath)) {
        unlinkSync(this.binaryPath)
      }
      throw new Error(
        'CLI installation verification failed. The downloaded file may be corrupted — please try again.'
      )
    }

    onProgress?.('Installation complete', 1.0)
    this.invalidateCache()
    writeFileSync(this.markerPath, `${version}|${new Date().toISOString()}`)
    } finally {
      this._installing = false
    }
  }

  async update(
    onProgress?: (step: string, progress: number) => void
  ): Promise<void> {
    const backupPath = this.binaryPath + '.bak'
    if (existsSync(this.binaryPath)) {
      copyFileSync(this.binaryPath, backupPath)
    }
    try {
      await this.install(onProgress)
    } catch (err) {
      if (existsSync(backupPath)) {
        try { copyFileSync(backupPath, this.binaryPath) } catch { /* ignore */ }
      }
      throw err
    } finally {
      try { if (existsSync(backupPath)) unlinkSync(backupPath) } catch { /* ignore */ }
    }
  }
}
