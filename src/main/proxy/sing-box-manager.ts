import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync, readFileSync } from 'fs'
import { execSync, execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'
import log from '../logger'
import { buildTunConfig, buildLocalProxyConfig, type SingBoxConfig } from './sing-box-config'
import { fetchWithTimeout } from '../utils/fetch'

const execFileAsync = promisify(execFile)

const SINGBOX_VERSION = '1.11.0'
const SINGBOX_DOWNLOAD_BASE = 'https://inkess-install-file.oss-cn-beijing.aliyuncs.com/singbox-mirror'

type SingBoxMode = 'tun' | 'local-proxy' | 'off'

export interface NetworkStatus {
  mode: SingBoxMode
  tunRunning: boolean
  installed: boolean
  lastError: string | null
  internetReachable: boolean | null
  latencyMs: number | null
}

export class SingBoxManager {
  private singboxDir: string
  private configPath: string
  private process: ChildProcess | null = null
  private _mode: SingBoxMode = 'off'
  private _status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped'
  private _lastError: string | null = null
  private _internetReachable: boolean | null = null
  private _latencyMs: number | null = null
  private _stopPromise: Promise<void> | null = null

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

  private get pidFilePath(): string {
    return join(this.singboxDir, 'sing-box.pid')
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

  // --- Process lifecycle helpers ---

  /** Check if a process is alive. Uses `ps` on macOS (root process = EPERM from kill). */
  private isProcessAlive(pid: number): boolean {
    try {
      if (os.platform() === 'darwin' || os.platform() === 'linux') {
        execSync(`ps -p ${pid} -o pid=`, { timeout: 2000, stdio: 'pipe' })
        return true
      }
      // Windows: check via tasklist
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { timeout: 2000, encoding: 'utf-8' })
      return out.includes(String(pid))
    } catch {
      return false
    }
  }

  /** Wait for a process to die, polling every 200ms. Returns true if dead. */
  private async waitForProcessDeath(pid: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!this.isProcessAlive(pid)) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return !this.isProcessAlive(pid)
  }

  /** Kill a process. If sudo=true, uses osascript/UAC (requires GUI interaction). */
  private killProcess(pid: number, signal: 'TERM' | 'KILL', sudo = true): void {
    const sig = signal === 'KILL' ? '-9' : '-TERM'
    try {
      if (os.platform() === 'win32') {
        // Windows: taskkill always force-kills; /F required for elevated processes
        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: 'pipe' })
      } else if (sudo) {
        execSync(
          `osascript -e 'do shell script "kill ${sig} ${pid}" with administrator privileges'`,
          { timeout: 15000, stdio: 'pipe' }
        )
      } else {
        execSync(`kill ${sig} ${pid}`, { timeout: 3000, stdio: 'pipe' })
      }
      log.info(`[sing-box] killed pid=${pid} signal=${signal}`)
    } catch (err) {
      log.warn(`[sing-box] kill pid=${pid} signal=${signal} failed: ${(err as Error).message}`)
    }
  }

  /** Read PID from PID file. Returns 0 if not found or invalid. */
  private readPidFile(): number {
    try {
      if (!existsSync(this.pidFilePath)) return 0
      const content = readFileSync(this.pidFilePath, 'utf-8').trim()
      const pid = parseInt(content)
      return pid > 0 ? pid : 0
    } catch {
      return 0
    }
  }

  /** Remove PID file. */
  private removePidFile(): void {
    try { unlinkSync(this.pidFilePath) } catch { /* ignore */ }
  }

  // --- Public API ---

  /**
   * Clean up stale sing-box processes from previous app crashes.
   * Call once at app startup.
   */
  /**
   * Clean up stale sing-box processes from previous app crashes.
   * Uses non-interactive kill (no sudo dialog). If the root process can't be killed
   * without sudo, it will be killed when startTun() calls stop() with sudo.
   */
  async cleanupStaleProcesses(): Promise<void> {
    const pid = this.readPidFile()
    if (pid > 0) {
      if (this.isProcessAlive(pid)) {
        log.info(`[sing-box] startup cleanup: found stale process pid=${pid}`)
        // Try non-interactive kill (may fail for root/elevated processes, that's OK)
        if (os.platform() === 'win32') {
          // taskkill may work if Electron has sufficient rights
          try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'pipe' }) } catch { /* ignore */ }
        } else {
          this.killProcess(pid, 'TERM', false)
        }
        const dead = await this.waitForProcessDeath(pid, 2000)
        if (!dead) {
          // Root process can't be killed without sudo — leave it for stop() to handle
          log.info(`[sing-box] startup cleanup: pid=${pid} needs sudo to kill, will clean up on next startTun`)
          // Mark it as running so reconcileStatus works correctly
          this._mode = 'tun'
          this._status = 'running'
          return
        }
      }
      this.removePidFile()
    }

    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
  }

  /**
   * Stop sing-box. Async — waits for process to be confirmed dead.
   * Safe to call multiple times (mutex prevents concurrent stop).
   */
  async stop(): Promise<void> {
    // Mutex: if already stopping, wait for that to finish
    if (this._stopPromise) {
      await this._stopPromise
      return
    }
    this._stopPromise = this._stopImpl()
    try {
      await this._stopPromise
    } finally {
      this._stopPromise = null
    }
  }

  private async _stopImpl(): Promise<void> {
    log.info(`[sing-box] stop() called, mode=${this._mode} status=${this._status}`)

    // Kill the osascript/powershell wrapper process (if any)
    const proc = this.process
    this.process = null
    if (proc) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
    }

    // Kill the actual sing-box root process via PID file
    const pid = this.readPidFile()
    if (pid > 0 && this.isProcessAlive(pid)) {
      log.info(`[sing-box] stopping pid=${pid} with SIGTERM...`)
      this.killProcess(pid, 'TERM')
      const dead = await this.waitForProcessDeath(pid, 5000)

      if (!dead) {
        log.warn(`[sing-box] pid=${pid} still alive after SIGTERM, sending SIGKILL`)
        this.killProcess(pid, 'KILL')
        const killed = await this.waitForProcessDeath(pid, 3000)
        if (!killed) {
          log.error(`[sing-box] FAILED to kill pid=${pid} — process may be orphaned`)
        }
      }
      log.info(`[sing-box] pid=${pid} confirmed dead`)
    }

    this.removePidFile()
    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
    this._internetReachable = null
    this._latencyMs = null
  }

  /**
   * Start sing-box in TUN mode (requires admin/root).
   * Blocks until sing-box is confirmed running or fails.
   */
  async startTun(proxyUrl: string): Promise<void> {
    // Guard: if already starting, skip (concurrent call)
    this.reconcileStatus()
    if (this._status === 'starting') {
      log.info(`[sing-box] startTun skipped — already starting`)
      return
    }

    await this.ensureInstalled()
    await this.stop() // always stop first to apply new config

    const config = buildTunConfig(proxyUrl)
    this.writeConfig(config)

    this._mode = 'tun'
    this._status = 'starting'

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
   */
  async startLocalProxy(proxyUrl: string, port = 7891): Promise<number> {
    await this.ensureInstalled()
    await this.stop()

    const config = buildLocalProxyConfig(proxyUrl, port)
    this.writeConfig(config)

    this._mode = 'local-proxy'
    this._status = 'starting'
    this.startProcess()

    return port
  }

  /** Reconcile in-memory status with actual process state. */
  private reconcileStatus(): void {
    const pid = this.readPidFile()
    if (pid > 0) {
      if (this.isProcessAlive(pid)) {
        if (this._status !== 'running') {
          this._status = 'running'
          if (this._mode === 'off') this._mode = 'tun'
        }
        return
      }
      // PID file exists but process dead — clean up
      this.removePidFile()
    }
    if (this._status === 'running') {
      this._status = 'stopped'
      this._mode = 'off'
      this._internetReachable = null
      this._latencyMs = null
    }
  }

  /** Unified network status — single source of truth */
  getInfo(): NetworkStatus {
    this.reconcileStatus()
    return {
      mode: this._mode,
      tunRunning: this._status === 'running',
      installed: this.isInstalled(),
      lastError: this._lastError,
      internetReachable: this._internetReachable,
      latencyMs: this._latencyMs,
    }
  }

  /**
   * Test connectivity through TUN by verifying exit IP.
   * Fetches ip.oxylabs.io/location and compares with expected exit IP.
   * If exitIp is empty, only checks that the request succeeds (proxy is working).
   */
  async testConnectivity(exitIp?: string): Promise<{ success: boolean; latency?: number; error?: string; actualIp?: string }> {
    this.reconcileStatus()
    if (this._status !== 'running') {
      this._internetReachable = false
      this._latencyMs = null
      log.info(`[testConnectivity] skipped — TUN status=${this._status}`)
      return { success: false, error: 'TUN is not running' }
    }

    try {
      const start = Date.now()
      log.info(`[testConnectivity] verifying exit IP (expected: ${exitIp || 'any'})...`)

      let actualIp: string
      if (os.platform() === 'win32') {
        // Windows: use fetch (curl may not be available)
        const res = await fetchWithTimeout('https://ip.oxylabs.io/location', {}, 15000)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        actualIp = data.ip as string
      } else {
        // macOS/Linux: use curl subprocess to ensure traffic goes through TUN routes.
        // Electron's built-in fetch may use cached DNS/routes that bypass TUN.
        const { stdout } = await execFileAsync('curl', [
          '-s', '--connect-timeout', '10', 'https://ip.oxylabs.io/location',
        ], { timeout: 15000 })
        const data = JSON.parse(stdout)
        actualIp = data.ip as string
      }

      const latency = Date.now() - start
      log.info(`[testConnectivity] exit IP: ${actualIp}, latency: ${latency}ms`)

      if (exitIp && actualIp !== exitIp) {
        log.error(`[testConnectivity] exit IP mismatch: got ${actualIp}, expected ${exitIp}`)
        this._internetReachable = false
        this._latencyMs = latency
        return { success: false, latency, actualIp, error: `Exit IP mismatch: got ${actualIp}, expected ${exitIp}` }
      }

      this._internetReachable = true
      this._latencyMs = latency
      return { success: true, latency, actualIp }
    } catch (err) {
      log.error('[testConnectivity] failed:', (err as Error).message)
      this._internetReachable = false
      this._latencyMs = null
      return { success: false, error: (err as Error).message }
    }
  }

  // --- Install ---

  async install(onProgress?: (step: string, pct: number) => void): Promise<void> {
    const key = this.platformKey
    const ext = os.platform() === 'win32' ? '.zip' : '.tar.gz'
    const filename = `sing-box-${SINGBOX_VERSION}-${key}`
    const url = `${SINGBOX_DOWNLOAD_BASE}/${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-${key}${ext}`

    onProgress?.('Downloading sing-box...', 0.1)
    log.info(`SingBox: downloading ${url}`)

    const res = await fetchWithTimeout(url, {}, 300000)
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)

    const tmpPath = join(this.singboxDir, `sing-box${ext}.tmp`)
    const { createWriteStream } = require('fs') as typeof import('fs')
    const { pipeline } = require('stream/promises') as typeof import('stream/promises')
    const { Readable } = require('stream') as typeof import('stream')

    const fileStream = createWriteStream(tmpPath)
    await pipeline(Readable.fromWeb(res.body as any), fileStream)

    onProgress?.('Extracting...', 0.7)

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
      const extracted = join(this.singboxDir, filename, 'sing-box.exe')
      if (existsSync(extracted)) {
        const { copyFileSync } = require('fs') as typeof import('fs')
        copyFileSync(extracted, this.binaryPath)
      }
    } else {
      execSync(`tar -xzf "${tmpPath}" -C "${this.singboxDir}"`, { timeout: 60000 })
      unlinkSync(tmpPath)
      const extracted = join(this.singboxDir, filename, 'sing-box')
      if (existsSync(extracted)) {
        const { copyFileSync } = require('fs') as typeof import('fs')
        copyFileSync(extracted, this.binaryPath)
        chmodSync(this.binaryPath, 0o755)
      }
    }

    if (os.platform() === 'darwin') {
      try { execSync(`xattr -cr "${this.binaryPath}"`, { timeout: 5000 }) } catch { /* ignore */ }
    }

    onProgress?.('Verifying...', 0.9)
    try {
      execSync(`"${this.binaryPath}" version`, { timeout: 5000, encoding: 'utf-8' })
      log.info('SingBox: installed successfully')
    } catch (err) {
      throw new Error(`sing-box verification failed: ${(err as Error).message}`)
    }

    onProgress?.('Ready', 1.0)
  }

  // --- Internal start methods ---

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

    setTimeout(() => {
      if (this._status === 'starting' && this.process) {
        this._status = 'running'
      }
    }, 2000)
  }

  /**
   * Start sing-box via osascript (macOS sudo).
   * Returns a Promise that resolves when sing-box is confirmed running.
   */
  private startWithSudo(): Promise<void> {
    return new Promise((resolve, reject) => {
      const safeBin = this.binaryPath.replace(/'/g, "'\\''")
      const safeCfg = this.configPath.replace(/'/g, "'\\''")
      const safePid = this.pidFilePath.replace(/'/g, "'\\''")
      const logFile = join(this.singboxDir, 'sing-box.log').replace(/'/g, "'\\''")
      // Start sing-box in background, write PID, then monitor parent (Electron) process.
      // When parent dies (app crash/force-quit), the watchdog loop detects it and kills sing-box.
      // This prevents process leak when before-quit cleanup fails.
      const parentPid = process.pid
      const shellCmd = `'${safeBin}' run -c '${safeCfg}' > '${logFile}' 2>&1 & SB_PID=$!; echo $SB_PID > '${safePid}'; while kill -0 ${parentPid} 2>/dev/null && kill -0 $SB_PID 2>/dev/null; do sleep 2; done; kill -TERM $SB_PID 2>/dev/null; kill -9 $SB_PID 2>/dev/null`

      let settled = false
      let pidPollInterval: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (pidPollInterval) { clearInterval(pidPollInterval); pidPollInterval = null }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      }

      const settle = (ok: boolean, err?: string) => {
        if (settled) return
        settled = true
        cleanup()
        if (ok) {
          this._status = 'running'
          log.info('[sing-box] confirmed running via PID file')
          resolve()
        } else {
          this._status = 'error'
          this._lastError = err || 'Failed to start sing-box'
          log.error(`[sing-box] startWithSudo failed: ${err}`)
          reject(new Error(err))
        }
      }

      try {
        this.process = spawn('osascript', [
          '-e', `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`,
        ], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        // Poll for PID file (written after user enters password)
        pidPollInterval = setInterval(() => {
          const pid = this.readPidFile()
          if (pid > 0) {
            if (this.isProcessAlive(pid)) {
              settle(true)
            } else {
              settle(false, 'sing-box exited immediately after start')
            }
          }
        }, 300)

        // Timeout: 60s
        timeoutTimer = setTimeout(() => {
          settle(false, 'Timed out waiting for sing-box to start (60s)')
        }, 60000)

        this.process.on('exit', (code) => {
          this.process = null
          // Check if sing-box is alive (runs as separate root process)
          const pid = this.readPidFile()
          if (pid > 0 && this.isProcessAlive(pid)) {
            settle(true)
            return
          }
          if (!settled) {
            settle(false, code === 0 ? 'sing-box exited' : `osascript exited with code ${code}`)
          }
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim()
          if (msg) log.warn(`[sing-box sudo] ${msg}`)
          if (msg.includes('User canceled')) {
            this._status = 'stopped'
            this._lastError = 'User canceled admin authorization'
            settle(false, 'User canceled')
          }
        })

      } catch (err) {
        settle(false, (err as Error).message)
      }
    })
  }

  /** Start sing-box via PowerShell UAC (Windows). Event-driven like startWithSudo. */
  private startWithAdmin(): Promise<void> {
    return new Promise((resolve, reject) => {
      const safeBin = this.binaryPath.replace(/'/g, "''")
      const safeCfg = this.configPath.replace(/'/g, "''")
      const pidFile = this.pidFilePath.replace(/'/g, "''")
      // Start sing-box elevated, write PID, then monitor parent (Electron) process.
      // When parent dies, the watchdog kills sing-box to prevent process leak.
      const parentPid = process.pid
      const wrapper = `$p = Start-Process -FilePath '${safeBin}' -ArgumentList 'run','-c','${safeCfg}' -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id | Out-File -Encoding ascii '${pidFile}'; while ((Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 2 }; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue`

      let settled = false
      let pidPollInterval: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (pidPollInterval) { clearInterval(pidPollInterval); pidPollInterval = null }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      }

      const settle = (ok: boolean, err?: string) => {
        if (settled) return
        settled = true
        cleanup()
        if (ok) {
          this._status = 'running'
          log.info('[sing-box] confirmed running via PID file (Windows)')
          resolve()
        } else {
          this._status = 'error'
          this._lastError = err || 'Failed to start sing-box'
          log.error(`[sing-box] startWithAdmin failed: ${err}`)
          reject(new Error(err))
        }
      }

      try {
        this.process = spawn('powershell', ['-NoProfile', '-Command', wrapper], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })

        pidPollInterval = setInterval(() => {
          const pid = this.readPidFile()
          if (pid > 0) {
            if (this.isProcessAlive(pid)) {
              settle(true)
            } else {
              settle(false, 'sing-box exited immediately after start')
            }
          }
        }, 300)

        timeoutTimer = setTimeout(() => {
          settle(false, 'Timed out waiting for sing-box to start (60s)')
        }, 60000)

        this.process.on('exit', (code) => {
          this.process = null
          const pid = this.readPidFile()
          if (pid > 0 && this.isProcessAlive(pid)) {
            settle(true)
            return
          }
          if (!settled) {
            settle(false, code === 0 ? 'sing-box exited' : `PowerShell exited with code ${code}`)
          }
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim()
          if (msg) {
            this._lastError = msg
            log.warn(`[sing-box admin] ${msg}`)
          }
        })

      } catch (err) {
        settle(false, (err as Error).message)
      }
    })
  }
}
