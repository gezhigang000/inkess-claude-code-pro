import * as dns from 'dns'
// Force IPv4-first to prevent IPv6 bypassing TUN proxy
dns.setDefaultResultOrder('ipv4first')

import log from './logger'
import { app, BrowserWindow, ipcMain, shell, dialog, Menu, session, nativeImage, clipboard, Notification, powerSaveBlocker } from 'electron'
import { join, resolve, normalize, delimiter, sep } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'
import { execSync } from 'child_process'
import * as os from 'os'
import { PtyManager, buildCleanEnv, DEFAULT_REGION_ENV } from './pty/pty-manager'
import { PtyOutputMonitor, type PtyActivityEvent } from './pty/pty-output-monitor'
import { CliManager } from './cli/cli-manager'
import { ToolsManager } from './tools/tools-manager'
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, onUpdateStatus } from './updater'
import { Analytics } from './analytics'
import { ErrorReporter } from './error-reporter'
import { SessionRecorder } from './session/session-recorder'
import { SubscriptionManager } from './subscription/subscription-manager'
import { getDeviceId } from './subscription/device-id'
import { fetchSubscription, detectRegion } from './proxy/subscription'
import { SingBoxManager } from './proxy/sing-box-manager'
import { StatsCollector } from './stats/stats-collector'
import { BrowserInterceptor } from './browser/browser-interceptor'
import { openBrowserWindow, closeAllBrowserWindows } from './browser/browser-window'

// Disable IPv6 in Chromium to prevent IPv6 traffic bypassing TUN proxy
app.commandLine.appendSwitch('disable-ipv6')

process.on('uncaughtException', (err) => log.error('Uncaught:', err))
process.on('unhandledRejection', (reason) => log.error('Unhandled:', reason))

let mainWindow: BrowserWindow | null = null
const ptyManager = new PtyManager()
const ptyMonitor = new PtyOutputMonitor()
const cliManager = new CliManager()
const toolsManager = new ToolsManager()
const analytics = new Analytics()
const errorReporter = new ErrorReporter()
const sessionRecorder = new SessionRecorder()
const subscriptionManager = new SubscriptionManager()
errorReporter.setTokenGetter(() => subscriptionManager.getSession()?.token ?? null)
const singBoxManager = new SingBoxManager()
// Clean up any stale tunnel processes from previous crashes
singBoxManager.cleanupStaleProcesses().catch(err => {
  log.warn('[startup] Failed to clean up stale tunnel processes:', err)
})
const statsCollector = new StatsCollector()
const browserInterceptor = new BrowserInterceptor()

/** Safely send to renderer, swallowing errors if window is destroyed */
function safeSend(channel: string, ...args: unknown[]): void {
  try {
    mainWindow?.webContents.send(channel, ...args)
  } catch {
    // Window may be destroyed during long-running operations
  }
}

/** Validate that a path is an existing directory (guards pty:create and git:getBranch) */
function isValidDirectory(path: string): boolean {
  try {
    const resolved = resolve(normalize(path))
    return existsSync(resolved) && statSync(resolved).isDirectory()
  } catch {
    return false
  }
}

function createWindow(): void {
  // Set dock/taskbar icon (especially needed in dev mode)
  if (process.platform === 'darwin') {
    const iconPath = join(__dirname, '../../resources/icon-512.png')
    try {
      const icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) app.dock?.setIcon(icon)
    } catch { /* icon file may not exist in some builds */ }
  }

  mainWindow = new BrowserWindow({
    title: 'Inkess Claude Code Pro',
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: '#191919',
    icon: join(__dirname, '../../resources/icon-256.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--platform=${process.platform}`,
        `--homedir=${os.homedir()}`
      ]
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    log.info('Loading renderer URL:', process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const filePath = join(__dirname, '../renderer/index.html')
    log.info('Loading renderer file:', filePath)
    mainWindow.loadFile(filePath)
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error(`Renderer failed to load: ${errorCode} ${errorDescription} URL: ${validatedURL}`)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('Renderer finished loading')
  })

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      log.warn(`[Renderer Console] ${message}`)
    } else {
      log.info(`[R] ${message}`)
    }
  })

  // Prevent Electron from navigating to file:// URLs on drag & drop
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('focus', () => { isWindowFocused = true })
  mainWindow.on('blur', () => { isWindowFocused = false })
}

// IPC: CLI Manager
ipcMain.handle('cli:getInfo', () => {
  return cliManager.getInfo()
})

ipcMain.handle('cli:install', async () => {
  try {
    await cliManager.install((step, progress) => {
      safeSend('cli:installProgress', { step, progress })
    })
    analytics.track('cli_install')
    statsCollector.logEvent('cli:install')
    return { success: true }
  } catch (err) {
    log.error('CLI install failed:', err)
    return { success: false, error: (err as Error).message }
  }
})

ipcMain.handle('cli:checkUpdate', async () => {
  return cliManager.checkUpdate()
})

ipcMain.handle('cli:update', async () => {
  try {
    await cliManager.update((step, progress) => {
      safeSend('cli:updateProgress', { step, progress })
    })
    analytics.track('cli_update')
    statsCollector.logEvent('cli:update')
    return { success: true }
  } catch (err) {
    log.error('CLI update failed:', err)
    return { success: false, error: (err as Error).message }
  }
})

// IPC: Tools Manager
ipcMain.handle('tools:getInfo', () => {
  return toolsManager.getInfo()
})

ipcMain.handle('tools:isAllInstalled', () => {
  return toolsManager.isAllInstalled()
})

ipcMain.handle('tools:install', async () => {
  try {
    await toolsManager.install((step, progress) => {
      safeSend('tools:installProgress', { step, progress })
    })
    analytics.track('tools_install')
    return { success: true }
  } catch (err) {
    log.error('Tools install failed:', err)
    return { success: false, error: (err as Error).message }
  }
})

// IPC: Subscription
ipcMain.handle('subscription:login', async (_event, args: unknown) => {
  const { username, password } = (args || {}) as Record<string, unknown>
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { success: false, error: 'Invalid input' }
  }
  if (username.length === 0 || username.length > 50 || password.length === 0 || password.length > 200) {
    return { success: false, error: 'Invalid input length' }
  }
  const result = await subscriptionManager.login(username, password)
  if (!result.success) {
    errorReporter.reportBizError('login', result.error || 'Unknown login error', {
      username,
      deviceId: getDeviceId(),
      errorCode: result.errorCode,
    })
  }
  return result
})

ipcMain.handle('subscription:checkStatus', async () => {
  return subscriptionManager.checkStatus()
})

ipcMain.handle('subscription:getSession', () => {
  const s = subscriptionManager.getSession()
  return {
    isLoggedIn: subscriptionManager.isLoggedIn(),
    username: subscriptionManager.getUsername(),
    session: s ? {
      plan: s.plan,
      expiresAt: s.expiresAt,
      proxyUrl: s.proxyUrl,
      proxyRegion: s.proxyRegion,
      exitIp: s.exitIp || '',
    } : null,
  }
})

ipcMain.handle('subscription:logout', async () => {
  subscriptionManager.logout()
  claudeCredentials = null
  // Clear Claude browser session cookies on logout
  const { session: electronSession } = require('electron') as typeof import('electron')
  try {
    await electronSession.fromPartition('persist:claude').clearStorageData()
    await electronSession.fromPartition('persist:claude-login').clearStorageData().catch(() => {})
  } catch { /* ignore */ }
})

// IPC: Auto-login Claude via browser
ipcMain.handle('subscription:autoLoginClaude', async (_event, args: unknown) => {
  const { email, password } = (args || {}) as Record<string, unknown>
  if (typeof email !== 'string' || typeof password !== 'string' ||
      email.length === 0 || email.length > 300 || password.length === 0 || password.length > 500) {
    return { success: false, error: 'Invalid credentials format' }
  }
  const { session: electronSession } = require('electron') as typeof import('electron')
  const regionEnv = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}
  const lang = regionEnv.LANG?.split('.')[0]?.replace('_', '-') || 'en-US'

  // Use separate partition for auto-login — shared persist:claude would mutate
  // UA and proxy settings, interfering with any open built-in browser windows
  const loginSession = electronSession.fromPartition('persist:claude-login')

  // In TUN mode, don't set session proxy (traffic goes through TUN)
  const tunInfo = singBoxManager.getInfo()
  if (!tunInfo.tunRunning && proxySettings.enabled && proxySettings.url) {
    await loginSession.setProxy({ proxyRules: proxySettings.url })
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Claude Login',
    icon: join(__dirname, '../../resources/icon-256.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: loginSession,
    }
  })

  // Auto-fill login form when page loads
  const safeEmail = JSON.stringify(email)
  const safePass = JSON.stringify(password)

  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL()

    // Override language/timezone
    if (regionEnv.LANG) {
      const safeLang = JSON.stringify(lang)
      win.webContents.executeJavaScript(`
        Object.defineProperty(navigator, 'language', { get: () => ${safeLang} });
        Object.defineProperty(navigator, 'languages', { get: () => [${safeLang}, 'en'] });
      `).catch(() => {})
    }

    if (url.includes('claude.ai/login') || url.includes('clerk') || url.includes('accounts.anthropic.com')) {
      win.webContents.executeJavaScript(claudeAutoFillScript(email, password)).catch(() => {})
    }
  })

  win.loadURL('https://claude.ai/login')

  // Auto-close browser and notify renderer when login succeeds
  win.webContents.on('did-navigate', (_event, url) => {
    if (url.includes('claude.ai') && !url.includes('login') && !url.includes('accounts')) {
      safeSend('subscription:claudeLoginSuccess')
      // Close the login browser window after a short delay (let cookies settle)
      setTimeout(() => {
        try { if (!win.isDestroyed()) win.close() } catch { /* ignore */ }
      }, 2000)
    }
  })

  return { success: true }
})

// IPC: TUN proxy (sing-box)
ipcMain.handle('tun:getInfo', () => singBoxManager.getInfo())

ipcMain.handle('tun:install', async () => {
  try {
    await singBoxManager.install((step, pct) => {
      safeSend('tun:installProgress', { step, pct })
    })
    return { success: true }
  } catch (err) {
    const error = (err as Error).message
    errorReporter.reportBizError('tun_install', error, {
      username: subscriptionManager.getUsername() || undefined,
      deviceId: getDeviceId(),
    })
    return { success: false, error }
  }
})

ipcMain.handle('tun:startTun', async (_event, proxyUrl: string) => {
  proxyUrl = typeof proxyUrl === 'string' ? proxyUrl.trim() : proxyUrl
  log.info(`[startTun] url: ${proxyUrl?.replace(/:\/\/.*@/, '://***@').replace(/:\/\/([^/]+)/, '://***.***:***')}`)
  if (typeof proxyUrl !== 'string' || proxyUrl.length > 500 || proxyUrl.length < 5) {
    log.error(`[startTun] invalid proxy URL (len=${proxyUrl?.length})`)
    return { success: false, error: 'Invalid proxy URL' }
  }
  try {
    await singBoxManager.startTun(proxyUrl)
    log.info(`[startTun] success`)
    statsCollector.logEvent('tun:start')
    return { success: true }
  } catch (err) {
    log.error(`[startTun] error:`, err)
    const error = (err as Error).message
    errorReporter.reportBizError('tun_start', error, {
      username: subscriptionManager.getUsername() || undefined,
      deviceId: getDeviceId(),
      proxyUrl: proxyUrl?.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@'),
      singboxLog: singBoxManager.readRecentLog(),
    })
    return { success: false, error }
  }
})

ipcMain.handle('tun:stop', async () => {
  await singBoxManager.stop()
  statsCollector.logEvent('tun:stop')
  // Close all browser windows when TUN stops
  closeAllBrowserWindows()
  return { success: true }
})

ipcMain.handle('tun:testConnectivity', async (_event, exitIp?: string) => {
  const result = await singBoxManager.testConnectivity(exitIp)
  if (!result.success) {
    errorReporter.reportBizError('tun_connectivity', result.error || 'Connectivity test failed', {
      username: subscriptionManager.getUsername() || undefined,
      deviceId: getDeviceId(),
      expectedIp: exitIp,
      actualIp: result.actualIp,
      singboxLog: singBoxManager.readRecentLog(),
    })
  }
  return result
})

// IPC: Proxy settings (stored in main process, applied to PTY env on create)
interface ProxySettings {
  enabled: boolean
  url: string
  region: string
}

let proxySettings: ProxySettings = { enabled: false, url: '', region: 'us' }

// Claude credentials — in-memory only, never persisted to disk
let claudeCredentials: { email: string; password: string } | null = null

/** Region → environment variable overrides (timezone, locale, LC_CTYPE) */
const REGION_ENV: Record<string, Record<string, string>> = {
  us:   { TZ: 'America/New_York',    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' },
  usw:  { TZ: 'America/Los_Angeles', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' },
  gb:   { TZ: 'Europe/London',       LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', LC_CTYPE: 'en_GB.UTF-8' },
  de:   { TZ: 'Europe/Berlin',       LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LC_CTYPE: 'de_DE.UTF-8' },
  jp:   { TZ: 'Asia/Tokyo',          LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8', LC_CTYPE: 'ja_JP.UTF-8' },
  kr:   { TZ: 'Asia/Seoul',          LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', LC_CTYPE: 'ko_KR.UTF-8' },
  sg:   { TZ: 'Asia/Singapore',      LANG: 'en_SG.UTF-8', LC_ALL: 'en_SG.UTF-8', LC_CTYPE: 'en_SG.UTF-8' },
  hk:   { TZ: 'Asia/Hong_Kong',      LANG: 'en_HK.UTF-8', LC_ALL: 'en_HK.UTF-8', LC_CTYPE: 'en_HK.UTF-8' },
  tw:   { TZ: 'Asia/Taipei',         LANG: 'zh_TW.UTF-8', LC_ALL: 'zh_TW.UTF-8', LC_CTYPE: 'zh_TW.UTF-8' },
  au:   { TZ: 'Australia/Sydney',    LANG: 'en_AU.UTF-8', LC_ALL: 'en_AU.UTF-8', LC_CTYPE: 'en_AU.UTF-8' },
  auto: {}, // no override — use real system locale
}

/** Validate and sanitize proxy settings from renderer */
function validateProxySettings(input: unknown): ProxySettings {
  const s = input as Record<string, unknown>
  return {
    enabled: typeof s?.enabled === 'boolean' ? s.enabled : false,
    url: typeof s?.url === 'string' ? s.url.slice(0, 500) : '',
    region: typeof s?.region === 'string' && s.region in REGION_ENV ? s.region : 'us',
  }
}

/** Build env vars from proxy URL — supports http, https, socks4, socks5 (with auth) */
function buildProxyEnv(url: string): Record<string, string> {
  if (!url) return {}
  const env: Record<string, string> = {}
  const lower = url.toLowerCase()
  if (lower.startsWith('socks5://') || lower.startsWith('socks4://') || lower.startsWith('socks://')) {
    // SOCKS proxies: use ALL_PROXY (recognized by curl, git, many CLI tools)
    env.ALL_PROXY = url
    env.all_proxy = url
    // Also set HTTP(S)_PROXY for tools that don't support ALL_PROXY
    env.HTTP_PROXY = url
    env.HTTPS_PROXY = url
    env.http_proxy = url
    env.https_proxy = url
  } else {
    // HTTP/HTTPS proxies
    env.HTTP_PROXY = url
    env.HTTPS_PROXY = url
    env.http_proxy = url
    env.https_proxy = url
  }
  return env
}

ipcMain.handle('proxy:getSettings', () => proxySettings)

ipcMain.handle('proxy:fetchSubscription', async (_event, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { success: false, error: 'Only http/https URLs are supported', nodes: [] }
  }
  try {
    const nodes = await fetchSubscription(url)
    return { success: true, nodes }
  } catch (err) {
    return { success: false, error: (err as Error).message, nodes: [] }
  }
})

// Resolve proxy URL: if it's a subscription URL (https://), fetch and return first usable node
const ALLOWED_PROXY_PROTOCOLS = ['socks5:', 'socks:', 'http:', 'https:']
ipcMain.handle('proxy:resolveUrl', async (_event, url: string) => {
  log.info(`[resolveUrl] input: ${url?.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@').substring(0, 80)}...`)
  if (typeof url !== 'string' || !url) return { resolved: url, isSubscription: false }

  // Distinguish proxy URL from subscription URL:
  // - Proxy URL: socks5://..., http://user:pass@host:port (has userinfo or non-http protocol)
  // - Subscription URL: https://panel.xxx/api/sub/... (no userinfo, https)
  const isDirectProxy = !/^https?:\/\//i.test(url) || (() => {
    try { return !!new URL(url).username } catch { return false }
  })()

  if (isDirectProxy) {
    try {
      const proto = new URL(url).protocol
      if (!ALLOWED_PROXY_PROTOCOLS.includes(proto)) {
        log.warn(`[resolveUrl] unsupported protocol: ${proto}`)
        return { resolved: '', isSubscription: false, error: `Unsupported proxy protocol: ${proto} (only SOCKS5/HTTP supported)` }
      }
    } catch {
      // Not a valid URL — could be host:port, let it pass
    }
    log.info(`[resolveUrl] direct proxy URL, using directly`)
    return { resolved: url, isSubscription: false }
  }

  // Subscription URL — fetch and filter usable nodes only
  try {
    const nodes = await fetchSubscription(url)
    log.info(`[resolveUrl] fetched ${nodes.length} nodes: ${nodes.map(n => `${n.name}(${n.type}, usable=${n.usable})`).join(', ')}`)
    if (!nodes.length) return { resolved: '', isSubscription: true, error: 'No nodes found in subscription' }

    // Only use nodes marked as usable (socks5/http/https)
    const usableNodes = nodes.filter(n => n.usable && n.url)
    if (!usableNodes.length) {
      const types = [...new Set(nodes.map(n => n.type))].join(', ')
      return { resolved: '', isSubscription: true, error: `No SOCKS5/HTTP nodes in subscription (found: ${types})` }
    }

    const node = usableNodes[0]
    const resolved = node.url
    log.info(`[resolveUrl] picked node: ${node.name}, resolved: ${resolved?.substring(0, 80)}`)

    const detected = detectRegion(node.name)
    log.info(`[resolveUrl] detected region: ${detected.region} (${detected.flag}) from "${node.name}"`)
    return { resolved, isSubscription: true, nodeName: node.name, nodeCount: nodes.length, detectedRegion: detected.region }
  } catch (err) {
    log.error(`[resolveUrl] error:`, err)
    return { resolved: '', isSubscription: true, error: (err as Error).message }
  }
})

ipcMain.handle('proxy:updateSettings', (_event, settings: unknown) => {
  proxySettings = validateProxySettings(settings)
  safeSend('proxy:settingsChanged', proxySettings)
})

// IPC: PTY — supports launching claude directly
ipcMain.handle('pty:create', (_event, options: {
  cwd: string
  env?: Record<string, string>
  launchClaude?: boolean
}) => {
  try {
    // Validate cwd exists and is a directory
    if (!isValidDirectory(options.cwd)) {
      return { error: `Directory does not exist: ${options.cwd}` }
    }

    let command: string | undefined
    let args: string[] = []

    if (options.launchClaude && cliManager.isInstalled()) {
      command = cliManager.getBinaryPath()
    }

    // --- Build clean PTY environment from scratch (whitelist approach) ---
    const toolsEnv = toolsManager.getEnvPatch()
    const claudeConfigDir = join(app.getPath('userData'), 'claude-config')
    mkdirSync(claudeConfigDir, { recursive: true })

    // Region overrides (TZ, LANG, LC_*) based on exit IP
    const regionOverrides = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}

    // Proxy env only in non-TUN mode (TUN captures all traffic at network level)
    const tunInfo = singBoxManager.getInfo()
    const proxyEnv = (proxySettings.enabled && !tunInfo.tunRunning) ? buildProxyEnv(proxySettings.url) : {}

    // Browser interceptor env (BROWSER, INKESS_BROWSER_SOCK, ZDOTDIR)
    const interceptorEnv = browserInterceptor.getEnv()
    const binDir = browserInterceptor.getBinDir()
    const existingPath = toolsEnv.PATH || process.env.PATH || ''

    // Encode region vars for zdotdir .zshrc to re-apply after user's .zshrc
    const regionEnvStr = Object.entries({ ...DEFAULT_REGION_ENV, ...regionOverrides })
      .filter(([k]) => ['TZ', 'LANG', 'LC_ALL', 'LC_CTYPE'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join('|')

    // Filter dangerous env vars from renderer-supplied options.env
    const BLOCKED_ENV_KEYS = new Set([
      'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
      'GIT_PROXY_COMMAND', 'GIT_SSH_COMMAND', 'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE', 'ZDOTDIR', 'SHELL', 'HOME',
      'PATH', 'CLAUDE_CONFIG_DIR',
    ])
    const safeEnv: Record<string, string> = {}
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (!BLOCKED_ENV_KEYS.has(k) && typeof v === 'string') safeEnv[k] = v
      }
    }

    // Build from scratch: clean base + region + tools + interceptor + caller
    const ptyEnv = buildCleanEnv(regionOverrides, {
      ...toolsEnv,
      ...proxyEnv,
      ...interceptorEnv,
      ...safeEnv,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      __INKESS_CLAUDE_CONFIG_DIR: claudeConfigDir,
      __INKESS_REGION_ENV: regionEnvStr,
      PATH: `${binDir}${delimiter}${existingPath}`,
    })

    const id = ptyManager.create(options.cwd, ptyEnv, command, args)
    ptyMonitor.watch(id)
    const title = options.cwd.replace(/\\/g, '/').split('/').pop() || 'terminal'
    sessionRecorder.startSession(id, options.cwd, title)
    statsCollector.sessionStart(id, options.cwd)
    statsCollector.logEvent('tab:create', options.cwd)
    ptyManager.onData(id, (data) => {
      safeSend('pty:data', { id, data })
      ptyMonitor.feed(id, data)
      sessionRecorder.recordData(id, data)
    })
    ptyManager.onExit(id, (exitCode) => {
      safeSend('pty:exit', { id, exitCode })
      ptyMonitor.unwatch(id)
      sessionRecorder.closeSession(id)
    })
    analytics.track('tab_create')
    return { id }
  } catch (err) {
    log.error('pty:create failed:', err)
    return { error: (err as Error).message }
  }
})

ipcMain.on('pty:write', (_event, payload) => {
  if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'string') return
  ptyManager.write(payload.id, payload.data)
  // sessionRecorder.recordInput removed: do not record keystrokes for security
})

ipcMain.on('pty:resize', (_event, payload) => {
  if (!payload || typeof payload.id !== 'string') return
  ptyManager.resize(payload.id, payload.cols, payload.rows)
})

ipcMain.on('pty:kill', (_event, { id }: { id: string }) => {
  ptyManager.kill(id)
  statsCollector.sessionClose(id)
  statsCollector.logEvent('tab:close', id)
  analytics.track('tab_close')
})

ipcMain.handle('pty:killAll', () => {
  ptyManager.killAll()
})

// IPC: Shell actions
ipcMain.handle('shell:openExternal', (_event, url: string) => {
  if (!/^https?:\/\//i.test(url)) {
    log.warn(`Blocked openExternal with non-http URL: ${url}`)
    return
  }
  return shell.openExternal(url)
})

ipcMain.handle('shell:openPath', (_event, path: string) => {
  const normalized = normalize(resolve(path))
  const home = os.homedir()
  const homePrefixed = home + sep
  if (!normalized.startsWith(homePrefixed) && normalized !== home) {
    log.warn(`Blocked openPath outside home: ${normalized}`)
    return
  }
  return shell.openPath(normalized)
})

ipcMain.handle('shell:selectDirectory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

// IPC: Stats
ipcMain.handle('stats:getSummary', () => statsCollector.getSummary())
ipcMain.handle('stats:getEvents', () => statsCollector.getEvents())
ipcMain.handle('stats:getSessions', () => statsCollector.getSessions())
ipcMain.handle('stats:getLatency', () => statsCollector.getLatency())
ipcMain.handle('stats:getSystemLog', () => statsCollector.getSystemLog())
ipcMain.handle('stats:getStorageSize', () => statsCollector.getStorageSize())
ipcMain.handle('stats:clear', () => { statsCollector.clearAll(); return { success: true } })

// IPC: Claude credentials (in-memory only)
ipcMain.handle('claude:setCredentials', (_event, args: unknown) => {
  const { email, password } = (args || {}) as Record<string, unknown>
  if (typeof email === 'string' && typeof password === 'string' &&
      email.length > 0 && email.length <= 300 && password.length > 0 && password.length <= 500) {
    claudeCredentials = { email, password }
  }
})
ipcMain.handle('claude:clearCredentials', () => {
  claudeCredentials = null
})

// IPC: Session history
ipcMain.handle('session:list', () => sessionRecorder.listSessions())
ipcMain.handle('session:read', (_event, id: string) => sessionRecorder.readSession(id))
ipcMain.handle('session:delete', (_event, id: string) => sessionRecorder.deleteSession(id))
ipcMain.handle('session:search', (_event, query: string) => sessionRecorder.searchSessions(query))
ipcMain.handle('session:clearAll', () => sessionRecorder.clearAll())

// IPC: Filesystem helpers (for drag & drop, file preview)
ipcMain.handle('fs:isDirectory', (_event, path: string) => {
  return isValidDirectory(path)
})

ipcMain.handle('fs:exists', (_event, path: string) => {
  try { return existsSync(resolve(normalize(path))) } catch { return false }
})

ipcMain.handle('fs:readFile', (_event, filePath: string, maxSize?: number) => {
  try {
    const resolved = resolve(normalize(filePath))
    if (!existsSync(resolved)) return null
    // Resolve symlinks for security boundary check
    const { realpathSync } = require('fs') as typeof import('fs')
    const real = realpathSync(resolved)
    const home = os.homedir()
    const homePrefix = home + sep
    if (!real.startsWith(homePrefix) && real !== home) {
      log.warn(`fs:readFile blocked path outside home: ${real}`)
      return null
    }
    const stat = statSync(real)
    if (stat.isDirectory()) return null
    const limit = maxSize || 1024 * 1024
    if (stat.size > limit) return null
    const { readFileSync } = require('fs') as typeof import('fs')
    return readFileSync(real, 'utf-8')
  } catch {
    return null
  }
})

// IPC: Renderer error reporting
ipcMain.on('log:error', (_event, { message, stack }: { message: string; stack?: string }) => {
  log.error(`[Renderer] ${message}`, stack || '')
  errorReporter.report(message, stack, 'renderer')
})

// IPC: Log upload
ipcMain.handle('logs:uploadFile', () => errorReporter.uploadLogFile())

// IPC: App auto-update
ipcMain.handle('appUpdate:check', () => checkForAppUpdate())
ipcMain.handle('appUpdate:download', () => downloadAppUpdate())
ipcMain.handle('appUpdate:install', () => installAppUpdate())

// IPC: Clipboard
ipcMain.handle('clipboard:writeText', (_event, text: string) => {
  clipboard.writeText(text)
})

ipcMain.handle('clipboard:saveImage', async (_event, buffer: ArrayBuffer) => {
  const MAX_IMAGE_SIZE = 50 * 1024 * 1024 // 50MB
  if (buffer.byteLength > MAX_IMAGE_SIZE) {
    throw new Error('Image too large (max 50MB)')
  }
  const tmpDir = join(app.getPath('userData'), 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const filename = `paste-${ts}.png`
  const filepath = join(tmpDir, filename)
  const { writeFileSync } = require('fs') as typeof import('fs')
  writeFileSync(filepath, Buffer.from(buffer))
  return filepath
})

ipcMain.handle('clipboard:getImageSize', async (_event, filepath: string) => {
  try {
    const expectedDir = join(app.getPath('userData'), 'tmp')
    const resolved = resolve(normalize(filepath))
    if (!resolved.startsWith(expectedDir + sep)) {
      return { size: 0 }
    }
    const { statSync: fsStat } = require('fs') as typeof import('fs')
    return { size: fsStat(resolved).size }
  } catch {
    return { size: 0 }
  }
})

/** Generate auto-fill script for Claude login pages (max 10 retries) */
function claudeAutoFillScript(email: string, password: string): string {
  const safeEmail = JSON.stringify(email)
  const safePass = JSON.stringify(password)
  return `(function() {
    var attempts = 0;
    function tryFill() {
      if (++attempts > 10) return;
      var emailInput = document.querySelector('input[type="email"], input[name="email"], input[name="identifier"]');
      var passInput = document.querySelector('input[type="password"]');
      if (emailInput) {
        emailInput.value = ${safeEmail};
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passInput) {
        passInput.value = ${safePass};
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        passInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (emailInput || passInput) {
        setTimeout(function() {
          var btn = document.querySelector('button[type="submit"]');
          if (btn) btn.click();
        }, 800);
      } else {
        setTimeout(tryFill, 1000);
      }
    }
    setTimeout(tryFill, 500);
  })()`
}

// IPC: Built-in browser (uses proxy + region env + address bar)

function getBrowserConfig() {
  const regionEnv = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}
  const sbInfo = singBoxManager.getInfo()
  return {
    region: proxySettings.region,
    regionEnv,
    proxyUrl: proxySettings.url,
    proxyEnabled: proxySettings.enabled,
    tunRunning: sbInfo.tunRunning,
    claudeCredentials,
    claudeAutoFillScript,
  }
}

async function openBuiltinBrowser(url: string): Promise<{ success?: boolean; error?: string }> {
  return openBrowserWindow(url, getBrowserConfig())
}

ipcMain.handle('browser:closeAll', () => {
  closeAllBrowserWindows()
})

ipcMain.handle('browser:open', async (_event, url: string) => {
  return openBuiltinBrowser(url)
})

// IPC: Window controls (Windows only)
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

// IPC: App version
ipcMain.handle('app:getVersion', () => {
  return app.getVersion()
})

// IPC: Analytics (renderer → main)
ipcMain.on('analytics:track', (_event, { event, props }: { event: string; props?: Record<string, unknown> }) => {
  analytics.track(event, props)
})

// --- Window focus tracking ---
let isWindowFocused = true

// --- Sleep inhibitor ---
let sleepBlockerId: number | null = null
let sleepInhibitorEnabled = true

// --- PTY Monitor: broadcast activity events + notifications + sleep ---
ptyMonitor.on('activity', (event: PtyActivityEvent) => {
  safeSend('pty:activity', event)

  if (event.type === 'ttfb-ready') {
    statsCollector.sessionRecordTtfb(event.id, parseInt(event.payload ?? '0'))
  } else if (event.type === 'token-usage') {
    try {
      const parsed = JSON.parse(event.payload ?? '{}')
      statsCollector.sessionSetTokens(event.id, {
        inputTokens: typeof parsed.input === 'number' ? parsed.input : undefined,
        outputTokens: typeof parsed.output === 'number' ? parsed.output : undefined,
        totalTokens: typeof parsed.total === 'number' ? parsed.total : undefined,
        cost: typeof parsed.cost === 'number' ? `$${parsed.cost}` : undefined,
      })
    } catch { /* ignore malformed payload */ }
  }

  if (event.type === 'task-complete' && !isWindowFocused) {
    safeSend('notification:shouldShow', event)
  }

  if (event.type === 'streaming') {
    if (sleepBlockerId === null && sleepInhibitorEnabled) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      safeSend('power:sleepInhibitChange', true)
    }
  } else if (event.type === 'task-complete' || event.type === 'prompt-idle') {
    if (sleepBlockerId !== null && !ptyMonitor.isAnyStreaming()) {
      powerSaveBlocker.stop(sleepBlockerId)
      sleepBlockerId = null
      safeSend('power:sleepInhibitChange', false)
    }
  }
})

ipcMain.handle('notification:show', (_event, { title, body }: { title: string; body: string }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show()
  }
})

ipcMain.handle('app:isFocused', () => isWindowFocused)

ipcMain.on('power:setSleepInhibitorEnabled', (_event, enabled: boolean) => {
  sleepInhibitorEnabled = enabled
  if (!enabled && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = null
    safeSend('power:sleepInhibitChange', false)
  }
})

// IPC: Git branch
ipcMain.handle('git:getBranch', async (_event, cwd: string) => {
  try {
    if (!isValidDirectory(cwd)) return null
    const toolsEnv = toolsManager.getEnvPatch()
    const env = { ...process.env, ...toolsEnv }
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000, env }).trim()
    return branch || null
  } catch {
    return null
  }
})

// App lifecycle
app.whenReady().then(() => {
  // CSP — apply in both dev and production
  // Dev mode is slightly looser (allows localhost connections for HMR)
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Dev mode needs 'unsafe-inline' + 'unsafe-eval' for Vite HMR/React preamble
    const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'"
    const connectSrc = isDev
      ? "connect-src 'self' ws://localhost:* http://localhost:* https://llm.starapp.net https://inkess-install-file.oss-cn-beijing.aliyuncs.com"
      : "connect-src https://llm.starapp.net https://inkess-install-file.oss-cn-beijing.aliyuncs.com"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
          `${connectSrc}; font-src 'self'; img-src 'self' data:;`
        ]
      }
    })
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
      callback(true)
    } else {
      callback(false)
    }
  })

  // Clean up expired temp files (older than 7 days)
  try {
    const tmpDir = join(app.getPath('userData'), 'tmp')
    if (existsSync(tmpDir)) {
      const { readdirSync, unlinkSync: rmFile, statSync: fstat } = require('fs') as typeof import('fs')
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      for (const f of readdirSync(tmpDir)) {
        const fp = join(tmpDir, f)
        try { if (fstat(fp).mtimeMs < cutoff) rmFile(fp) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Start browser interceptor — redirects PTY `open` / BROWSER calls to built-in browser
  browserInterceptor.start((url) => {
    openBuiltinBrowser(url).catch(err => log.error('[BrowserInterceptor] failed to open URL:', err))
  })

  createWindow()
  setupMenu()

  analytics.track('app_launch', {
    cli_version: cliManager.isInstalled() ? 'installed' : 'not_installed',
  })

  onUpdateStatus((status) => {
    safeSend('appUpdate:status', status)
  })

  // Delay update check until TUN is likely ready (60s instead of 5s)
  // TUN startup takes ~20-30s (sudo prompt + sing-box start + connectivity test)
  setTimeout(() => checkForAppUpdate(), 60000)
  statsCollector.logEvent('app:launch', app.getVersion())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// Ensure tunnel is stopped before app quits (async cleanup)
let _quitting = false
app.on('before-quit', (event) => {
  if (_quitting) return
  event.preventDefault()
  _quitting = true
  singBoxManager.stop()
    .catch(err => log.error('[before-quit] Failed to stop tunnel:', err))
    .finally(() => app.quit())
})

// Handle process signals for cleanup
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    singBoxManager.stop()
      .catch(() => { /* best effort */ })
      .finally(() => process.exit(0))
  })
}

app.on('window-all-closed', async () => {
  // Close all browser windows
  closeAllBrowserWindows()
  browserInterceptor.stop()
  statsCollector.logEvent('app:quit')
  statsCollector.dispose()
  ptyManager.killAll()
  ptyMonitor.dispose()
  analytics.flushSync()
  errorReporter.flushSync()
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = null
  }
  if (process.platform !== 'darwin') {
    // before-quit handler will stop sing-box
    setTimeout(() => app.quit(), 500)
  }
})

function setupMenu(): void {
  const isMac = process.platform === 'darwin'
  const mod = isMac ? 'Cmd' : 'Ctrl'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: `${mod}+T`, click: () => safeSend('app:newTab') },
        { label: 'Close Tab', accelerator: `${mod}+W`, click: () => safeSend('app:closeTab') },
        { type: 'separator' },
        {
          label: 'Open Folder...', accelerator: `${mod}+O`,
          click: async () => {
            if (!mainWindow) return
            const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
            if (!result.canceled && result.filePaths[0]) {
              safeSend('app:openFolder', result.filePaths[0])
            }
          }
        },
        { type: 'separator' },
        ...(isMac ? [] : [{ role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Tabs',
      submenu: Array.from({ length: 9 }, (_, i) => ({
        label: `Tab ${i + 1}`, accelerator: `${mod}+${i + 1}`,
        click: () => safeSend('app:switchTab', i)
      }))
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const }, { role: 'zoom' as const },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
