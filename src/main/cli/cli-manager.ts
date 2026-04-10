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
  readdirSync,
  rmdirSync
} from 'fs'
import { execSync } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import * as os from 'os'
import log from '../logger'
import { fetchWithTimeout, sha256File } from '../utils/fetch'

const MIRROR_BASE_URL =
  'https://inkess-install-file.oss-cn-beijing.aliyuncs.com/cli-mirror'

/** Strict semver-like version pattern to prevent path traversal */
const VERSION_RE = /^\d+\.\d+\.\d+$/

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

/**
 * Multi-version CLI manager.
 *
 * Storage layout:
 *   {userData}/cli/
 *     .active          — current version string (e.g. "2.1.98")
 *     2.1.78/claude    — version-specific binary
 *     2.1.87/claude
 *     2.1.98/claude
 *
 * Migration: if legacy single-binary layout is detected (cli/claude + .installed),
 * it is migrated into the versioned layout on first getInfo().
 */
export class CliManager {
  private cliDir: string
  private binaryName: string
  private _cachedInfo: CliInfo | null = null
  private _installing = false

  private get activePath(): string {
    return join(this.cliDir, '.active')
  }

  /** Legacy marker from single-binary layout */
  private get legacyMarkerPath(): string {
    return join(this.cliDir, '.installed')
  }

  constructor() {
    this.cliDir = join(app.getPath('userData'), 'cli')
    this.binaryName = os.platform() === 'win32' ? 'claude.exe' : 'claude'
  }

  /** Get the binary path for a specific version */
  private versionBinaryPath(version: string): string {
    return join(this.cliDir, version, this.binaryName)
  }

  /** Read the active version from .active file */
  private getActiveVersion(): string | null {
    try {
      return readFileSync(this.activePath, 'utf-8').trim() || null
    } catch {
      return null
    }
  }

  /** Migrate legacy single-binary layout to versioned layout */
  private migrateLegacy(): void {
    const legacyBinary = join(this.cliDir, this.binaryName)
    if (!existsSync(legacyBinary) || !existsSync(this.legacyMarkerPath)) return
    if (existsSync(this.activePath)) return // already migrated

    let version: string | null = null
    try {
      const marker = readFileSync(this.legacyMarkerPath, 'utf-8').trim()
      if (marker.includes('|')) {
        version = marker.split('|')[0]
      }
    } catch { /* ignore */ }

    if (!version) {
      try {
        const raw = execSync(`"${legacyBinary}" --version`, {
          timeout: 5000,
          encoding: 'utf-8'
        }).trim()
        const match = raw.match(/^[\d.]+/)
        version = match ? match[0] : null
      } catch { /* ignore */ }
    }

    if (!version) {
      log.warn('CLI: legacy migration skipped — cannot determine version')
      return
    }

    const versionDir = join(this.cliDir, version)
    if (!existsSync(versionDir)) mkdirSync(versionDir, { recursive: true })
    const dest = join(versionDir, this.binaryName)
    if (!existsSync(dest)) {
      renameSync(legacyBinary, dest)
    } else {
      try { unlinkSync(legacyBinary) } catch { /* ignore */ }
    }

    writeFileSync(this.activePath, version)
    try { unlinkSync(this.legacyMarkerPath) } catch { /* ignore */ }
    log.info(`CLI: migrated legacy binary to versioned layout (v${version})`)
  }

  getInfo(): CliInfo {
    if (this._cachedInfo) return this._cachedInfo

    // Migrate legacy layout if needed
    this.migrateLegacy()

    const version = this.getActiveVersion()
    if (version) {
      const binPath = this.versionBinaryPath(version)
      if (existsSync(binPath)) {
        const info = { installed: true, path: binPath, version }
        this._cachedInfo = info
        return info
      }
    }

    const info: CliInfo = { installed: false, path: '', version: null }
    return info
  }

  invalidateCache(): void {
    this._cachedInfo = null
  }

  getBinaryPath(): string {
    return this.getInfo().path
  }

  isInstalled(): boolean {
    return this.getInfo().installed
  }

  /** List locally installed versions */
  getLocalVersions(): string[] {
    if (!existsSync(this.cliDir)) return []
    try {
      return readdirSync(this.cliDir)
        .filter(name => {
          if (name.startsWith('.')) return false
          return existsSync(this.versionBinaryPath(name))
        })
        .sort((a, b) => {
          const pa = a.split('.').map(Number)
          const pb = b.split('.').map(Number)
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const diff = (pb[i] || 0) - (pa[i] || 0)
            if (diff !== 0) return diff
          }
          return 0
        })
    } catch {
      return []
    }
  }

  async listVersions(): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(`${MIRROR_BASE_URL}/versions.json`)
      if (!res.ok) return []
      const raw: unknown = await res.json()
      if (!Array.isArray(raw)) return []
      return raw.filter((v): v is string => typeof v === 'string' && VERSION_RE.test(v))
    } catch {
      return []
    }
  }

  /**
   * Install a specific version (or latest if not specified).
   * Downloads to {cliDir}/{version}/claude and sets it as active.
   * Skips download if the version is already present locally.
   */
  async install(
    onProgress?: (step: string, progress: number) => void,
    targetVersion?: string
  ): Promise<void> {
    if (this._installing) throw new Error('Installation already in progress')
    this._installing = true
    let versionDir = ''
    try {
      if (!existsSync(this.cliDir)) {
        mkdirSync(this.cliDir, { recursive: true })
      }

      const platform = os.platform()
      const arch = os.arch()
      const platformKey = `${platform}-${arch}`

      onProgress?.('Checking latest version...', 0.05)

      let version: string
      if (targetVersion) {
        version = targetVersion.replace(/^v/, '')
      } else {
        const latestRes = await fetchWithTimeout(`${MIRROR_BASE_URL}/latest`)
        if (!latestRes.ok) {
          throw new Error('Failed to check latest CLI version')
        }
        version = (await latestRes.text()).trim()
      }

      // Validate version string to prevent path traversal
      if (!VERSION_RE.test(version)) {
        throw new Error(`Invalid version format: ${version}`)
      }
      log.info(`CLI: target version is ${version}`)

      versionDir = join(this.cliDir, version)
      const binaryPath = join(versionDir, this.binaryName)

      // Skip download if already present locally
      if (existsSync(binaryPath)) {
        log.info(`CLI: v${version} already exists locally, switching`)
        onProgress?.('Version already downloaded, switching...', 0.9)
        writeFileSync(this.activePath, version)
        this.invalidateCache()
        onProgress?.('Installation complete', 1.0)
        return
      }

      if (!existsSync(versionDir)) {
        mkdirSync(versionDir, { recursive: true })
      }

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

      const res = await fetchWithTimeout(binaryUrl, {}, 300000)
      if (!res.ok || !res.body) {
        throw new Error(
          `Download failed (HTTP ${res.status}). Please try again later.`
        )
      }

      const tmpPath = binaryPath + '.tmp'
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

      // Verify sha256 checksum
      onProgress?.('Verifying checksum...', 0.82)
      const actual = await sha256File(tmpPath)
      if (actual !== platInfo.checksum) {
        unlinkSync(tmpPath)
        throw new Error(
          `Checksum mismatch: expected ${platInfo.checksum}, got ${actual}`
        )
      }
      log.info('CLI: checksum verified')

      // Move tmp to final
      renameSync(tmpPath, binaryPath)

      // Set executable permission on unix
      if (platform !== 'win32') {
        chmodSync(binaryPath, 0o755)
      }

      // macOS: clear quarantine attribute
      if (platform === 'darwin') {
        try {
          execSync(`xattr -cr "${binaryPath}"`, { timeout: 5000 })
          log.info('CLI: cleared quarantine attribute')
        } catch {
          log.warn('CLI: failed to clear quarantine attribute (non-fatal)')
        }
      }

      onProgress?.('Verifying installation...', 0.9)

      try {
        execSync(`"${binaryPath}" --version`, { timeout: 10000 })
      } catch (verifyErr) {
        log.error('CLI: binary verification failed:', verifyErr)
        try { unlinkSync(binaryPath) } catch { /* ignore */ }
        try { rmdirSync(versionDir) } catch { /* ignore — not empty is fine */ }
        throw new Error(
          'CLI installation verification failed. The downloaded file may be corrupted — please try again.'
        )
      }

      // Set as active version
      writeFileSync(this.activePath, version)
      this.invalidateCache()
      onProgress?.('Installation complete', 1.0)
    } catch (err) {
      // Clean up empty version directory on failure
      if (versionDir && existsSync(versionDir)) {
        try { rmdirSync(versionDir) } catch { /* ignore — not empty is fine */ }
      }
      throw err
    } finally {
      this._installing = false
    }
  }

  /**
   * Switch to a specific version. Downloads if not present locally.
   */
  async installVersion(
    version: string,
    onProgress?: (step: string, progress: number) => void
  ): Promise<void> {
    await this.install(onProgress, version)
  }

}
