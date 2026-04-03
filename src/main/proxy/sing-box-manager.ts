import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'fs'
import { execSync, spawn, type ChildProcess } from 'child_process'
import * as os from 'os'
import log from '../logger'
import { buildTunConfig, buildLocalProxyConfig, type SingBoxConfig } from './sing-box-config'
import { fetchWithTimeout } from '../utils/fetch'

const SINGBOX_VERSION = '1.11.0'
const SINGBOX_DOWNLOAD_BASE = 'https://github.com/SagerNet/sing-box/releases/download'

type SingBoxMode = 'tun' | 'local-proxy' | 'off'

export class SingBoxManager {
  private singboxDir: string
  private configPath: string
  private process: ChildProcess | null = null
  private _mode: SingBoxMode = 'off'
  private _status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped'
  private _lastError: string | null = null

  constructor() {
    this.singboxDir = join(app.getPath('userData'), 'sing-box')
    this.configPath = join(this.singboxDir, 'config.json')
    mkdirSync(this.singboxDir, { recursive: true })
  }

  get mode(): SingBoxMode { return this._mode }
  get status(): string { return this._status }
  get lastError(): string | null { return this._lastError }

  private get binaryPath(): string {
    const name = os.platform() === 'win32' ? 'sing-box.exe' : 'sing-box'
    return join(this.singboxDir, name)
  }

  private get platformKey(): string {
    const platform = os.platform()
    const arch = os.arch()
    if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
    if (platform === 'win32') return 'windows-amd64'
    return 'linux-amd64'
  }

  isInstalled(): boolean {
    return existsSync(this.binaryPath)
  }

  /**
   * Download and install sing-box binary
   */
  async install(onProgress?: (step: string, pct: number) => void): Promise<void> {
    const key = this.platformKey
    const ext = os.platform() === 'win32' ? '.zip' : '.tar.gz'
    const filename = `sing-box-${SINGBOX_VERSION}-${key}`
    const url = `${SINGBOX_DOWNLOAD_BASE}/v${SINGBOX_VERSION}/${filename}${ext}`

    onProgress?.('Downloading sing-box...', 0.1)
    log.info(`SingBox: downloading ${url}`)

    const res = await fetchWithTimeout(url, {}, 300000) // 5min
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)

    const tmpPath = join(this.singboxDir, `sing-box${ext}.tmp`)
    const { createWriteStream } = require('fs') as typeof import('fs')
    const { pipeline } = require('stream/promises') as typeof import('stream/promises')
    const { Readable } = require('stream') as typeof import('stream')

    const fileStream = createWriteStream(tmpPath)
    await pipeline(Readable.fromWeb(res.body as any), fileStream)

    onProgress?.('Extracting...', 0.7)

    // Extract binary
    if (os.platform() === 'win32') {
      const zipPath = tmpPath.replace('.tmp', '')
      const { renameSync } = require('fs') as typeof import('fs')
      renameSync(tmpPath, zipPath)
      try {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${this.singboxDir.replace(/'/g, "''")}'"`
          , { timeout: 120000 }
        )
      } finally {
        try { unlinkSync(zipPath) } catch { /* ignore */ }
      }
      // Move binary from extracted dir to singboxDir
      const extracted = join(this.singboxDir, filename, 'sing-box.exe')
      if (existsSync(extracted)) {
        const { copyFileSync } = require('fs') as typeof import('fs')
        copyFileSync(extracted, this.binaryPath)
      }
    } else {
      execSync(`tar -xzf "${tmpPath}" -C "${this.singboxDir}"`, { timeout: 60000 })
      unlinkSync(tmpPath)
      // Move binary from extracted dir
      const extracted = join(this.singboxDir, filename, 'sing-box')
      if (existsSync(extracted)) {
        const { copyFileSync } = require('fs') as typeof import('fs')
        copyFileSync(extracted, this.binaryPath)
        chmodSync(this.binaryPath, 0o755)
      }
    }

    // macOS: clear quarantine
    if (os.platform() === 'darwin') {
      try { execSync(`xattr -cr "${this.binaryPath}"`, { timeout: 5000 }) } catch { /* ignore */ }
    }

    // Verify
    onProgress?.('Verifying...', 0.9)
    try {
      execSync(`"${this.binaryPath}" version`, { timeout: 5000, encoding: 'utf-8' })
      log.info('SingBox: installed successfully')
    } catch (err) {
      throw new Error(`sing-box verification failed: ${(err as Error).message}`)
    }

    onProgress?.('Ready', 1.0)
  }

  /**
   * Start sing-box in TUN mode (requires admin/root)
   */
  async startTun(proxyUrl: string): Promise<void> {
    await this.ensureInstalled()
    this.stop()

    const config = buildTunConfig(proxyUrl)
    this.writeConfig(config)

    this._mode = 'tun'
    this._status = 'starting'

    // TUN mode needs root/admin
    if (os.platform() === 'darwin') {
      await this.startWithSudo()
    } else if (os.platform() === 'win32') {
      await this.startWithAdmin()
    } else {
      this.startProcess()
    }
  }

  /**
   * Start sing-box in local proxy mode (no admin needed)
   * Returns the local proxy port
   */
  async startLocalProxy(proxyUrl: string, port = 7891): Promise<number> {
    await this.ensureInstalled()
    this.stop()

    const config = buildLocalProxyConfig(proxyUrl, port)
    this.writeConfig(config)

    this._mode = 'local-proxy'
    this._status = 'starting'
    this.startProcess()

    return port
  }

  /**
   * Stop sing-box
   */
  stop(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM')
        // Force kill after 3s
        setTimeout(() => {
          try { this.process?.kill('SIGKILL') } catch { /* ignore */ }
        }, 3000)
      } catch { /* ignore */ }
      this.process = null
    }

    // Also kill any lingering sing-box process (TUN mode may have been started with sudo)
    try {
      if (os.platform() === 'win32') {
        execSync('taskkill /F /IM sing-box.exe', { timeout: 3000 })
      } else {
        execSync('pkill -f "sing-box run"', { timeout: 3000 })
      }
    } catch { /* no process to kill */ }

    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
  }

  getInfo(): { mode: SingBoxMode; status: string; installed: boolean; lastError: string | null } {
    return {
      mode: this._mode,
      status: this._status,
      installed: this.isInstalled(),
      lastError: this._lastError,
    }
  }

  private writeConfig(config: SingBoxConfig): void {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2))
  }

  private async ensureInstalled(): Promise<void> {
    if (!this.isInstalled()) {
      await this.install()
    }
  }

  private startProcess(): void {
    this.process = spawn(this.binaryPath, ['run', '-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log.info(`[sing-box] ${msg}`)
      if (msg.includes('started')) {
        this._status = 'running'
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log.warn(`[sing-box] ${msg}`)
      this._lastError = msg
    })

    this.process.on('exit', (code) => {
      log.info(`[sing-box] exited with code ${code}`)
      this._status = code === 0 ? 'stopped' : 'error'
      this.process = null
    })

    // Give it a moment to start
    setTimeout(() => {
      if (this._status === 'starting' && this.process) {
        this._status = 'running'
      }
    }, 2000)
  }

  private async startWithSudo(): Promise<void> {
    // macOS: use osascript to prompt for admin password
    const cmd = `"${this.binaryPath}" run -c "${this.configPath}"`
    try {
      this.process = spawn('osascript', [
        '-e', `do shell script "${cmd.replace(/"/g, '\\"')}" with administrator privileges`,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      this.process.on('exit', (code) => {
        this._status = code === 0 ? 'stopped' : 'error'
        this.process = null
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim()
        if (msg && !msg.includes('User canceled')) {
          this._lastError = msg
          log.warn(`[sing-box sudo] ${msg}`)
        }
        if (msg.includes('User canceled')) {
          this._status = 'stopped'
          this._lastError = 'User canceled admin authorization'
        }
      })

      // Assume running after 3s
      setTimeout(() => {
        if (this._status === 'starting') this._status = 'running'
      }, 3000)

    } catch (err) {
      this._status = 'error'
      this._lastError = (err as Error).message
    }
  }

  private async startWithAdmin(): Promise<void> {
    // Windows: use PowerShell Start-Process -Verb RunAs for UAC prompt
    const cmd = `Start-Process -FilePath '${this.binaryPath}' -ArgumentList 'run','-c','${this.configPath}' -Verb RunAs -WindowStyle Hidden`
    try {
      execSync(`powershell -NoProfile -Command "${cmd}"`, { timeout: 30000 })
      this._status = 'running'
    } catch (err) {
      this._status = 'error'
      this._lastError = (err as Error).message
    }
  }
}
