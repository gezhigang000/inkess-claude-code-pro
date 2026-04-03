import log from './logger'
import { app, BrowserWindow, ipcMain, shell, dialog, Menu, session, nativeImage, clipboard, Notification, powerSaveBlocker } from 'electron'
import { join, resolve, normalize } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'
import { execSync } from 'child_process'
import * as os from 'os'
import { PtyManager } from './pty/pty-manager'
import { PtyOutputMonitor, type PtyActivityEvent } from './pty/pty-output-monitor'
import { CliManager } from './cli/cli-manager'
import { ToolsManager } from './tools/tools-manager'
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, onUpdateStatus } from './updater'
import { Analytics } from './analytics'
import { ErrorReporter } from './error-reporter'
import { SessionRecorder } from './session/session-recorder'
import { SubscriptionManager } from './subscription/subscription-manager'
import { SingBoxManager } from './proxy/sing-box-manager'

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
const singBoxManager = new SingBoxManager()

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
ipcMain.handle('subscription:login', async (_event, { username, password }: { username: string; password: string }) => {
  return subscriptionManager.login(username, password)
})

ipcMain.handle('subscription:checkStatus', async () => {
  return subscriptionManager.checkStatus()
})

ipcMain.handle('subscription:getSession', () => {
  return {
    isLoggedIn: subscriptionManager.isLoggedIn(),
    username: subscriptionManager.getUsername(),
    session: subscriptionManager.getSession(),
  }
})

ipcMain.handle('subscription:logout', () => {
  subscriptionManager.logout()
})

// IPC: Auto-login Claude via browser
ipcMain.handle('subscription:autoLoginClaude', async (_event, { email, password }: { email: string; password: string }) => {
  const { session: electronSession } = require('electron') as typeof import('electron')
  const regionEnv = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}
  const lang = regionEnv.LANG?.split('.')[0]?.replace('_', '-') || 'en-US'

  const partition = `claude-login-${Date.now()}`
  const loginSession = electronSession.fromPartition(partition, { cache: false })

  if (proxySettings.enabled && proxySettings.url) {
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

  browserWindows.push(win)

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
      win.webContents.executeJavaScript(`
        (function() {
          function tryFill() {
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
            // Auto-click submit after short delay
            if (emailInput || passInput) {
              setTimeout(function() {
                var btn = document.querySelector('button[type="submit"]');
                if (btn) btn.click();
              }, 800);
            } else {
              // Retry — page may still be loading
              setTimeout(tryFill, 1000);
            }
          }
          setTimeout(tryFill, 500);
        })()
      `).catch(() => {})
    }
  })

  win.loadURL('https://claude.ai/login')

  win.on('closed', () => {
    browserWindows = browserWindows.filter(w => w !== win)
  })

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

// IPC: sing-box TUN/proxy
ipcMain.handle('singbox:getInfo', () => singBoxManager.getInfo())

ipcMain.handle('singbox:install', async () => {
  try {
    await singBoxManager.install((step, pct) => {
      safeSend('singbox:installProgress', { step, pct })
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
})

ipcMain.handle('singbox:startTun', async (_event, proxyUrl: string) => {
  try {
    await singBoxManager.startTun(proxyUrl)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
})

ipcMain.handle('singbox:startLocalProxy', async (_event, proxyUrl: string, port?: number) => {
  try {
    const localPort = await singBoxManager.startLocalProxy(proxyUrl, port)
    return { success: true, port: localPort }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
})

ipcMain.handle('singbox:stop', () => {
  singBoxManager.stop()
  return { success: true }
})

// IPC: Proxy settings (stored in main process, applied to PTY env on create)
interface ProxySettings {
  enabled: boolean
  url: string
  region: string
}

let proxySettings: ProxySettings = { enabled: false, url: '', region: 'us' }

/** Region → environment variable overrides (timezone, locale) */
const REGION_ENV: Record<string, Record<string, string>> = {
  us:   { TZ: 'America/New_York',    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  usw:  { TZ: 'America/Los_Angeles', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  gb:   { TZ: 'Europe/London',       LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8' },
  de:   { TZ: 'Europe/Berlin',       LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' },
  jp:   { TZ: 'Asia/Tokyo',          LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8' },
  kr:   { TZ: 'Asia/Seoul',          LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8' },
  sg:   { TZ: 'Asia/Singapore',      LANG: 'en_SG.UTF-8', LC_ALL: 'en_SG.UTF-8' },
  hk:   { TZ: 'Asia/Hong_Kong',      LANG: 'en_HK.UTF-8', LC_ALL: 'en_HK.UTF-8' },
  tw:   { TZ: 'Asia/Taipei',         LANG: 'zh_TW.UTF-8', LC_ALL: 'zh_TW.UTF-8' },
  au:   { TZ: 'Australia/Sydney',    LANG: 'en_AU.UTF-8', LC_ALL: 'en_AU.UTF-8' },
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
    const { fetchSubscription } = require('./proxy/subscription') as typeof import('./proxy/subscription')
    const nodes = await fetchSubscription(url)
    return { success: true, nodes }
  } catch (err) {
    return { success: false, error: (err as Error).message, nodes: [] }
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

    // Merge tools PATH into env so PTY can find bundled python/git
    // Isolate Claude Code config to avoid reading/writing user's ~/.claude/settings.json
    const toolsEnv = toolsManager.getEnvPatch()
    const claudeConfigDir = join(app.getPath('userData'), 'claude-config')
    mkdirSync(claudeConfigDir, { recursive: true })

    // Inject proxy env vars if proxy is enabled
    const proxyEnv = proxySettings.enabled ? buildProxyEnv(proxySettings.url) : {}

    // Build env config with region-based overrides
    const { DEFAULT_ENV_OVERRIDES, DEFAULT_ENV_HIDDEN } = require('./pty/pty-manager') as typeof import('./pty/pty-manager')
    const regionOverrides = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}
    const envConfig = {
      overrides: { ...DEFAULT_ENV_OVERRIDES, ...regionOverrides },
      hidden: DEFAULT_ENV_HIDDEN,
    }

    const mergedEnv = { ...toolsEnv, ...proxyEnv, ...options.env, CLAUDE_CONFIG_DIR: claudeConfigDir }

    const id = ptyManager.create(options.cwd, mergedEnv, command, args, envConfig)
    ptyMonitor.watch(id)
    const title = options.cwd.replace(/\\/g, '/').split('/').pop() || 'terminal'
    sessionRecorder.startSession(id, options.cwd, title)
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

ipcMain.on('pty:write', (_event, { id, data }: { id: string; data: string }) => {
  ptyManager.write(id, data)
  sessionRecorder.recordInput(id, data)
})

ipcMain.on('pty:resize', (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  ptyManager.resize(id, cols, rows)
})

ipcMain.on('pty:kill', (_event, { id }: { id: string }) => {
  ptyManager.kill(id)
  analytics.track('tab_close')
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
  if (normalized !== path && path.includes('..')) {
    log.warn(`Blocked openPath with path traversal: ${path}`)
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
    // Security: only allow reading files under user's home directory
    const home = os.homedir()
    if (!resolved.startsWith(home + require('path').sep) && !resolved.startsWith(home + '/')) {
      log.warn(`fs:readFile blocked path outside home: ${resolved}`)
      return null
    }
    if (!existsSync(resolved)) return null
    const stat = statSync(resolved)
    if (stat.isDirectory()) return null
    const limit = maxSize || 1024 * 1024
    if (stat.size > limit) return null
    const { readFileSync } = require('fs') as typeof import('fs')
    return readFileSync(resolved, 'utf-8')
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
    const { statSync } = require('fs') as typeof import('fs')
    const stat = statSync(filepath)
    return { size: stat.size }
  } catch {
    return { size: 0 }
  }
})

// IPC: Built-in browser (uses proxy + region env)
let browserWindows: BrowserWindow[] = []

ipcMain.handle('browser:open', async (_event, url: string) => {
  // Validate URL
  if (!/^https?:\/\//i.test(url)) {
    log.warn(`browser:open blocked non-http URL: ${url}`)
    return { error: 'Only http/https URLs are supported' }
  }

  const regionEnv = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}
  const lang = regionEnv.LANG?.split('.')[0]?.replace('_', '-') || 'en-US'

  // Each browser window gets an isolated session to avoid proxy leaking to main app
  const { session: electronSession } = require('electron') as typeof import('electron')
  const partition = `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const browserSession = electronSession.fromPartition(partition, { cache: false })

  // Apply proxy to this isolated session
  if (proxySettings.enabled && proxySettings.url) {
    await browserSession.setProxy({
      proxyRules: proxySettings.url,
    })
    const redacted = proxySettings.url.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@')
    log.info(`browser:open proxy set to: ${redacted}`)
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Browser',
    icon: join(__dirname, '../../resources/icon-256.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: browserSession,
    }
  })

  // Set language header to match region
  win.webContents.session.setUserAgent(
    win.webContents.getUserAgent(),
    lang
  )

  // Override navigator.language via JavaScript injection
  win.webContents.on('did-finish-load', () => {
    if (regionEnv.LANG) {
      const safeLang = JSON.stringify(lang)
      win.webContents.executeJavaScript(`
        Object.defineProperty(navigator, 'language', { get: () => ${safeLang} });
        Object.defineProperty(navigator, 'languages', { get: () => [${safeLang}, 'en'] });
      `).catch(() => {})
    }
    // Set timezone via Intl override
    if (regionEnv.TZ) {
      const safeTz = JSON.stringify(regionEnv.TZ)
      win.webContents.executeJavaScript(`
        (function() {
          var __tz = ${safeTz};
          var __origDTF = Intl.DateTimeFormat;
          var __newDTF = function(locale, opts) {
            return new __origDTF(locale, Object.assign({}, opts, { timeZone: (opts && opts.timeZone) || __tz }));
          };
          __newDTF.prototype = __origDTF.prototype;
          __newDTF.supportedLocalesOf = __origDTF.supportedLocalesOf.bind(__origDTF);
          Object.defineProperty(__newDTF, Symbol.hasInstance, { value: function(i) { return i instanceof __origDTF; } });
          Intl.DateTimeFormat = __newDTF;
        })();
      `).catch(() => {})
    }
  })

  win.loadURL(url)
  browserWindows.push(win)

  win.on('closed', () => {
    browserWindows = browserWindows.filter(w => w !== win)
  })

  return { success: true }
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

  createWindow()
  setupMenu()

  analytics.track('app_launch', {
    cli_version: cliManager.isInstalled() ? 'installed' : 'not_installed',
  })

  onUpdateStatus((status) => {
    safeSend('appUpdate:status', status)
  })

  setTimeout(() => checkForAppUpdate(), 5000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // Stop sing-box TUN/proxy
  singBoxManager.stop()
  // Close all browser windows
  browserWindows.forEach(w => { try { w.close() } catch { /* ignore */ } })
  browserWindows = []
  ptyManager.killAll()
  ptyMonitor.dispose()
  analytics.flushSync()
  errorReporter.flushSync()
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = null
  }
  if (process.platform !== 'darwin') {
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
