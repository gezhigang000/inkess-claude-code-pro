/**
 * Built-in browser window with address bar and navigation controls.
 *
 * Uses BaseWindow + WebContentsView (Electron 41):
 * - Toolbar view: address bar, back/forward/reload, new tab
 * - Content view: the actual web page with proxy + fingerprint masking
 */
import { BaseWindow, WebContentsView, session as electronSession, ipcMain, app } from 'electron'
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { buildFingerprintMaskScript, FINGERPRINT_PROFILES } from './fingerprint-mask'
import log from '../logger'

const TOOLBAR_HEIGHT = 42

interface BrowserConfig {
  region: string
  regionEnv: Record<string, string>
  proxyUrl: string
  proxyEnabled: boolean
  tunRunning: boolean
  claudeCredentials: { email: string; password: string } | null
  claudeAutoFillScript: (email: string, password: string) => string
}

let allBrowserWindows: BaseWindow[] = []

export function getAllBrowserWindows(): BaseWindow[] {
  return allBrowserWindows
}

export function closeAllBrowserWindows(): void {
  allBrowserWindows.forEach(w => { try { if (!w.isDestroyed()) w.close() } catch { /* ignore */ } })
  allBrowserWindows = []
}

export async function openBrowserWindow(url: string, config: BrowserConfig): Promise<{ success?: boolean; error?: string }> {
  if (!/^https?:\/\//i.test(url)) {
    log.warn(`browser:open blocked non-http URL: ${url}`)
    return { error: 'Only http/https URLs are supported' }
  }

  if (config.proxyEnabled && !config.tunRunning) {
    log.warn('browser:open blocked — TUN not running')
    return { error: 'Network not connected. Please start TUN first.' }
  }

  const lang = config.regionEnv.LANG?.split('.')[0]?.replace('_', '-') || 'en-US'

  // Create main window
  const win = new BaseWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Browser',
    icon: join(__dirname, '../../resources/icon-256.png'),
  })

  // --- Toolbar view ---
  const toolbarView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/browser-toolbar.js'),
    }
  })
  win.contentView.addChildView(toolbarView)

  // --- Content view ---
  const isClaude = /claude\.ai/i.test(url)
  const browserSession = isClaude
    ? electronSession.fromPartition('persist:claude')
    : electronSession.fromPartition(`browser-${Date.now()}-${Math.random().toString(36).slice(2)}`, { cache: false })

  // TUN mode: no session proxy (traffic goes through TUN)
  if (!config.tunRunning && config.proxyEnabled && config.proxyUrl) {
    await browserSession.setProxy({ proxyRules: config.proxyUrl })
    const redacted = config.proxyUrl.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@')
    log.info(`browser:open proxy set to: ${redacted}`)
  } else {
    log.info('browser:open using TUN (no session proxy)')
  }

  const contentView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: browserSession,
    }
  })
  win.contentView.addChildView(contentView)

  // WebRTC leak prevention
  contentView.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // Strip Client Hints headers
  contentView.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('sec-ch-')) delete headers[key]
    }
    callback({ requestHeaders: headers })
  })

  // Fingerprint masking
  const fpProfile = FINGERPRINT_PROFILES[config.region] || FINGERPRINT_PROFILES.default
  const fpScript = buildFingerprintMaskScript(fpProfile)
  contentView.webContents.on('dom-ready', () => {
    contentView.webContents.executeJavaScript(fpScript).catch(() => {})
  })

  // Set language header + mask Electron/app from User-Agent
  const cleanUA = contentView.webContents.getUserAgent()
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*inkess-claude-code-pro\/\S+/g, '')
  contentView.webContents.session.setUserAgent(cleanUA, lang)

  // Region masking: language + timezone injection
  contentView.webContents.on('did-finish-load', () => {
    injectRegionMasking(contentView, config.regionEnv, lang)
    // Claude auto-fill
    if (isClaude && config.claudeCredentials) {
      const pageUrl = contentView.webContents.getURL()
      if (pageUrl.includes('login') || pageUrl.includes('clerk') || pageUrl.includes('accounts.anthropic.com')) {
        contentView.webContents.executeJavaScript(
          config.claudeAutoFillScript(config.claudeCredentials.email, config.claudeCredentials.password)
        ).catch(() => {})
      }
    }
  })

  // Claude auto-fill on navigation
  if (isClaude && config.claudeCredentials) {
    let lastFilledUrl = ''
    contentView.webContents.on('did-navigate', (_navEvent, navUrl) => {
      if (navUrl === lastFilledUrl) return
      if (navUrl.includes('login') || navUrl.includes('clerk') || navUrl.includes('accounts.anthropic.com')) {
        lastFilledUrl = navUrl
        const creds = config.claudeCredentials!
        setTimeout(() => {
          contentView.webContents.executeJavaScript(
            config.claudeAutoFillScript(creds.email, creds.password)
          ).catch(() => {})
        }, 500)
      }
    })
  }

  // --- Layout ---
  const layoutViews = () => {
    const bounds = win.getContentBounds()
    const w = bounds.width
    const h = bounds.height
    toolbarView.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT })
    contentView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT })
  }
  layoutViews()
  win.on('resize', layoutViews)

  // --- Toolbar ↔ Content communication ---
  const winId = win.id

  // Update toolbar when content navigates
  const updateToolbar = () => {
    if (toolbarView.webContents.isDestroyed()) return
    const currentUrl = contentView.webContents.getURL()
    const canGoBack = contentView.webContents.navigationHistory.canGoBack()
    const canGoForward = contentView.webContents.navigationHistory.canGoForward()
    const title = contentView.webContents.getTitle()
    toolbarView.webContents.send('browser-toolbar:update', {
      url: currentUrl,
      canGoBack,
      canGoForward,
      title,
      loading: contentView.webContents.isLoading(),
    })
  }

  contentView.webContents.on('did-navigate', updateToolbar)
  contentView.webContents.on('did-navigate-in-page', updateToolbar)
  contentView.webContents.on('did-start-loading', updateToolbar)
  contentView.webContents.on('did-stop-loading', updateToolbar)
  contentView.webContents.on('page-title-updated', (_e, title) => {
    win.setTitle(title || 'Browser')
  })

  // Handle new window requests (target="_blank" links)
  contentView.webContents.setWindowOpenHandler(({ url: newUrl }) => {
    if (/^https?:\/\//i.test(newUrl)) {
      openBrowserWindow(newUrl, config).catch(() => {})
    }
    return { action: 'deny' }
  })

  // Handle toolbar navigation commands (via IPC tagged with windowId)
  const handleNavigate = (_event: Electron.IpcMainEvent, data: unknown) => {
    if (!isMyWindow(data) || contentView.webContents.isDestroyed()) return
    const url = (data as Record<string, unknown>).url
    if (typeof url !== 'string') return
    const target = url.trim()
    if (!target) return
    // Add protocol if missing, then strictly validate http(s) only
    const finalUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`
    if (!/^https?:\/\//i.test(finalUrl)) return // block javascript:, data:, file:, etc.
    contentView.webContents.loadURL(finalUrl)
  }
  const isMyWindow = (data: unknown): boolean =>
    !!data && typeof data === 'object' && (data as Record<string, unknown>).windowId === winId
  const handleBack = (_event: Electron.IpcMainEvent, data: unknown) => {
    if (!isMyWindow(data) || contentView.webContents.isDestroyed()) return
    contentView.webContents.navigationHistory.goBack()
  }
  const handleForward = (_event: Electron.IpcMainEvent, data: unknown) => {
    if (!isMyWindow(data) || contentView.webContents.isDestroyed()) return
    contentView.webContents.navigationHistory.goForward()
  }
  const handleReload = (_event: Electron.IpcMainEvent, data: unknown) => {
    if (!isMyWindow(data) || contentView.webContents.isDestroyed()) return
    contentView.webContents.reload()
  }
  const handleStop = (_event: Electron.IpcMainEvent, data: unknown) => {
    if (!isMyWindow(data) || contentView.webContents.isDestroyed()) return
    contentView.webContents.stop()
  }
  const handleNewTab = (_event: Electron.IpcMainEvent, data: unknown) => {
    if (!isMyWindow(data)) return
    openBrowserWindow('https://www.google.com', config).catch(() => {})
  }

  ipcMain.on('browser-toolbar:navigate', handleNavigate)
  ipcMain.on('browser-toolbar:back', handleBack)
  ipcMain.on('browser-toolbar:forward', handleForward)
  ipcMain.on('browser-toolbar:reload', handleReload)
  ipcMain.on('browser-toolbar:stop', handleStop)
  ipcMain.on('browser-toolbar:newTab', handleNewTab)

  // Load toolbar HTML from local file (data: URLs block preload/contextBridge)
  const toolbarDir = join(app.getPath('userData'), 'browser')
  mkdirSync(toolbarDir, { recursive: true })
  const toolbarPath = join(toolbarDir, `toolbar-${winId}.html`)
  writeFileSync(toolbarPath, buildToolbarHtml(winId))
  toolbarView.webContents.loadFile(toolbarPath)

  // Load content
  contentView.webContents.loadURL(url)

  allBrowserWindows.push(win)

  // Unified cleanup — covers both normal close and crash/destroy
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    allBrowserWindows = allBrowserWindows.filter(w => w !== win)
    try { require('fs').unlinkSync(toolbarPath) } catch { /* ignore */ }
    ipcMain.removeListener('browser-toolbar:navigate', handleNavigate)
    ipcMain.removeListener('browser-toolbar:back', handleBack)
    ipcMain.removeListener('browser-toolbar:forward', handleForward)
    ipcMain.removeListener('browser-toolbar:reload', handleReload)
    ipcMain.removeListener('browser-toolbar:stop', handleStop)
    ipcMain.removeListener('browser-toolbar:newTab', handleNewTab)
  }
  win.once('closed', cleanup)
  contentView.webContents.once('destroyed', cleanup)
  toolbarView.webContents.once('destroyed', cleanup)

  return { success: true }
}

function injectRegionMasking(view: WebContentsView, regionEnv: Record<string, string>, lang: string): void {
  if (regionEnv.LANG) {
    const safeLang = JSON.stringify(lang)
    view.webContents.executeJavaScript(`
      Object.defineProperty(navigator, 'language', { get: () => ${safeLang} });
      Object.defineProperty(navigator, 'languages', { get: () => [${safeLang}, 'en'] });
    `).catch(() => {})
  }
  if (regionEnv.TZ) {
    const safeTz = JSON.stringify(regionEnv.TZ)
    view.webContents.executeJavaScript(`
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
}

function buildToolbarHtml(windowId: number): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    background: #f0f0f0;
    color: #333;
    user-select: none;
    -webkit-app-region: drag;
    overflow: hidden;
  }
  .toolbar {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 8px;
    gap: 4px;
    border-bottom: 1px solid #d0d0d0;
  }
  .nav-btn {
    -webkit-app-region: no-drag;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #555;
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .nav-btn:hover { background: #e0e0e0; }
  .nav-btn:active { background: #d0d0d0; }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .nav-btn:disabled:hover { background: transparent; }
  .url-bar {
    -webkit-app-region: no-drag;
    flex: 1;
    height: 28px;
    border: 1px solid #c8c8c8;
    border-radius: 8px;
    padding: 0 12px;
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Mono", Menlo, monospace;
    background: #fff;
    outline: none;
    color: #333;
    min-width: 100px;
  }
  .url-bar:focus { border-color: #4a90d9; box-shadow: 0 0 0 2px rgba(74,144,217,0.2); }
  .new-tab-btn {
    font-size: 18px;
    font-weight: 300;
    color: #666;
  }
  .loading .reload-btn::after { content: '\\2715'; }
  .reload-btn::after { content: '\\21BB'; }
</style>
</head>
<body>
<div class="toolbar" id="toolbar">
  <button class="nav-btn back-btn" id="backBtn" title="Back" disabled>&#9664;</button>
  <button class="nav-btn forward-btn" id="forwardBtn" title="Forward" disabled>&#9654;</button>
  <button class="nav-btn reload-btn" id="reloadBtn" title="Reload"></button>
  <input class="url-bar" id="urlBar" type="text" placeholder="Enter URL..." spellcheck="false" autocomplete="off">
  <button class="nav-btn new-tab-btn" id="newTabBtn" title="New Window">+</button>
</div>
<script>
  const WINDOW_ID = ${windowId};
  const urlBar = document.getElementById('urlBar');
  const backBtn = document.getElementById('backBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const newTabBtn = document.getElementById('newTabBtn');
  const toolbar = document.getElementById('toolbar');
  let isLoading = false;

  // Send IPC messages via contextBridge (preload) or postMessage fallback
  function send(channel, data) {
    if (window.browserToolbar) {
      window.browserToolbar.send(channel, { windowId: WINDOW_ID, ...data });
    }
  }

  urlBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const url = urlBar.value.trim();
      if (url) send('browser-toolbar:navigate', { url });
      urlBar.blur();
    }
    if (e.key === 'Escape') {
      urlBar.blur();
    }
  });
  urlBar.addEventListener('focus', () => urlBar.select());

  backBtn.addEventListener('click', () => send('browser-toolbar:back', {}));
  forwardBtn.addEventListener('click', () => send('browser-toolbar:forward', {}));
  reloadBtn.addEventListener('click', () => {
    if (isLoading) send('browser-toolbar:stop', {});
    else send('browser-toolbar:reload', {});
  });
  newTabBtn.addEventListener('click', () => send('browser-toolbar:newTab', {}));

  // Listen for updates from main process
  if (window.browserToolbar) {
    window.browserToolbar.onUpdate((state) => {
      urlBar.value = state.url || '';
      backBtn.disabled = !state.canGoBack;
      forwardBtn.disabled = !state.canGoForward;
      isLoading = state.loading;
      toolbar.classList.toggle('loading', isLoading);
    });
  }
</script>
</body>
</html>`
}
