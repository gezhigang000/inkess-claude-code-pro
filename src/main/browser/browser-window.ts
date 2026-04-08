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
const sessionsWithHeaderStripping = new Set<string>()

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

  // Reuse existing browser window if available — navigate instead of opening new window
  const existing = allBrowserWindows.find(w => !w.isDestroyed())
  if (existing) {
    try {
      const contentView = existing.contentView?.children?.[1] as WebContentsView | undefined
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.loadURL(url)
        // Update address bar
        const safeUrl = JSON.stringify(url)
        const toolbarView = existing.contentView?.children?.[0] as WebContentsView | undefined
        if (toolbarView && !toolbarView.webContents.isDestroyed()) {
          toolbarView.webContents.executeJavaScript(`document.getElementById('url').value = ${safeUrl}`).catch(() => {})
        }
        existing.focus()
        return { success: true }
      }
    } catch {
      // Fall through to create new window
    }
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

  // --- Toolbar view (pure HTML, all logic in main process via executeJavaScript) ---
  const toolbarView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  // Strip Client Hints headers (once per session to avoid listener accumulation)
  const sessionKey = isClaude ? 'persist:claude' : contentView.webContents.session.storagePath || 'ephemeral'
  if (!sessionsWithHeaderStripping.has(sessionKey)) {
    sessionsWithHeaderStripping.add(sessionKey)
    contentView.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase().startsWith('sec-ch-')) delete headers[key]
      }
      callback({ requestHeaders: headers })
    })
  }

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

  // --- Toolbar ↔ Content communication (all logic in main process) ---

  // Update toolbar DOM directly from main process via executeJavaScript
  const updateToolbar = () => {
    if (toolbarView.webContents.isDestroyed()) return
    const safeUrl = JSON.stringify(contentView.webContents.getURL())
    const canGoBack = contentView.webContents.navigationHistory.canGoBack()
    const canGoForward = contentView.webContents.navigationHistory.canGoForward()
    const loading = contentView.webContents.isLoading()
    toolbarView.webContents.executeJavaScript(`
      document.getElementById('urlBar').value = ${safeUrl};
      document.getElementById('backBtn').disabled = ${!canGoBack};
      document.getElementById('forwardBtn').disabled = ${!canGoForward};
      document.getElementById('toolbar').classList.toggle('loading', ${loading});
    `).catch(() => {})
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

  // Main-process driven toolbar interactions (no IPC from renderer needed)
  // Enter key in toolbar → navigate, handled via before-input-event
  toolbarView.webContents.on('before-input-event', (_event, input) => {
    if (contentView.webContents.isDestroyed()) return
    if (input.key === 'Enter' && input.type === 'keyDown') {
      toolbarView.webContents.executeJavaScript(`document.getElementById('urlBar').value`)
        .then((val: string) => {
          const target = (val || '').trim()
          if (!target) return
          const finalUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`
          if (!/^https?:\/\//i.test(finalUrl)) return
          contentView.webContents.loadURL(finalUrl)
          // Blur urlBar
          toolbarView.webContents.executeJavaScript(`document.getElementById('urlBar').blur()`).catch(() => {})
        })
        .catch(() => {})
    }
  })

  // Button clicks — inject handlers via executeJavaScript after DOM ready
  // (inline <script> doesn't execute reliably in sandboxed WebContentsView loading from userData)
  toolbarView.webContents.on('did-finish-load', () => {
    toolbarView.webContents.executeJavaScript(`
      document.getElementById('backBtn').onclick = function() { document.title = 'CMD:back'; };
      document.getElementById('forwardBtn').onclick = function() { document.title = 'CMD:forward'; };
      document.getElementById('reloadBtn').onclick = function() { document.title = 'CMD:reload'; };
      document.getElementById('newTabBtn').onclick = function() { document.title = 'CMD:newTab'; };
      document.getElementById('urlBar').onfocus = function() { this.select(); };
      true;
    `).catch(e => log.error('browser: toolbar inject failed', e))
  })

  // Detect button clicks via title changes (reliable, no IPC/preload needed)
  toolbarView.webContents.on('page-title-updated', (_event, title) => {
    if (!title.startsWith('CMD:')) return
    if (contentView.webContents.isDestroyed()) return
    log.info('browser: toolbar command:', title)
    if (title === 'CMD:back') contentView.webContents.navigationHistory.goBack()
    else if (title === 'CMD:forward') contentView.webContents.navigationHistory.goForward()
    else if (title === 'CMD:reload') contentView.webContents.reload()
    else if (title === 'CMD:stop') contentView.webContents.stop()
    else if (title === 'CMD:newTab') {
      openBrowserWindow('https://www.google.com', config)
        .then(r => { if (r.error) log.warn('browser: newTab blocked:', r.error) })
        .catch(e => log.error('browser: newTab error', e))
    }
  })

  // Load toolbar HTML
  const toolbarDir = join(app.getPath('userData'), 'browser')
  mkdirSync(toolbarDir, { recursive: true })
  const toolbarPath = join(toolbarDir, `toolbar-${win.id}.html`)
  writeFileSync(toolbarPath, buildToolbarHtml())
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

function buildToolbarHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    background: #f0f0f0;
    color: #333;
    user-select: none;
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
</body>
</html>`
}
