import { app } from 'electron'
import { join, delimiter, dirname } from 'path'
import { buildBasePath } from '../utils/clean-env'
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  unlinkSync,
  renameSync,
  writeFileSync,
  chmodSync,
  rmSync
} from 'fs'
import { execSync } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import * as os from 'os'
import log from '../logger'
import { fetchWithTimeout, sha256File } from '../utils/fetch'
import {
  TOOLS_MIRROR_BASE_URL,
  TOOL_DEFINITIONS,
  type ToolName,
  type ToolDef,
  type RemoteManifest
} from './tools-manifest'

interface ToolStatus {
  installed: boolean
  path: string | null
  version: string | null
}

export type ToolsInfo = Record<ToolName, ToolStatus>

export class ToolsManager {
  private toolsDir: string
  private platformKey: string
  private _cachedInfo: ToolsInfo | null = null

  private get markerPath(): string {
    return join(this.toolsDir, '.installed')
  }

  constructor() {
    this.toolsDir = join(app.getPath('userData'), 'tools')
    this.platformKey = `${os.platform()}-${os.arch()}`
  }

  /** Which tools are needed on this platform */
  private getRequiredTools(): ToolDef[] {
    return TOOL_DEFINITIONS.filter((t) => t.platforms.includes(this.platformKey))
  }

  /** Get the absolute binary path for a tool */
  private getBinPath(tool: ToolDef): string | null {
    const rel = tool.binPath[this.platformKey]
    if (!rel) return null
    return join(this.toolsDir, rel)
  }

  /** Check status of all tools for this platform */
  getInfo(): ToolsInfo {
    if (this._cachedInfo) return this._cachedInfo
    const info: Partial<ToolsInfo> = {}
    for (const def of TOOL_DEFINITIONS) {
      const binPath = this.getBinPath(def)
      if (!binPath || !def.platforms.includes(this.platformKey)) {
        info[def.name] = { installed: true, path: null, version: 'system' }
        continue
      }
      const installed = existsSync(binPath)
      let version: string | null = null
      if (installed) {
        try {
          const raw = execSync(`"${binPath}" ${def.verifyCommand.join(' ')}`, {
            timeout: 5000,
            encoding: 'utf-8'
          }).trim()
          const match = raw.match(/[\d.]+/)
          version = match ? match[0] : raw
        } catch {
          // binary exists but can't verify
        }
      }
      info[def.name] = { installed, path: binPath, version }
    }
    const result = info as ToolsInfo
    const allInstalled = Object.values(result).every(s => s.installed)
    if (allInstalled) this._cachedInfo = result
    return result
  }

  invalidateCache(): void {
    this._cachedInfo = null
  }

  /** Check if all required tools are installed */
  isAllInstalled(): boolean {
    // Fast path: marker file written after successful install
    if (existsSync(this.markerPath)) return true

    const required = this.getRequiredTools()
    const missing: string[] = []
    for (const def of required) {
      const binPath = this.getBinPath(def)
      if (binPath && !existsSync(binPath)) {
        missing.push(`${def.name}: bin not found at ${binPath}`)
      }

      // Also check extraEnv paths (e.g. git bash.exe for Windows)
      const envDefs = def.extraEnv?.[this.platformKey]
      if (envDefs) {
        for (const [key, val] of Object.entries(envDefs)) {
          const absVal = join(this.toolsDir, val)
          if (!existsSync(absVal)) {
            missing.push(`${def.name}: extraEnv ${key} not found at ${absVal}`)
          }
        }
      }
    }
    if (missing.length > 0) {
      log.info(`Tools: missing files:\n  ${missing.join('\n  ')}`)
      return false
    }
    return true
  }

  /**
   * Install all missing tools.
   * onProgress reports (step description, 0..1 overall progress)
   */
  async install(
    onProgress?: (step: string, progress: number) => void
  ): Promise<void> {
    if (!existsSync(this.toolsDir)) {
      mkdirSync(this.toolsDir, { recursive: true })
    }

    const required = this.getRequiredTools()
    const missing = required.filter((def) => {
      const binPath = this.getBinPath(def)
      if (binPath && !existsSync(binPath)) return true
      // Check extraEnv paths (e.g. bash.exe for git)
      const envDefs = def.extraEnv?.[this.platformKey]
      if (envDefs) {
        for (const val of Object.values(envDefs)) {
          if (!existsSync(join(this.toolsDir, val))) return true
        }
      }
      return false
    })

    if (missing.length === 0) {
      onProgress?.('All tools ready', 1.0)
      return
    }

    // Fetch remote manifest
    onProgress?.('Fetching tool manifest...', 0.05)
    const manifestRes = await fetchWithTimeout(
      `${TOOLS_MIRROR_BASE_URL}/manifest.json`
    )
    if (!manifestRes.ok) {
      throw new Error('Failed to fetch dev tools manifest')
    }
    const manifest: RemoteManifest = await manifestRes.json()

    // Install each missing tool
    for (let i = 0; i < missing.length; i++) {
      const def = missing[i]
      const baseProgress = i / missing.length
      const sliceSize = 1 / missing.length

      const toolManifest = manifest.tools[def.name]
      if (!toolManifest) {
        log.warn(`Tools: no manifest entry for ${def.name}, skipping`)
        continue
      }
      const platInfo = toolManifest.platforms[this.platformKey]
      if (!platInfo) {
        log.warn(
          `Tools: no platform ${this.platformKey} for ${def.name}, skipping`
        )
        continue
      }

      await this.installTool(
        def,
        toolManifest.version,
        platInfo,
        (step, pct) => {
          onProgress?.(step, baseProgress + pct * sliceSize)
        }
      )
    }

    onProgress?.('Development tools ready', 1.0)
    this.invalidateCache()
    // Write marker so subsequent launches skip the install check
    writeFileSync(this.markerPath, new Date().toISOString())
  }

  private async installTool(
    def: ToolDef,
    version: string,
    platInfo: { archive: string; checksum: string; size: number },
    onProgress: (step: string, progress: number) => void
  ): Promise<void> {
    const archiveUrl = `${TOOLS_MIRROR_BASE_URL}/${def.name}/${version}/${this.platformKey}/${platInfo.archive}`

    onProgress(`Downloading ${def.displayName} v${version}...`, 0.1)
    log.info(`Tools: downloading ${archiveUrl}`)

    const res = await fetchWithTimeout(archiveUrl, {}, 600000) // 10min timeout
    if (!res.ok || !res.body) {
      throw new Error(
        `Failed to download ${def.displayName} (HTTP ${res.status})`
      )
    }

    // Download to temp file
    const archiveExt = platInfo.archive.endsWith('.zip') ? '.zip' : '.tar.gz'
    const tmpPath = join(this.toolsDir, `${def.name}${archiveExt}.tmp`)

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
        const pct = Math.min(0.1 + (downloaded / totalSize) * 0.6, 0.7)
        onProgress(
          `Downloading ${def.displayName}... ${((downloaded / totalSize) * 100).toFixed(0)}%`,
          pct
        )
        controller.enqueue(value)
      }
    })

    const fileStream = createWriteStream(tmpPath)
    try {
      await pipeline(Readable.fromWeb(progressStream as any), fileStream)
    } catch (err) {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      throw err
    }

    // Verify checksum (streaming — memory-efficient for large archives)
    onProgress(`Verifying ${def.displayName}...`, 0.72)
    const actual = await sha256File(tmpPath)
    if (actual !== platInfo.checksum) {
      unlinkSync(tmpPath)
      throw new Error(
        `${def.displayName} checksum mismatch: expected ${platInfo.checksum}, got ${actual}`
      )
    }
    log.info(`Tools: ${def.name} checksum verified`)

    // Extract — archives contain a top-level dir matching the tool name
    // (e.g. python/, node/, git/), so extract into toolsDir directly.
    onProgress(`Extracting ${def.displayName}...`, 0.75)
    const extractDir = this.toolsDir
    if (!existsSync(extractDir)) {
      mkdirSync(extractDir, { recursive: true })
    }

    // Remove old tool directory to avoid stale files (e.g. upgrading MinGit → PortableGit)
    const oldToolDir = join(this.toolsDir, def.name)
    if (existsSync(oldToolDir)) {
      log.info(`Tools: removing old ${def.name} directory before extraction`)
      rmSync(oldToolDir, { recursive: true, force: true })
    }

    if (archiveExt === '.zip') {
      // Use system unzip (available on Windows via PowerShell and macOS)
      if (os.platform() === 'win32') {
        // PowerShell Expand-Archive only accepts .zip extension — rename first
        const zipPath = tmpPath.replace(/\.tmp$/, '')
        renameSync(tmpPath, zipPath)
        try {
          // Use -LiteralPath to avoid issues with special characters in paths
          const psCmd = `Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}'`
          execSync(
            `powershell -NoProfile -Command "${psCmd}"`,
            { timeout: 300000 }
          )
        } finally {
          if (existsSync(zipPath)) unlinkSync(zipPath)
        }
      } else {
        execSync(`unzip -o -q "${tmpPath}" -d "${extractDir}"`, {
          timeout: 120000
        })
        unlinkSync(tmpPath)
      }
    } else {
      // tar.gz
      execSync(`tar -xzf "${tmpPath}" -C "${extractDir}"`, {
        timeout: 120000
      })
      unlinkSync(tmpPath)
    }

    // Set executable permission on unix
    if (os.platform() !== 'win32') {
      const binPath = this.getBinPath(def)
      if (binPath && existsSync(binPath)) {
        chmodSync(binPath, 0o755)
      }
    }

    // Windows: run PortableGit post-install if present (initializes git config)
    if (os.platform() === 'win32' && def.name === 'git') {
      const postInstall = join(this.toolsDir, 'git', 'post-install.bat')
      if (existsSync(postInstall)) {
        try {
          execSync(`"${postInstall}"`, {
            cwd: join(this.toolsDir, 'git'),
            timeout: 30000,
            windowsHide: true
          })
          log.info('Tools: git post-install completed')
        } catch (err) {
          log.warn('Tools: git post-install failed (non-fatal):', err)
        }
      }
    }

    // macOS: clear quarantine
    if (os.platform() === 'darwin') {
      const toolDir = join(this.toolsDir, def.name)
      try {
        execSync(`xattr -cr "${toolDir}"`, { timeout: 10000 })
        log.info(`Tools: cleared quarantine for ${def.name}`)
      } catch {
        log.warn(`Tools: failed to clear quarantine for ${def.name} (non-fatal)`)
      }
    }

    // Verify
    onProgress(`Verifying ${def.displayName} installation...`, 0.9)
    const binPath = this.getBinPath(def)
    if (binPath) {
      try {
        execSync(`"${binPath}" ${def.verifyCommand.join(' ')}`, {
          timeout: 10000,
          cwd: join(this.toolsDir, def.name)
        })
        log.info(`Tools: ${def.name} verified successfully`)
      } catch (err) {
        log.error(`Tools: ${def.name} verification failed:`, err)
        // Clean up broken installation so next launch triggers a fresh install
        const toolDir = join(this.toolsDir, def.name)
        if (existsSync(toolDir)) {
          log.info(`Tools: removing broken ${def.name} directory for re-install`)
          rmSync(toolDir, { recursive: true, force: true })
        }
        throw new Error(
          `${def.displayName} installation verification failed. Please try again.`
        )
      }
    }

    onProgress(`${def.displayName} ready`, 1.0)
  }

  /**
   * Returns PATH-prepend entries and extra env vars for all installed tools.
   * These should be merged into PTY env.
   */
  getEnvPatch(): Record<string, string> {
    const dirs: string[] = []
    const extraEnv: Record<string, string> = {}

    for (const def of this.getRequiredTools()) {
      const binPath = this.getBinPath(def)
      if (binPath && existsSync(binPath)) {
        dirs.push(dirname(binPath))

        // Add extra PATH directories (e.g. git/bin for bash.exe)
        const extraDirs = def.extraPathDirs?.[this.platformKey]
        if (extraDirs) {
          for (const rel of extraDirs) {
            const absDir = join(this.toolsDir, rel)
            if (existsSync(absDir)) {
              dirs.push(absDir)
            }
          }
        }

        // Add extra environment variables (resolve relative paths)
        const envDefs = def.extraEnv?.[this.platformKey]
        if (envDefs) {
          for (const [key, val] of Object.entries(envDefs)) {
            const absVal = join(this.toolsDir, val)
            extraEnv[key] = existsSync(absVal) ? absVal : val
          }
        }
      }
    }
    if (dirs.length === 0 && Object.keys(extraEnv).length === 0) return {}

    return {
      ...extraEnv,
      PATH: dirs.join(delimiter) + delimiter + buildBasePath()
    }
  }
}
