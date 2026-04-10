import { session as electronSession, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import log from '../logger'

const API_BASE = 'https://llm.starapp.net'
const SYNC_INTERVAL = 10 * 60 * 1000 // 10 minutes
const UPLOAD_TIMEOUT = 15000
const LOCALSTORAGE_TIMEOUT = 10000
const CLAUDE_ORIGIN = 'https://claude.ai'

interface SyncData {
  cookies: Electron.Cookie[]
  localStorage: Record<string, string>
  timestamp: string
}

export class BrowserSync {
  private timer: NodeJS.Timeout | null = null
  private username: string | null = null
  private token: string | null = null
  private lastCookiesHash: string | null = null
  private pendingLocalStorage: Record<string, string> | null = null

  /**
   * Phase 1: Download remote data, import cookies immediately.
   * Stores localStorage in memory for Phase 2 (after TUN ready).
   * Called before TUN starts — API is on inkess server (China), no TUN needed.
   */
  async downloadAndImportCookies(username: string, token: string): Promise<void> {
    this.username = username
    this.token = token
    this.pendingLocalStorage = null

    try {
      const res = await fetch(`${API_BASE}/api/subscription/browser-data`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      })

      if (res.status === 204) {
        log.info('[BrowserSync] no remote data (first-time user)')
        return
      }
      if (!res.ok) {
        log.warn(`[BrowserSync] download failed: HTTP ${res.status}`)
        return
      }

      const data: SyncData = await res.json()
      log.info(
        `[BrowserSync] downloaded ${data.cookies?.length ?? 0} cookies, localStorage keys: ${Object.keys(data.localStorage || {}).length}`,
      )

      // Import cookies immediately (pure Electron API, no network needed)
      if (data.cookies?.length) {
        await this.importCookies(data.cookies)
      }

      // Store localStorage for Phase 2
      if (data.localStorage && Object.keys(data.localStorage).length > 0) {
        this.pendingLocalStorage = data.localStorage
      }
    } catch (err) {
      log.warn('[BrowserSync] download error:', err)
    }
  }

  /**
   * Phase 2: Import pending localStorage into a visible browser window.
   * Called after TUN is ready. The browser window is opened by the caller
   * (App.tsx opens claude.ai) — we inject localStorage on dom-ready.
   *
   * Returns the JS code to execute on dom-ready, or null if nothing to import.
   */
  getLocalStorageImportScript(): string | null {
    if (!this.pendingLocalStorage || Object.keys(this.pendingLocalStorage).length === 0) {
      return null
    }
    const data = this.pendingLocalStorage
    this.pendingLocalStorage = null
    const escaped = JSON.stringify(data)
    return `(function(){try{var d=${escaped};Object.keys(d).forEach(function(k){localStorage.setItem(k,d[k])});}catch(e){}})()`
  }

  /** Start periodic upload timer */
  startPeriodicUpload(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.upload().catch((err) => log.warn('[BrowserSync] periodic upload error:', err))
    }, SYNC_INTERVAL)
    log.info('[BrowserSync] periodic upload started (every 10 min)')
  }

  /** Stop sync (on logout or quit) */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.username = null
    this.token = null
    this.lastCookiesHash = null
    this.pendingLocalStorage = null
  }

  /** Export local session and upload to server. Skip if cookies unchanged. */
  async upload(): Promise<void> {
    if (!this.username || !this.token) return

    try {
      const cookies = await this.exportCookies()
      const hash = this.hashCookies(cookies)

      // Skip if cookies unchanged since last upload
      if (hash === this.lastCookiesHash) {
        log.info('[BrowserSync] cookies unchanged, skipping upload')
        return
      }

      // Export localStorage (heavyweight — only when cookies changed)
      let localStorage: Record<string, string> = {}
      try {
        localStorage = await this.exportLocalStorage()
      } catch (err) {
        log.warn('[BrowserSync] localStorage export failed, uploading cookies only:', err)
      }

      const body: SyncData = {
        cookies,
        localStorage,
        timestamp: new Date().toISOString(),
      }

      const res = await fetch(`${API_BASE}/api/subscription/browser-data`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      })

      if (res.ok) {
        this.lastCookiesHash = hash
        log.info(
          `[BrowserSync] uploaded ${cookies.length} cookies, ${Object.keys(localStorage).length} localStorage keys`,
        )
      } else {
        log.warn(`[BrowserSync] upload failed: HTTP ${res.status}`)
      }
    } catch (err) {
      log.warn('[BrowserSync] upload error:', err)
    }
  }

  private getSession(): Electron.Session {
    return electronSession.fromPartition(`persist:claude-${this.username}`)
  }

  private async exportCookies(): Promise<Electron.Cookie[]> {
    return this.getSession().cookies.get({})
  }

  private async importCookies(cookies: Electron.Cookie[]): Promise<void> {
    const ses = this.getSession()
    let imported = 0
    for (const cookie of cookies) {
      try {
        const url = `http${cookie.secure ? 's' : ''}://${cookie.domain?.replace(/^\./, '')}${cookie.path || '/'}`
        await ses.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate,
          sameSite: cookie.sameSite,
        })
        imported++
      } catch {
        // Skip individual cookie errors (e.g. expired, invalid domain)
      }
    }
    log.info(`[BrowserSync] imported ${imported}/${cookies.length} cookies`)
  }

  private async exportLocalStorage(): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const ses = this.getSession()
      const win = new BrowserWindow({
        show: false,
        width: 100,
        height: 100,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })

      const timeout = setTimeout(() => {
        win.destroy()
        reject(new Error('localStorage export timeout'))
      }, LOCALSTORAGE_TIMEOUT)

      const done = (data: Record<string, string>) => {
        clearTimeout(timeout)
        win.destroy()
        resolve(data)
      }

      win.webContents.on('dom-ready', () => {
        win.webContents
          .executeJavaScript('JSON.stringify(localStorage)')
          .then((json) => {
            try {
              done(JSON.parse(json))
            } catch {
              done({})
            }
          })
          .catch(() => done({}))
      })

      win.webContents.on('did-fail-load', () => {
        win.webContents
          .executeJavaScript('JSON.stringify(localStorage)')
          .then((json) => {
            try {
              done(JSON.parse(json))
            } catch {
              done({})
            }
          })
          .catch(() => done({}))
      })

      win.loadURL(CLAUDE_ORIGIN).catch(() => {})
    })
  }

  private hashCookies(cookies: Electron.Cookie[]): string {
    const sorted = cookies
      .map((c) => `${c.domain}|${c.name}|${c.value}`)
      .sort()
      .join('\n')
    return createHash('sha256').update(sorted).digest('hex').slice(0, 16)
  }
}
