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
import { execSync, execFile, execFileSync, spawn, type ChildProcess } from 'child_process'
import * as os from 'os'
import * as dns from 'dns'
import { promisify } from 'util'
import log from '../logger'
import { fetchWithTimeout } from '../utils/fetch'

const dnsResolve4 = promisify(dns.resolve4)
const execFileAsync = promisify(execFile)

const TUN_VERSION = '2.14.4'
const TUN_MIRROR_BASE = `https://inkess-install-file.oss-cn-beijing.aliyuncs.com/tun-mirror/${TUN_VERSION}`

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
  private _startPromise: Promise<void> | null = null

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
      return `${TUN_MIRROR_BASE}/hev-socks5-tunnel-${suffix}`
    }
    if (platform === 'win32') {
      return `${TUN_MIRROR_BASE}/hev-socks5-tunnel-win64.zip`
    }
    // Linux fallback
    return `${TUN_MIRROR_BASE}/hev-socks5-tunnel-linux-x86_64`
  }

  isInstalled(): boolean {
    return existsSync(this.binaryPath)
  }

  // --- Config generation ---

  /**
   * Generate YAML config for hev-socks5-tunnel.
   * proxyHost/proxyPort: the upstream SOCKS5 proxy to tunnel through.
   */
  private generateConfig(socksHost: string, socksPort: number, username?: string, password?: string): string {
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
    ]
    // YAML-escape credentials (single-quote, double internal quotes)
    const yamlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`
    if (username) lines.push(`  username: ${yamlStr(username)}`)
    if (password) lines.push(`  password: ${yamlStr(password)}`)
    lines.push(
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
    )
    return lines.join('\n') + '\n'
  }

  // --- Route scripts ---

  /**
   * Generate macOS post-up.sh: set routes + DNS via scutil.
   * proxyIps: resolved IPs of the SOCKS5 proxy server (to bypass TUN).
   */
  private generatePostUpMac(proxyIps: string[]): string {
    const bypassRoutes = proxyIps.map(ip => `route add -host ${ip} "\\$GW"`).join('\n')
    // Get default gateway at script runtime
    return `#!/bin/bash
set -e

# Get default gateway
GW=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
if [ -z "$GW" ]; then
  echo "ERROR: cannot determine default gateway"
  exit 1
fi

# Route proxy host(s) via original gateway (bypass TUN)
${bypassRoutes}

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
  private generatePreDownMac(proxyIps: string[]): string {
    const removeRoutes = proxyIps.map(ip => `route delete -host ${ip} 2>/dev/null || true`).join('\n')
    return `#!/bin/bash
set -e

# Remove routes (ignore errors if already gone)
${removeRoutes}
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
   * Generate Windows post-up.ps1: set routes + DNS on ALL active interfaces.
   */
  private generatePostUpWin(proxyIps: string[]): string {
    const bypassRoutes = proxyIps.map(ip =>
      `New-NetRoute -DestinationPrefix "${ip}/32" -NextHop $gw -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue`
    ).join('\n')
    const dnsBackupPath = join(this.tunDir, 'dns-backup.json').replace(/\\/g, '\\\\')
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

# Route proxy host(s) via original gateway
${bypassRoutes}

# Get TUN interface index
$tunIf = Get-NetAdapter -Name "${TUN_NAME_WIN}" -ErrorAction Stop
$tunIndex = $tunIf.InterfaceIndex

# Split route via TUN
New-NetRoute -DestinationPrefix "0.0.0.0/1" -NextHop ${TUN_IP} -InterfaceIndex $tunIndex -ErrorAction SilentlyContinue
New-NetRoute -DestinationPrefix "128.0.0.0/1" -NextHop ${TUN_IP} -InterfaceIndex $tunIndex -ErrorAction SilentlyContinue

# Backup DNS config of all active adapters, then set DNS system-wide
$activeAdapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
$dnsBackup = @()
foreach ($adapter in $activeAdapters) {
    $dnsConfig = Get-DnsClientServerAddress -InterfaceIndex $adapter.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
    $dnsBackup += @{
        InterfaceIndex = $adapter.InterfaceIndex
        InterfaceName  = $adapter.Name
        ServerAddresses = @($dnsConfig.ServerAddresses)
    }
    Set-DnsClientServerAddress -InterfaceIndex $adapter.InterfaceIndex -ServerAddresses ("${FAKE_DNS_IP}")
}
$dnsBackup | ConvertTo-Json -Depth 3 | Set-Content -Path "${dnsBackupPath}" -Encoding UTF8

# Flush DNS cache
Clear-DnsClientCache

Write-Host "post-up: routes and DNS configured ($($activeAdapters.Count) adapters)"
`
  }

  /**
   * Generate Windows pre-down.ps1: remove routes + restore DNS from backup.
   */
  private generatePreDownWin(proxyIps: string[]): string {
    const removeRoutes = proxyIps.map(ip =>
      `Remove-NetRoute -DestinationPrefix "${ip}/32" -Confirm:$false`
    ).join('\n')
    const dnsBackupPath = join(this.tunDir, 'dns-backup.json').replace(/\\/g, '\\\\')
    return `# pre-down.ps1 - clean up routes and DNS
$ErrorActionPreference = "SilentlyContinue"

# Remove bypass routes
${removeRoutes}
Remove-NetRoute -DestinationPrefix "0.0.0.0/1" -Confirm:$false
Remove-NetRoute -DestinationPrefix "128.0.0.0/1" -Confirm:$false

# Restore DNS from backup if available
$backupPath = "${dnsBackupPath}"
if (Test-Path $backupPath) {
    $dnsBackup = Get-Content -Path $backupPath -Raw | ConvertFrom-Json
    foreach ($entry in $dnsBackup) {
        if ($entry.ServerAddresses -and $entry.ServerAddresses.Count -gt 0) {
            Set-DnsClientServerAddress -InterfaceIndex $entry.InterfaceIndex -ServerAddresses $entry.ServerAddresses
        } else {
            Set-DnsClientServerAddress -InterfaceIndex $entry.InterfaceIndex -ResetServerAddresses
        }
    }
    Remove-Item -Path $backupPath -Force
} else {
    # Fallback: reset DNS on all active adapters
    $activeAdapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
    foreach ($adapter in $activeAdapters) {
        Set-DnsClientServerAddress -InterfaceIndex $adapter.InterfaceIndex -ResetServerAddresses
    }
}

# Flush DNS cache
Clear-DnsClientCache

Write-Host "pre-down: routes and DNS cleaned up"
`
  }

  /**
   * Resolve a hostname to all IPv4 addresses.
   * Falls back to the hostname itself if resolution fails (might already be an IP).
   */
  private async resolveAllIps(host: string): Promise<string[]> {
    // If already an IP, return as-is
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [host]
    // Validate hostname format to prevent injection
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}[a-zA-Z0-9]$/.test(host)) {
      log.warn(`[tun] invalid hostname format: ${host}`)
      return [host]
    }
    try {
      const addresses = await dnsResolve4(host)
      if (addresses.length > 0) {
        log.info(`[tun] resolved ${host} → ${addresses.join(', ')}`)
        return addresses
      }
    } catch (err) {
      log.warn(`[tun] DNS resolve failed for ${host}: ${(err as Error).message}`)
    }
    return [host]
  }

  /**
   * Parse a SOCKS5 proxy URL into host and port.
   * Supports: socks5://host:port, socks5://user:pass@host:port
   */
  private parseSocksUrl(proxyUrl: string): { host: string; port: number; username?: string; password?: string } {
    try {
      const url = new URL(proxyUrl)
      return {
        host: url.hostname,
        port: parseInt(url.port) || 1080,
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
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
  private async writeConfigAndScripts(proxyUrl: string): Promise<void> {
    const { host, port, username, password } = this.parseSocksUrl(proxyUrl)
    const proxyIps = await this.resolveAllIps(host)

    // Write YAML config — use first resolved IP to prevent DNS circular dependency
    // (TUN hijacks DNS to fake DNS, so hostname would fail to resolve)
    const config = this.generateConfig(proxyIps[0], port, username, password)
    writeFileSync(this.configPath, config, { mode: 0o600 })
    log.info(`[tun] config written to ${this.configPath}`)

    // Write route scripts
    if (os.platform() === 'win32') {
      writeFileSync(this.postUpPath, this.generatePostUpWin(proxyIps))
      writeFileSync(this.preDownPath, this.generatePreDownWin(proxyIps))
    } else {
      writeFileSync(this.postUpPath, this.generatePostUpMac(proxyIps))
      writeFileSync(this.preDownPath, this.generatePreDownMac(proxyIps))
      chmodSync(this.postUpPath, 0o755)
      chmodSync(this.preDownPath, 0o755)
    }
    log.info(`[tun] route scripts written (${proxyIps.length} bypass IPs)`)
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
          // Don't set mode=tun/status=running — routes/DNS may be stale.
          // startTun() will call stop() which uses sudo to properly kill and re-setup.
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
        // Use execFileSync to avoid shell parsing issues with spaces in path
        const safeScript = this.preDownPath.replace(/'/g, "'\\''")
        execFileSync('osascript', [
          '-e',
          `do shell script "bash '${safeScript}'" with administrator privileges`,
        ], { timeout: 15000, stdio: 'pipe' })
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
    // Mutex: prevent concurrent startTun calls
    if (this._startPromise) {
      await this._startPromise
      return
    }
    this._startPromise = this._startTunImpl(proxyUrl)
    try {
      await this._startPromise
    } finally {
      this._startPromise = null
    }
  }

  private async _startTunImpl(proxyUrl: string): Promise<void> {
    this.reconcileStatus()
    if (this._status === 'running') {
      log.info(`[tun] startTun skipped -- already running`)
      return
    }

    await this.ensureInstalled()
    await this.stop()

    await this.writeConfigAndScripts(proxyUrl)

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
        // Use async execFile to avoid blocking the main process.
        // curl as a separate process uses system routes (0.0.0.0/1 + 128.0.0.0/1 → TUN),
        // unlike Electron's built-in fetch which may bypass TUN due to DNS caching.
        await execFileAsync('curl', [
          '-sI', '--connect-timeout', '8',
          'https://www.google.com/generate_204',
        ], { timeout: 10000 })
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
      const logFile = join(this.tunDir, 'tun.log')
      const parentPid = process.pid
      const runScript = join(this.tunDir, 'run-tun.sh')

      // Write shell command to a temp script to avoid injection risks
      // in osascript's double-quote context (paths could contain $, `, \, ")
      const esc = (s: string): string => s.replace(/'/g, "'\\''")
      const script = [
        '#!/bin/bash',
        'set -e',
        '',
        '# Start hev-socks5-tunnel (daemonizes, writes PID file)',
        `'${esc(this.binaryPath)}' '${esc(this.configPath)}'`,
        'sleep 1',
        '',
        '# Read daemon PID',
        `TUN_PID=$(cat '${esc(this.pidFilePath)}' 2>/dev/null)`,
        'if [ -z "$TUN_PID" ]; then',
        `  echo "ERROR: no PID file" >> '${esc(logFile)}'`,
        '  exit 1',
        'fi',
        '',
        '# Configure routes and DNS',
        `bash '${esc(this.postUpPath)}' >> '${esc(logFile)}' 2>&1 || true`,
        '',
        '# Watchdog: monitor parent (Electron) and tunnel daemon',
        `while kill -0 ${parentPid} 2>/dev/null && kill -0 $TUN_PID 2>/dev/null; do`,
        '  sleep 2',
        'done',
        '',
        '# Cleanup: remove routes/DNS and kill tunnel',
        `bash '${esc(this.preDownPath)}' >> '${esc(logFile)}' 2>&1 || true`,
        'kill -TERM $TUN_PID 2>/dev/null; sleep 1; kill -9 $TUN_PID 2>/dev/null',
      ].join('\n') + '\n'
      writeFileSync(runScript, script, { mode: 0o755 })

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
        // Run the script via osascript with admin privileges.
        // The script path is under {userData}/tun/ (safe, no special chars).
        const safeScript = esc(runScript)
        this.process = spawn(
          'osascript',
          [
            '-e',
            `do shell script "bash '${safeScript}'" with administrator privileges`,
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

      const safePid = this.pidFilePath.replace(/'/g, "''")

      // PowerShell: start elevated, wait for PID file, run post-up, watchdog, pre-down on exit
      const wrapper = [
        `$p = Start-Process -FilePath '${safeBin}' -ArgumentList '${safeCfg}' -Verb RunAs -WindowStyle Hidden -PassThru`,
        // Wait for PID file (up to 10s) instead of fixed 1s sleep
        `for ($i = 0; $i -lt 20; $i++) { if (Test-Path '${safePid}') { break }; Start-Sleep -Milliseconds 500 }`,
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
