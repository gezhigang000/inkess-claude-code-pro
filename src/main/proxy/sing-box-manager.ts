import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync, readFileSync } from 'fs'
import { execSync, execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'
import log from '../logger'
import { buildTunConfig, buildLocalProxyConfig, type SingBoxConfig, type SingBoxOutbound, type TunConfigOptions } from './sing-box-config'
import { parseStaleSingBoxInterfaces, parseStaleSingBoxRouteCount } from './sing-box-stale-state'
import { fetchWithTimeout } from '../utils/fetch'

const execFileAsync = promisify(execFile)

// DNS server to set via scutil — any routable IP works because sing-box
// hijack-dns intercepts ALL DNS queries (UDP 53) at the route level.
// FakeIP returns instant fake IPs; real resolution happens on the proxy server.
const SYSTEM_DNS_OVERRIDE = '8.8.8.8'

const SINGBOX_VERSION = '1.11.15'
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
  private _startPromise: Promise<{ success?: boolean; error?: string }> | null = null
  private _interfaceMonitor: ReturnType<typeof setInterval> | null = null
  private _baselineInterfaces: Set<string> = new Set()
  private _onInterfaceAlert: ((newInterfaces: string[]) => void) | null = null
  private _baselineTimer: ReturnType<typeof setTimeout> | null = null

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

  private get versionMarkerPath(): string {
    return join(this.singboxDir, '.version')
  }

  isInstalled(): boolean {
    return existsSync(this.binaryPath)
  }

  /** Check if installed version matches expected version */
  private isVersionMatch(): boolean {
    try {
      const marker = readFileSync(this.versionMarkerPath, 'utf-8').trim()
      return marker === SINGBOX_VERSION
    } catch { return false }
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
        if (sudo) {
          // Elevated kill via PowerShell — required for elevated sing-box process
          // Always use /F: taskkill without /F only sends WM_CLOSE which doesn't work
          // for headless processes (-WindowStyle Hidden). sing-box has no console window.
          execSync(
            `powershell -NoProfile -Command "Start-Process -FilePath 'taskkill' -ArgumentList '/F','/PID','${pid}' -Verb RunAs -WindowStyle Hidden -Wait"`,
            { timeout: 15000, stdio: 'pipe' }
          )
        } else {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: 'pipe' })
        }
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

  /** Read last N lines of sing-box log (for error reporting). */
  readRecentLog(maxLines = 30): string {
    try {
      const logPath = join(this.singboxDir, 'sing-box.log')
      if (!existsSync(logPath)) return ''
      const content = readFileSync(logPath, 'utf-8').trim()
      if (!content) return ''
      const lines = content.split('\n')
      return lines.slice(-maxLines).join('\n')
    } catch {
      return ''
    }
  }

  // --- Public API ---

  /**
   * Clean up stale sing-box processes from previous app crashes.
   * Uses non-interactive kill (no sudo dialog). If the root process can't be killed
   * without sudo, it will be killed when startTun() calls stop() with sudo.
   *
   * Also detects and cleans up orphan network state (utun interfaces + split
   * routes) left behind by ungraceful shutdowns — see detectStaleNetworkState().
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

    // After the process is gone (or was never running), check for orphan
    // network state — utun interfaces and split routes left behind by
    // SIGKILL / force-quit scenarios. Cleanup is deferred until startTun()
    // so we don't force a sudo dialog at app launch.
    try {
      const stale = this.detectStaleNetworkState()
      if (stale.hasResiduals) {
        log.warn(
          `[sing-box] startup cleanup: detected stale network state — ` +
          `interfaces=${JSON.stringify(stale.interfaces)} routes=${stale.routeCount}. ` +
          `Will clean up on next startTun().`,
        )
        this._hasStaleNetworkState = true
      }
    } catch (err) {
      log.warn(`[sing-box] detectStaleNetworkState failed: ${(err as Error).message}`)
    }

    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
  }

  /** Set when cleanupStaleProcesses finds orphan network state at startup. */
  private _hasStaleNetworkState = false

  /**
   * Scan the system for orphan sing-box network state — utun interfaces with
   * IPs in 198.18.0.0/15 (sing-box's default TUN subnet) and split-default
   * routes (0.0.0.0/1 + 128.0.0.0/1 via 198.18.0.1). These linger when
   * sing-box is killed by SIGKILL before its own cleanup handlers run.
   *
   * Detection-only: caller decides whether to attempt a cleanup.
   * macOS only — Windows uses WFP rules (different failure mode).
   */
  private detectStaleNetworkState(): {
    hasResiduals: boolean
    interfaces: string[]
    routeCount: number
  } {
    const empty = { hasResiduals: false, interfaces: [] as string[], routeCount: 0 }
    if (os.platform() !== 'darwin') return empty

    let ifconfigOut = ''
    try {
      ifconfigOut = execSync('ifconfig', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    } catch { return empty }

    const interfaces = parseStaleSingBoxInterfaces(ifconfigOut)

    let routeCount = 0
    try {
      const routeOut = execSync('netstat -rn -f inet', {
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString()
      routeCount = parseStaleSingBoxRouteCount(routeOut)
    } catch { /* ignore — route count optional */ }

    return {
      hasResiduals: interfaces.length > 0 || routeCount > 0,
      interfaces,
      routeCount,
    }
  }

  /**
   * Actively clean up orphan network state. Requires sudo (via osascript).
   * Safe to call only when no sing-box process is running — caller must ensure.
   *
   * Deletes split-default routes pointing at 198.18.x.x and destroys utun
   * interfaces in that subnet. Runs inside a single osascript invocation so
   * the user sees exactly one password prompt.
   */
  private async cleanupStaleNetworkState(): Promise<void> {
    if (os.platform() !== 'darwin') return
    const stale = this.detectStaleNetworkState()
    if (!stale.hasResiduals) {
      this._hasStaleNetworkState = false
      return
    }

    log.warn(
      `[sing-box] cleaning up stale network state: ` +
      `interfaces=${JSON.stringify(stale.interfaces)} routes=${stale.routeCount}`,
    )

    // Build a single shell script that tries every common sing-box route +
    // every detected utun. Ignore individual failures — the goal is to leave
    // the system in a clean state, not to verify each operation.
    const splitRoutes = [
      '1', '2/7', '4/6', '8/5', '16/4', '32/3', '64/2', '128.0/1',
    ]
    const routeCleanup = splitRoutes
      .map((net) => `route -n delete -net ${net} 198.18.0.1 2>/dev/null || true`)
      .join('; ')
    const hostRouteCleanup = 'route -n delete -host 198.18.0.1 2>/dev/null || true'
    const ifaceCleanup = stale.interfaces
      .map((iface) => `ifconfig ${iface} destroy 2>/dev/null || true`)
      .join('; ')
    const dnsCleanup = `scutil <<DNSEOF 2>/dev/null
remove State:/Network/Service/sing-box-tun/DNS
DNSEOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`

    const fullScript = `${routeCleanup}; ${hostRouteCleanup}; ${ifaceCleanup}; ${dnsCleanup}`

    try {
      execSync(
        `osascript -e 'do shell script "${fullScript.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges'`,
        { timeout: 30000, stdio: 'pipe' },
      )
      log.info('[sing-box] stale network state cleanup complete')
      this._hasStaleNetworkState = false
    } catch (err) {
      log.error(`[sing-box] stale network state cleanup failed: ${(err as Error).message}`)
      // Don't throw — caller should still attempt to start TUN; worst case
      // the residuals remain and sing-box's own startup will override them.
    }
  }

  /**
   * Stop sing-box. Async — waits for process to be confirmed dead.
   * Safe to call multiple times (mutex prevents concurrent stop).
   */
  /**
   * @param restoreDns - Restore system DNS on stop. Default true.
   *   false: used by startTun restart (keep DNS pointing to sing-box, avoid leak window)
   *   true: used by app quit, tun:stop IPC, logout (restore DNS to system default)
   */
  async stop(restoreDns = true): Promise<void> {
    // Signal any in-progress startTun to abort after its internal stop()
    if (restoreDns) this._stopRequested = true
    // Mutex: if already stopping, wait for that to finish
    if (this._stopPromise) {
      await this._stopPromise
      return
    }
    this._stopPromise = this._stopImpl(restoreDns)
    try {
      await this._stopPromise
    } finally {
      this._stopPromise = null
    }
  }

  // setSystemDns is handled inside the sudo shell command (startWithSudo)
  // to ensure it runs as root. See shellCmd in startWithSudo().

  /** Restore macOS system DNS to default (requires sudo via osascript). */
  private restoreSystemDns(): void {
    if (os.platform() !== 'darwin') return
    try {
      const cmd = `scutil <<EOF
remove State:/Network/Service/sing-box-tun/DNS
EOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`
      execSync(
        `osascript -e 'do shell script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges'`,
        { timeout: 15000, stdio: 'pipe' }
      )
      log.info('[sing-box] system DNS restored (sudo)')
    } catch (err) {
      // May fail if watchdog already cleaned up, or user canceled — that's OK
      log.warn(`[sing-box] failed to restore system DNS: ${(err as Error).message}`)
    }
  }

  private async _stopImpl(restoreDns: boolean): Promise<void> {
    log.info(`[sing-box] stop() called, mode=${this._mode} status=${this._status} restoreDns=${restoreDns}`)
    this.stopInterfaceMonitor()

    // Restore system DNS before killing sing-box (skip on restart to avoid DNS leak window)
    if (restoreDns) this.restoreSystemDns()

    // Kill the osascript/powershell wrapper process (if any)
    const proc = this.process
    this.process = null
    if (proc) {
      if (process.platform === 'win32') {
        try { require('child_process').execSync(`taskkill /F /PID ${proc.pid}`, { stdio: 'pipe' }) } catch { /* ignore */ }
      } else {
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
      }
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
  private _stopRequested = false

  async startTun(proxyUrl: string): Promise<void> {
    // Mutex: if already starting, await the existing promise
    if (this._startPromise) {
      log.info(`[sing-box] startTun — already starting, awaiting existing promise`)
      const result = await this._startPromise
      if (result.error) throw new Error(result.error)
      return
    }

    this._stopRequested = false
    this._startPromise = this._startTunImpl(proxyUrl)
    try {
      const result = await this._startPromise
      if (result.error) throw new Error(result.error)
    } finally {
      this._startPromise = null
    }
  }

  private _tunnelOutbound: SingBoxOutbound | undefined

  /** Set tunnel outbound for chain proxy mode (call before startTun) */
  setTunnelOutbound(outbound: SingBoxOutbound | undefined): void {
    this._tunnelOutbound = outbound
    if (outbound) {
      log.info(`[sing-box] tunnel outbound set: type=${outbound.type}, server=${outbound.server}:${outbound.server_port}`)
    } else {
      log.info(`[sing-box] tunnel outbound cleared (single proxy mode)`)
    }
  }

  private async _startTunImpl(proxyUrl: string): Promise<{ success?: boolean; error?: string }> {
    try {
      this.reconcileStatus()

      await this.ensureInstalled()
      await this.stop(false) // stop without restoring DNS (avoid leak window on restart)

      // Check if an external stop() was requested while we were stopping
      if (this._stopRequested) {
        log.info(`[sing-box] startTun aborted — stop was requested during startup`)
        return { error: 'Start cancelled — stop requested' }
      }

      // After stop() completes, the process is dead. If it was killed
      // ungracefully (SIGKILL, force-quit, user cancelled sudo last time),
      // utun interfaces and split routes may still be lingering. Clean them
      // up now so the new sing-box can claim a fresh interface. Checks both
      // the startup-detected flag and a fresh scan for runtime residuals.
      if (this._hasStaleNetworkState || this.detectStaleNetworkState().hasResiduals) {
        await this.cleanupStaleNetworkState()
      }

      log.info(`[sing-box] building TUN config for proxy: ${proxyUrl.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@')}`)
      const logOutput = join(this.singboxDir, 'sing-box.log')
      // Resolve rule-set directory (pre-bundled geosite-cn.srs + geoip-cn.srs)
      const ruleSetDir = join(process.resourcesPath, 'rule-set')
      const config = buildTunConfig({
        proxyUrl,
        logOutput,
        tunnelOutbound: this._tunnelOutbound,
        ruleSetDir: existsSync(join(ruleSetDir, 'geosite-cn.srs')) ? ruleSetDir : undefined,
      })
      this.writeConfig(config)
      const mode = this._tunnelOutbound ? 'chain (tunnel → proxy)' : 'single proxy'
      log.info(`[sing-box] config written: mode=${mode}, stack=${config.inbounds[0]?.stack}, dns=${config.dns.servers.map(s => s.tag + ':' + s.address).join(', ')}`)
      log.info(`[sing-box] outbound: type=${config.outbounds[0]?.type}, server=${config.outbounds[0]?.server}:${config.outbounds[0]?.server_port}, username=${config.outbounds[0]?.username ? 'set' : 'none'}`)

      this._mode = 'tun'
      this._status = 'starting'

      if (os.platform() === 'darwin') {
        await this.startWithSudo()
      } else if (os.platform() === 'win32') {
        await this.startWithAdmin()
      } else {
        this.startProcess()
      }

      // DNS override is handled inside startWithSudo's shell command (runs as root)
      return { success: true }
    } catch (err) {
      return { error: (err as Error).message }
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
      log.warn(`[sing-box] reconcile: pid=${pid} is dead, cleaning up PID file`)
      this.removePidFile()
    }
    if (this._status === 'running') {
      log.warn(`[sing-box] reconcile: status was running but no live process — marking stopped`)
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
   * Start monitoring for new TUN/utun interfaces.
   * Captures baseline interfaces at start, polls every 10s.
   * Calls onAlert when new TUN-like interfaces appear.
   */
  startInterfaceMonitor(onAlert: (newInterfaces: string[]) => void): void {
    this.stopInterfaceMonitor()
    this._onInterfaceAlert = onAlert

    // Delay baseline capture by 5s — sing-box TUN interface may not appear immediately
    // after PID confirmed. Without delay, sing-box's own utun is misdetected as "external VPN".
    const BASELINE_DELAY = 5000
    const POLL_INTERVAL = 10000

    const baselineTimer = setTimeout(() => {
      this._baselineInterfaces = new Set(Object.keys(os.networkInterfaces()))
      log.info(`[sing-box] interface monitor started, baseline: ${[...this._baselineInterfaces].filter(i => /^(utun|tun)/.test(i)).join(', ') || 'none'}`)

      this._interfaceMonitor = setInterval(() => {
        if (this._status !== 'running') return
        const current = Object.keys(os.networkInterfaces())
        const newTunInterfaces = current.filter(name =>
          !this._baselineInterfaces.has(name) && /^(utun|tun|wintun)/i.test(name)
        )
        if (newTunInterfaces.length > 0) {
          log.warn(`[sing-box] new TUN interface(s) detected: ${newTunInterfaces.join(', ')}`)
          this._onInterfaceAlert?.(newTunInterfaces)
          for (const name of newTunInterfaces) {
            this._baselineInterfaces.add(name)
          }
        }
      }, POLL_INTERVAL)
    }, BASELINE_DELAY)

    // Store timer ref so stopInterfaceMonitor can clear it
    this._baselineTimer = baselineTimer
  }

  /** Stop interface monitor. */
  stopInterfaceMonitor(): void {
    if (this._baselineTimer) {
      clearTimeout(this._baselineTimer)
      this._baselineTimer = null
    }
    if (this._interfaceMonitor) {
      clearInterval(this._interfaceMonitor)
      this._interfaceMonitor = null
    }
    this._onInterfaceAlert = null
    this._baselineInterfaces.clear()
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

      // Use fetch from Electron main process — in TUN mode with auto_route+strict_route,
      // all system traffic goes through sing-box TUN including Electron's fetch.
      // curl subprocess had 10s+ latency issues; fetch is faster and more reliable.
      log.info(`[testConnectivity] fetching https://ip.oxylabs.io/location ...`)
      const res = await fetchWithTimeout('https://ip.oxylabs.io/location', {}, 15000)
      log.info(`[testConnectivity] HTTP ${res.status} (${Date.now() - start}ms)`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const actualIp = data.ip as string

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

  /**
   * Run network diagnostics — tests each hop to identify where latency comes from.
   * Returns timing for: DNS, direct connection, proxy connection, proxy DNS+connect.
   */
  async runDiagnostics(): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = { timestamp: new Date().toISOString(), tunStatus: this._status }

    // 1. DNS resolution speed (local DNS)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('http://114.114.114.114', {}, 5000).catch(() => null)
      results.localDns = { ms: Date.now() - start, ok: !!res }
    } catch { results.localDns = { ms: -1, ok: false } }

    // 2. Direct connection to domestic site (should NOT go through proxy)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://www.baidu.com', {}, 10000)
      results.directDomestic = { ms: Date.now() - start, status: res.status }
    } catch (e) { results.directDomestic = { ms: -1, error: (e as Error).message } }

    // 3. Proxy connection — whitelisted domain (should go through proxy)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://api.anthropic.com', {}, 15000)
      results.proxyForeign = { ms: Date.now() - start, status: res.status }
    } catch (e) { results.proxyForeign = { ms: -1, error: (e as Error).message } }

    // 4. Exit IP check (through proxy)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://ip.oxylabs.io/location', {}, 15000)
      const data = await res.json()
      results.exitIp = { ms: Date.now() - start, ip: data.ip, status: res.status }
    } catch (e) { results.exitIp = { ms: -1, error: (e as Error).message } }

    // 5. Google (through proxy)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://www.google.com', {}, 15000)
      results.proxyGoogle = { ms: Date.now() - start, status: res.status }
    } catch (e) { results.proxyGoogle = { ms: -1, error: (e as Error).message } }

    // 6. Read recent sing-box log (last 20 lines)
    try {
      const logPath = join(this.singboxDir, 'sing-box.log')
      const content = readFileSync(logPath, 'utf-8')
      const lines = content.trim().split('\n')
      results.recentLog = lines.slice(-20)
    } catch { results.recentLog = [] }

    log.info(`[diagnostics] results: ${JSON.stringify(results, null, 2)}`)
    return results
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
          `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${this.singboxDir.replace(/'/g, "''")}'"`
          , { timeout: 120000 }
        )
      } finally {
        try { unlinkSync(zipPath) } catch { /* ignore */ }
      }
      const extractedDir = join(this.singboxDir, filename)
      const extractedExe = join(extractedDir, 'sing-box.exe')
      if (existsSync(extractedExe)) {
        const { copyFileSync, rmSync } = require('fs') as typeof import('fs')
        copyFileSync(extractedExe, this.binaryPath)
        // Copy wintun.dll — required for Windows TUN mode
        const wintunSrc = join(extractedDir, 'wintun.dll')
        if (existsSync(wintunSrc)) {
          copyFileSync(wintunSrc, join(this.singboxDir, 'wintun.dll'))
          log.info('SingBox: wintun.dll copied')
        } else {
          log.warn('SingBox: wintun.dll not found in archive — TUN may not work on Windows')
        }
        // Clean up extracted subdirectory
        try { rmSync(extractedDir, { recursive: true }) } catch { /* ignore */ }
      }
    } else {
      try {
        execSync(`tar -xzf "${tmpPath}" -C "${this.singboxDir}"`, { timeout: 60000 })
      } finally {
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
      }
      const extractedDir = join(this.singboxDir, filename)
      const extracted = join(extractedDir, 'sing-box')
      if (existsSync(extracted)) {
        const { copyFileSync, rmSync } = require('fs') as typeof import('fs')
        copyFileSync(extracted, this.binaryPath)
        chmodSync(this.binaryPath, 0o755)
        // Clean up extracted subdirectory
        try { rmSync(extractedDir, { recursive: true }) } catch { /* ignore */ }
      }
    }

    if (os.platform() === 'darwin') {
      try { execSync(`xattr -cr "${this.binaryPath}"`, { timeout: 5000 }) } catch { /* ignore */ }
    }

    onProgress?.('Verifying...', 0.9)
    try {
      execSync(`"${this.binaryPath}" version`, { timeout: 5000, encoding: 'utf-8' })
      writeFileSync(this.versionMarkerPath, SINGBOX_VERSION)
      log.info(`SingBox: installed v${SINGBOX_VERSION} successfully`)
    } catch (err) {
      throw new Error(`sing-box verification failed: ${(err as Error).message}`)
    }

    onProgress?.('Ready', 1.0)
  }

  // --- Internal start methods ---

  private writeConfig(config: SingBoxConfig): void {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  }

  private async ensureInstalled(): Promise<void> {
    if (!this.isInstalled() || !this.isVersionMatch()) {
      log.info(`SingBox: need install/upgrade to ${SINGBOX_VERSION}`)
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
      // DNS setup (runs as root inside osascript):
      // Set system DNS so macOS mDNSResponder sends DNS through TUN
      // where sing-box hijack-dns intercepts → FakeIP returns instant fake IP
      const dnsSetup = `scutil <<DNSEOF
d.init
d.add ServerAddresses * ${SYSTEM_DNS_OVERRIDE}
d.add SupplementalMatchDomains * ""
set State:/Network/Service/sing-box-tun/DNS
DNSEOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`

      const dnsCleanup = `scutil <<DNSEOF
remove State:/Network/Service/sing-box-tun/DNS
DNSEOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`

      // Shell: start sing-box → write PID → set DNS → watchdog → cleanup DNS + kill
      //
      // Graceful shutdown: after SIGTERM we wait up to ~5 seconds polling for
      // the process to exit before escalating to SIGKILL. This gives sing-box
      // time to run its own cleanup handlers — tear down the TUN interface,
      // remove auto_route entries, and unbind DNS rules. Without this grace
      // period, SIGKILL leaves utun interfaces and /1 split routes behind,
      // black-holing the user's network until manual cleanup.
      const shellCmd = `'${safeBin}' run -c '${safeCfg}' > '${logFile}' 2>&1 & SB_PID=$!; echo $SB_PID > '${safePid}'; sleep 1; ${dnsSetup}; while kill -0 ${parentPid} 2>/dev/null && kill -0 $SB_PID 2>/dev/null; do sleep 2; done; ${dnsCleanup}; kill -TERM $SB_PID 2>/dev/null; for _i in 1 2 3 4 5 6 7 8 9 10; do kill -0 $SB_PID 2>/dev/null || break; sleep 0.5; done; kill -9 $SB_PID 2>/dev/null`

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
      // Note: -Verb RunAs (UAC) conflicts with -RedirectStandardOutput in PowerShell,
      // so sing-box logging is configured via log.output in the JSON config instead.
      const parentPid = process.pid
      // Force UTF-8 output so Chinese Windows (GBK/CP936) error messages don't garble in logs
      const utf8Prefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
      const wrapper = `${utf8Prefix}$p = Start-Process -FilePath '${safeBin}' -ArgumentList 'run','-c','${safeCfg}' -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id | Out-File -Encoding ascii '${pidFile}'; while ((Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 2 }; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue`

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
