import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
  readFileSync,
} from 'fs'
import { execSync, spawn, type ChildProcess } from 'child_process'
import * as os from 'os'
import log from '../logger'
import { fetchWithTimeout } from '../utils/fetch'

const TUN_VERSION = '2.14.4'
const TUN_DOWNLOAD_BASE = `https://github.com/heiher/hev-socks5-tunnel/releases/download/${TUN_VERSION}`

// TUN network constants
const TUN_IP = '198.18.0.1'
const FAKE_DNS_IP = '198.18.0.2'
const TUN_NAME_MAC = 'utun99'
const TUN_NAME_WIN = 'tun0'
const CGNAT_RANGE = '100.64.0.0/10'

type TunMode = 'tun' | 'off'

export interface NetworkStatus {
  mode: TunMode
  tunRunning: boolean
  installed: boolean
  lastError: string | null
  internetReachable: boolean | null
  latencyMs: number | null
}

export class TunManager {
  private tunDir: string
  private configPath: string
  private process: ChildProcess | null = null
  private _mode: TunMode = 'off'
  private _status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped'
  private _lastError: string | null = null
  private _internetReachable: boolean | null = null
  private _latencyMs: number | null = null
  private _stopPromise: Promise<void> | null = null

  constructor() {
    this.tunDir = join(app.getPath('userData'), 'tun')
    this.configPath = join(this.tunDir, 'config.yml')
    mkdirSync(this.tunDir, { recursive: true })
  }

  get mode(): TunMode {
    return this._mode
  }
  get status(): string {
    return this._status
  }
  get lastError(): string | null {
    return this._lastError
  }

  private get binaryPath(): string {
    const name = os.platform() === 'win32' ? 'hev-socks5-tunnel.exe' : 'hev-socks5-tunnel'
    return join(this.tunDir, name)
  }

  private get pidFilePath(): string {
    return join(this.tunDir, 'tun.pid')
  }

  private get postUpPath(): string {
    return os.platform() === 'win32'
      ? join(this.tunDir, 'post-up.ps1')
      : join(this.tunDir, 'post-up.sh')
  }

  private get preDownPath(): string {
    return os.platform() === 'win32'
      ? join(this.tunDir, 'pre-down.ps1')
      : join(this.tunDir, 'pre-down.sh')
  }

  private get downloadUrl(): string {
    const platform = os.platform()
    const arch = os.arch()
    if (platform === 'darwin') {
      const suffix = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64'
      return `${TUN_DOWNLOAD_BASE}/hev-socks5-tunnel-${suffix}`
    }
    if (platform === 'win32') {
      return `${TUN_DOWNLOAD_BASE}/hev-socks5-tunnel-win64.zip`
    }
    // Linux fallback
    return `${TUN_DOWNLOAD_BASE}/hev-socks5-tunnel-linux-x86_64`
  }

  isInstalled(): boolean {
    return existsSync(this.binaryPath)
  }

  // --- Config generation ---

  /**
   * Generate YAML config for hev-socks5-tunnel.
   * proxyHost/proxyPort: the upstream SOCKS5 proxy to tunnel through.
   */
  private generateConfig(socksHost: string, socksPort: number): string {
    const tunName = os.platform() === 'win32' ? TUN_NAME_WIN : TUN_NAME_MAC
    const lines = [
      'tunnel:',
      `  name: ${tunName}`,
      '  mtu: 8500',
      '  multi-queue: false',
      `  ipv4: ${TUN_IP}`,
      '',
      'socks5:',
      `  port: ${socksPort}`,
      `  address: ${socksHost}`,
      '  udp: udp',
      '',
      'misc:',
      `  pid-file: ${this.pidFilePath}`,
      '  log-level: info',
      '  limit-nofile: 65535',
      '',
      'dns:',
      `  address: ${FAKE_DNS_IP}`,
      `  ipv4: ${CGNAT_RANGE}`,
    ]
    return lines.join('\n') + '\n'
  }

  // --- Route scripts ---

  /**
   * Generate macOS post-up.sh: set routes + DNS via scutil.
   * proxyHostIp: resolved IP of the SOCKS5 proxy server (to bypass TUN).
   */
  private generatePostUpMac(proxyHostIp: string): string {
    // Get default gateway at script runtime
    return `#!/bin/bash
set -e

# Get default gateway
GW=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
if [ -z "$GW" ]; then
  echo "ERROR: cannot determine default gateway"
  exit 1
fi

# Route proxy host via original gateway (bypass TUN)
route add -host ${proxyHostIp} "\$GW"

# Route all traffic via TUN (split route, don't clobber default)
route add -net 0.0.0.0/1 ${TUN_IP}
route add -net 128.0.0.0/1 ${TUN_IP}

# Set DNS to fake DNS via scutil
scutil <<SCUTIL_EOF
d.init
d.add ServerAddresses * ${FAKE_DNS_IP}
d.add SupplementalMatchDomains * ""
set State:/Network/Service/hev-socks5-tunnel/DNS
SCUTIL_EOF

echo "post-up: routes and DNS configured"
`
  }

  /**
   * Generate macOS pre-down.sh: remove routes + DNS.
   */
  private generatePreDownMac(proxyHostIp: string): string {
    return `#!/bin/bash
set -e

# Remove routes (ignore errors if already gone)
route delete -host ${proxyHostIp} 2>/dev/null || true
route delete -net 0.0.0.0/1 2>/dev/null || true
route delete -net 128.0.0.0/1 2>/dev/null || true

# Remove DNS override
scutil <<SCUTIL_EOF
remove State:/Network/Service/hev-socks5-tunnel/DNS
SCUTIL_EOF

echo "pre-down: routes and DNS cleaned up"
`
  }

  /**
   * Generate Windows post-up.ps1: set routes + DNS.
   */
  private generatePostUpWin(proxyHostIp: string): string {
    return `# post-up.ps1 - configure routes and DNS for TUN
$ErrorActionPreference = "Stop"

# Get default gateway
$defaultRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object -First 1
$gw = $defaultRoute.NextHop
$ifIndex = $defaultRoute.InterfaceIndex

if (-not $gw) {
    Write-Error "Cannot determine default gateway"
    exit 1
}

# Route proxy host via original gateway
New-NetRoute -DestinationPrefix "${proxyHostIp}/32" -NextHop $gw -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue

# Get TUN interface index
$tunIf = Get-NetAdapter -Name "${TUN_NAME_WIN}" -ErrorAction Stop
$tunIndex = $tunIf.InterfaceIndex

# Split route via TUN
New-NetRoute -DestinationPrefix "0.0.0.0/1" -NextHop ${TUN_IP} -InterfaceIndex $tunIndex -ErrorAction SilentlyContinue
New-NetRoute -DestinationPrefix "128.0.0.0/1" -NextHop ${TUN_IP} -InterfaceIndex $tunIndex -ErrorAction SilentlyContinue

# Set DNS on TUN interface
Set-DnsClientServerAddress -InterfaceIndex $tunIndex -ServerAddresses ("${FAKE_DNS_IP}")

Write-Host "post-up: routes and DNS configured"
`
  }

  /**
   * Generate Windows pre-down.ps1: remove routes + DNS.
   */
  private generatePreDownWin(proxyHostIp: string): string {
    return `# pre-down.ps1 - clean up routes and DNS
$ErrorActionPreference = "SilentlyContinue"

Remove-NetRoute -DestinationPrefix "${proxyHostIp}/32" -Confirm:$false
Remove-NetRoute -DestinationPrefix "0.0.0.0/1" -Confirm:$false
Remove-NetRoute -DestinationPrefix "128.0.0.0/1" -Confirm:$false

# Reset DNS on TUN interface
$tunIf = Get-NetAdapter -Name "${TUN_NAME_WIN}"
if ($tunIf) {
    Set-DnsClientServerAddress -InterfaceIndex $tunIf.InterfaceIndex -ResetServerAddresses
}

Write-Host "pre-down: routes and DNS cleaned up"
`
  }

  /**
   * Resolve a hostname to an IP address.
   * Falls back to the hostname itself if resolution fails (might already be an IP).
   */
  private resolveHostToIp(host: string): string {
    // If already an IP, return as-is
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host
    try {
      if (os.platform() === 'win32') {
        const out = execSync(
          `powershell -NoProfile -Command "[System.Net.Dns]::GetHostAddresses('${host.replace(/'/g, "''")}')[0].IPAddressToString"`,
          { timeout: 5000, encoding: 'utf-8' }
        ).trim()
        if (out && /^\d{1,3}(\.\d{1,3}){3}$/.test(out)) return out
      } else {
        const out = execSync(`dig +short "${host}" A | head -1`, {
          timeout: 5000,
          encoding: 'utf-8',
        }).trim()
        if (out && /^\d{1,3}(\.\d{1,3}){3}$/.test(out)) return out
      }
    } catch (err) {
      log.warn(`[tun] DNS resolve failed for ${host}: ${(err as Error).message}`)
    }
    return host
  }

  /**
   * Parse a SOCKS5 proxy URL into host and port.
   * Supports: socks5://host:port, socks5://user:pass@host:port
   */
  private parseSocksUrl(proxyUrl: string): { host: string; port: number } {
    try {
      const url = new URL(proxyUrl)
      return {
        host: url.hostname,
        port: parseInt(url.port) || 1080,
      }
    } catch {
      // Fallback: try to parse as host:port
      const parts = proxyUrl.split(':')
      return {
        host: parts[0] || '127.0.0.1',
        port: parseInt(parts[1]) || 1080,
      }
    }
  }

  /**
   * Write config + route scripts to disk.
   */
  private writeConfigAndScripts(proxyUrl: string): void {
    const { host, port } = this.parseSocksUrl(proxyUrl)
    const proxyHostIp = this.resolveHostToIp(host)

    // Write YAML config
    const config = this.generateConfig(host, port)
    writeFileSync(this.configPath, config)
    log.info(`[tun] config written to ${this.configPath}`)

    // Write route scripts
    if (os.platform() === 'win32') {
      writeFileSync(this.postUpPath, this.generatePostUpWin(proxyHostIp))
      writeFileSync(this.preDownPath, this.generatePreDownWin(proxyHostIp))
    } else {
      writeFileSync(this.postUpPath, this.generatePostUpMac(proxyHostIp))
      writeFileSync(this.preDownPath, this.generatePreDownMac(proxyHostIp))
      chmodSync(this.postUpPath, 0o755)
      chmodSync(this.preDownPath, 0o755)
    }
    log.info(`[tun] route scripts written`)
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
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        timeout: 2000,
        encoding: 'utf-8',
      })
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
      await new Promise((r) => setTimeout(r, 200))
    }
    return !this.isProcessAlive(pid)
  }

  /** Kill a process. If sudo=true, uses osascript/UAC. */
  private killProcess(pid: number, signal: 'TERM' | 'KILL', sudo = true): void {
    const sig = signal === 'KILL' ? '-9' : '-TERM'
    try {
      if (os.platform() === 'win32') {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: 'pipe' })
      } else if (sudo) {
        execSync(
          `osascript -e 'do shell script "kill ${sig} ${pid}" with administrator privileges'`,
          { timeout: 15000, stdio: 'pipe' }
        )
      } else {
        execSync(`kill ${sig} ${pid}`, { timeout: 3000, stdio: 'pipe' })
      }
      log.info(`[tun] killed pid=${pid} signal=${signal}`)
    } catch (err) {
      log.warn(`[tun] kill pid=${pid} signal=${signal} failed: ${(err as Error).message}`)
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
    try {
      unlinkSync(this.pidFilePath)
    } catch {
      /* ignore */
    }
  }

  // --- Public API ---

  /**
   * Clean up stale processes from previous app crashes.
   * Uses non-interactive kill (no sudo dialog).
   */
  async cleanupStaleProcesses(): Promise<void> {
    const pid = this.readPidFile()
    if (pid > 0) {
      if (this.isProcessAlive(pid)) {
        log.info(`[tun] startup cleanup: found stale process pid=${pid}`)
        if (os.platform() === 'win32') {
          try {
            execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'pipe' })
          } catch {
            /* ignore */
          }
        } else {
          this.killProcess(pid, 'TERM', false)
        }
        const dead = await this.waitForProcessDeath(pid, 2000)
        if (!dead) {
          log.info(
            `[tun] startup cleanup: pid=${pid} needs sudo to kill, will clean up on next startTun`
          )
          this._mode = 'tun'
          this._status = 'running'
          return
        }
      }
      // Run pre-down to clean up routes/DNS if scripts exist
      this.runPreDown(false)
      this.removePidFile()
    }

    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
  }

  /**
   * Stop the TUN tunnel. Async -- waits for process to be confirmed dead.
   * Safe to call multiple times (mutex prevents concurrent stop).
   */
  async stop(): Promise<void> {
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
    log.info(`[tun] stop() called, mode=${this._mode} status=${this._status}`)

    // Run pre-down script to remove routes/DNS before killing the process
    this.runPreDown(true)

    // Kill the osascript/powershell wrapper process (if any)
    const proc = this.process
    this.process = null
    if (proc) {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }

    // Kill the actual tunnel root process via PID file
    const pid = this.readPidFile()
    if (pid > 0 && this.isProcessAlive(pid)) {
      log.info(`[tun] stopping pid=${pid} with SIGTERM...`)
      this.killProcess(pid, 'TERM')
      const dead = await this.waitForProcessDeath(pid, 5000)

      if (!dead) {
        log.warn(`[tun] pid=${pid} still alive after SIGTERM, sending SIGKILL`)
        this.killProcess(pid, 'KILL')
        const killed = await this.waitForProcessDeath(pid, 3000)
        if (!killed) {
          log.error(`[tun] FAILED to kill pid=${pid} -- process may be orphaned`)
        }
      }
      log.info(`[tun] pid=${pid} confirmed dead`)
    }

    this.removePidFile()
    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
    this._internetReachable = null
    this._latencyMs = null
  }

  /**
   * Run pre-down script to clean up routes and DNS.
   * sudo: whether to run with admin privileges.
   */
  private runPreDown(sudo: boolean): void {
    if (!existsSync(this.preDownPath)) return
    try {
      if (os.platform() === 'win32') {
        execSync(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${this.preDownPath}"`,
          { timeout: 10000, stdio: 'pipe' }
        )
      } else if (sudo) {
        const safeScript = this.preDownPath.replace(/'/g, "'\\''")
        execSync(
          `osascript -e 'do shell script "bash \\'${safeScript}\\'" with administrator privileges'`,
          { timeout: 15000, stdio: 'pipe' }
        )
      } else {
        execSync(`bash "${this.preDownPath}"`, { timeout: 10000, stdio: 'pipe' })
      }
      log.info('[tun] pre-down script executed')
    } catch (err) {
      log.warn(`[tun] pre-down script failed: ${(err as Error).message}`)
    }
  }

  /**
   * Run post-up script to configure routes and DNS.
   */
  private runPostUp(): void {
    if (!existsSync(this.postUpPath)) return
    try {
      if (os.platform() === 'win32') {
        execSync(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${this.postUpPath}"`,
          { timeout: 10000, stdio: 'pipe' }
        )
      } else {
        // post-up runs inside the sudo shell, not separately
        // This is handled in startWithSudo shell command
        log.info('[tun] post-up will run inside sudo shell')
      }
    } catch (err) {
      log.warn(`[tun] post-up script failed: ${(err as Error).message}`)
    }
  }

  /**
   * Start TUN tunnel (requires admin/root).
   * Blocks until confirmed running or fails.
   */
  async startTun(proxyUrl: string): Promise<void> {
    this.reconcileStatus()
    if (this._status === 'starting' || this._status === 'running') {
      log.info(`[tun] startTun skipped -- status=${this._status}`)
      return
    }

    await this.ensureInstalled()
    await this.stop()

    this.writeConfigAndScripts(proxyUrl)

    this._mode = 'tun'
    this._status = 'starting'

    if (os.platform() === 'darwin') {
      await this.startWithSudo()
    } else if (os.platform() === 'win32') {
      await this.startWithAdmin()
    } else {
      this.startDirect()
    }
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
      this.removePidFile()
    }
    if (this._status === 'running') {
      this._status = 'stopped'
      this._mode = 'off'
      this._internetReachable = null
      this._latencyMs = null
    }
  }

  /** Unified network status -- single source of truth */
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

  /** Test internet connectivity through TUN. Updates internal state. */
  async testConnectivity(): Promise<{ success: boolean; latency?: number; error?: string }> {
    this.reconcileStatus()
    if (this._status !== 'running') {
      this._internetReachable = false
      this._latencyMs = null
      log.info(`[testConnectivity] skipped -- TUN status=${this._status}`)
      return { success: false, error: 'TUN is not running' }
    }

    try {
      const start = Date.now()
      log.info('[testConnectivity] testing connectivity...')
      if (os.platform() === 'win32') {
        const res = await fetchWithTimeout('https://www.google.com/generate_204', {}, 10000)
        if (res.status !== 204 && res.status !== 200) throw new Error(`HTTP ${res.status}`)
      } else {
        execSync('curl -sI --connect-timeout 8 https://www.google.com/generate_204', {
          timeout: 10000,
          stdio: 'pipe',
        })
      }
      const latency = Date.now() - start
      log.info(`[testConnectivity] ok latency=${latency}ms`)
      this._internetReachable = true
      this._latencyMs = latency
      return { success: true, latency }
    } catch (err) {
      log.error('[testConnectivity] failed:', (err as Error).message)
      this._internetReachable = false
      this._latencyMs = null
      return { success: false, error: (err as Error).message }
    }
  }

  // --- Install ---

  async install(onProgress?: (step: string, pct: number) => void): Promise<void> {
    const url = this.downloadUrl
    const isZip = url.endsWith('.zip')

    onProgress?.('Downloading hev-socks5-tunnel...', 0.1)
    log.info(`[tun] downloading ${url}`)

    const res = await fetchWithTimeout(url, {}, 300000)
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)

    const { createWriteStream } = require('fs') as typeof import('fs')
    const { pipeline } = require('stream/promises') as typeof import('stream/promises')
    const { Readable } = require('stream') as typeof import('stream')

    if (isZip) {
      // Windows: download zip, extract
      const zipPath = join(this.tunDir, 'hev-socks5-tunnel.zip')
      const fileStream = createWriteStream(zipPath)
      await pipeline(Readable.fromWeb(res.body as any), fileStream)

      onProgress?.('Extracting...', 0.7)
      try {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${this.tunDir.replace(/'/g, "''")}'"`,
          { timeout: 120000 }
        )
      } finally {
        try {
          unlinkSync(zipPath)
        } catch {
          /* ignore */
        }
      }

      // Move extracted binary to expected location
      const extracted = join(this.tunDir, 'hev-socks5-tunnel.exe')
      if (!existsSync(extracted)) {
        // Try finding it in a subdirectory
        const { readdirSync, copyFileSync } = require('fs') as typeof import('fs')
        const entries = readdirSync(this.tunDir)
        for (const entry of entries) {
          const candidate = join(this.tunDir, entry, 'hev-socks5-tunnel.exe')
          if (existsSync(candidate)) {
            copyFileSync(candidate, this.binaryPath)
            break
          }
        }
      }
    } else {
      // macOS/Linux: direct binary download
      const tmpPath = join(this.tunDir, 'hev-socks5-tunnel.tmp')
      const fileStream = createWriteStream(tmpPath)
      await pipeline(Readable.fromWeb(res.body as any), fileStream)

      onProgress?.('Installing...', 0.7)
      const { renameSync } = require('fs') as typeof import('fs')
      renameSync(tmpPath, this.binaryPath)
      chmodSync(this.binaryPath, 0o755)
    }

    // macOS: remove quarantine attribute
    if (os.platform() === 'darwin') {
      try {
        execSync(`xattr -cr "${this.binaryPath}"`, { timeout: 5000 })
      } catch {
        /* ignore */
      }
    }

    onProgress?.('Verifying...', 0.9)
    // hev-socks5-tunnel has no --version flag; just verify the binary exists and is executable
    if (!existsSync(this.binaryPath)) {
      throw new Error('hev-socks5-tunnel binary not found after installation')
    }
    log.info('[tun] hev-socks5-tunnel installed successfully')

    onProgress?.('Ready', 1.0)
  }

  // --- Internal start methods ---

  private async ensureInstalled(): Promise<void> {
    if (!this.isInstalled()) {
      await this.install()
    }
  }

  /**
   * Start directly (Linux, no elevation needed if running as root).
   */
  private startDirect(): void {
    this.process = spawn(this.binaryPath, [this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log.info(`[tun] ${msg}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log.warn(`[tun] ${msg}`)
      this._lastError = msg
    })

    this.process.on('exit', (code) => {
      log.info(`[tun] exited with code ${code}`)
      this._status = code === 0 ? 'stopped' : 'error'
      this.process = null
    })

    // hev-socks5-tunnel writes PID file; poll for it
    setTimeout(() => {
      if (this._status === 'starting') {
        const pid = this.readPidFile()
        if (pid > 0 && this.isProcessAlive(pid)) {
          this._status = 'running'
        }
      }
    }, 2000)
  }

  /**
   * Start via osascript (macOS sudo).
   * The shell command: starts tunnel, runs post-up, then monitors parent process (watchdog).
   * When parent dies, runs pre-down and kills tunnel.
   */
  private startWithSudo(): Promise<void> {
    return new Promise((resolve, reject) => {
      const safeBin = this.binaryPath.replace(/'/g, "'\\''")
      const safeCfg = this.configPath.replace(/'/g, "'\\''")
      const safePostUp = this.postUpPath.replace(/'/g, "'\\''")
      const safePreDown = this.preDownPath.replace(/'/g, "'\\''")
      const logFile = join(this.tunDir, 'tun.log').replace(/'/g, "'\\''")
      const parentPid = process.pid

      // Shell command:
      // 1. Start hev-socks5-tunnel in background (it writes its own PID file)
      // 2. Wait briefly for PID file to appear
      // 3. Run post-up script (routes + DNS)
      // 4. Watchdog loop: monitor parent (Electron) and tunnel process
      // 5. On exit: run pre-down, kill tunnel
      const shellCmd = [
        `'${safeBin}' '${safeCfg}' > '${logFile}' 2>&1 &`,
        'TUN_PID=$!',
        'sleep 1', // wait for PID file
        `bash '${safePostUp}' >> '${logFile}' 2>&1 || true`,
        `while kill -0 ${parentPid} 2>/dev/null && kill -0 $TUN_PID 2>/dev/null; do sleep 2; done`,
        `bash '${safePreDown}' >> '${logFile}' 2>&1 || true`,
        'kill -TERM $TUN_PID 2>/dev/null',
        'kill -9 $TUN_PID 2>/dev/null',
      ].join('; ')

      let settled = false
      let pidPollInterval: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (pidPollInterval) {
          clearInterval(pidPollInterval)
          pidPollInterval = null
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
      }

      const settle = (ok: boolean, err?: string): void => {
        if (settled) return
        settled = true
        cleanup()
        if (ok) {
          this._status = 'running'
          log.info('[tun] confirmed running via PID file')
          resolve()
        } else {
          this._status = 'error'
          this._lastError = err || 'Failed to start tunnel'
          log.error(`[tun] startWithSudo failed: ${err}`)
          reject(new Error(err))
        }
      }

      try {
        this.process = spawn(
          'osascript',
          [
            '-e',
            `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )

        // Poll for PID file
        pidPollInterval = setInterval(() => {
          const pid = this.readPidFile()
          if (pid > 0) {
            if (this.isProcessAlive(pid)) {
              settle(true)
            } else {
              settle(false, 'hev-socks5-tunnel exited immediately after start')
            }
          }
        }, 300)

        // Timeout: 60s
        timeoutTimer = setTimeout(() => {
          settle(false, 'Timed out waiting for tunnel to start (60s)')
        }, 60000)

        this.process.on('exit', (code) => {
          this.process = null
          const pid = this.readPidFile()
          if (pid > 0 && this.isProcessAlive(pid)) {
            settle(true)
            return
          }
          if (!settled) {
            settle(
              false,
              code === 0 ? 'tunnel exited' : `osascript exited with code ${code}`
            )
          }
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim()
          if (msg) log.warn(`[tun sudo] ${msg}`)
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

  /** Start via PowerShell UAC (Windows). */
  private startWithAdmin(): Promise<void> {
    return new Promise((resolve, reject) => {
      const safeBin = this.binaryPath.replace(/'/g, "''")
      const safeCfg = this.configPath.replace(/'/g, "''")
      const safePostUp = this.postUpPath.replace(/'/g, "''")
      const safePreDown = this.preDownPath.replace(/'/g, "''")
      const parentPid = process.pid

      // PowerShell: start elevated, run post-up, watchdog, pre-down on exit
      const wrapper = [
        `$p = Start-Process -FilePath '${safeBin}' -ArgumentList '${safeCfg}' -Verb RunAs -WindowStyle Hidden -PassThru`,
        `Start-Sleep -Seconds 1`,
        `& '${safePostUp}'`,
        `while ((Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 2 }`,
        `& '${safePreDown}'`,
        `Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue`,
      ].join('; ')

      let settled = false
      let pidPollInterval: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (pidPollInterval) {
          clearInterval(pidPollInterval)
          pidPollInterval = null
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
      }

      const settle = (ok: boolean, err?: string): void => {
        if (settled) return
        settled = true
        cleanup()
        if (ok) {
          this._status = 'running'
          log.info('[tun] confirmed running via PID file (Windows)')
          resolve()
        } else {
          this._status = 'error'
          this._lastError = err || 'Failed to start tunnel'
          log.error(`[tun] startWithAdmin failed: ${err}`)
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
              settle(false, 'hev-socks5-tunnel exited immediately after start')
            }
          }
        }, 300)

        timeoutTimer = setTimeout(() => {
          settle(false, 'Timed out waiting for tunnel to start (60s)')
        }, 60000)

        this.process.on('exit', (code) => {
          this.process = null
          const pid = this.readPidFile()
          if (pid > 0 && this.isProcessAlive(pid)) {
            settle(true)
            return
          }
          if (!settled) {
            settle(
              false,
              code === 0 ? 'tunnel exited' : `PowerShell exited with code ${code}`
            )
          }
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim()
          if (msg) {
            this._lastError = msg
            log.warn(`[tun admin] ${msg}`)
          }
        })
      } catch (err) {
        settle(false, (err as Error).message)
      }
    })
  }
}
