/**
 * Browser Interceptor — intercepts URL opens from PTY processes
 *
 * Problem: Claude Code CLI runs inside PTY and uses the system `open` command
 * to open URLs, which bypasses our built-in browser. We need to redirect those
 * URLs to our built-in browser that has proxy + region masking applied.
 *
 * Solution:
 * 1. Start a Unix domain socket server (macOS) or named pipe (Windows)
 * 2. Create wrapper scripts (`open` for macOS, `BROWSER` for both)
 * 3. Set BROWSER env var and prepend wrapper dir to PATH in PTY env
 * 4. When a URL is received via socket, open it in the built-in browser
 */
import { createServer, Server } from 'net'
import { join } from 'path'
import { app } from 'electron'
import { writeFileSync, mkdirSync, chmodSync, existsSync, unlinkSync } from 'fs'
import log from '../logger'

const SOCKET_NAME = 'browser.sock'

export class BrowserInterceptor {
  private server: Server | null = null
  private socketPath: string
  private binDir: string
  private onUrlOpen: ((url: string) => void) | null = null

  constructor() {
    const userData = app.getPath('userData')
    this.socketPath = join(userData, SOCKET_NAME)
    this.binDir = join(userData, 'bin')
  }

  /** Start socket server and create wrapper scripts */
  start(onUrlOpen: (url: string) => void): void {
    this.onUrlOpen = onUrlOpen
    this.startSocketServer()
    this.createWrapperScripts()
    log.info(`[BrowserInterceptor] started, socket: ${this.socketPath}`)
  }

  /** Stop socket server and clean up */
  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    try { unlinkSync(this.socketPath) } catch { /* ignore */ }
  }

  /** Get env vars to inject into PTY for browser interception */
  getEnv(): Record<string, string> {
    const env: Record<string, string> = {
      INKESS_BROWSER_SOCK: this.socketPath,
      BROWSER: join(this.binDir, 'browser-open'),
    }
    return env
  }

  /** Get bin dir path to prepend to PATH */
  getBinDir(): string {
    return this.binDir
  }

  private startSocketServer(): void {
    // Clean up stale socket
    try { unlinkSync(this.socketPath) } catch { /* ignore */ }

    this.server = createServer((conn) => {
      let data = ''
      conn.on('data', (chunk) => { data += chunk.toString() })
      conn.on('end', () => {
        const url = data.trim()
        if (/^https?:\/\//i.test(url)) {
          log.info(`[BrowserInterceptor] received URL: ${url}`)
          this.onUrlOpen?.(url)
        } else {
          log.warn(`[BrowserInterceptor] ignored non-http URL: ${url}`)
        }
        conn.end()
      })
      conn.on('error', () => { /* ignore connection errors */ })
    })

    this.server.on('error', (err) => {
      log.error('[BrowserInterceptor] socket server error:', err)
    })

    this.server.listen(this.socketPath, () => {
      // Make socket accessible by child processes
      try { chmodSync(this.socketPath, 0o666) } catch { /* ignore */ }
    })
  }

  private createWrapperScripts(): void {
    mkdirSync(this.binDir, { recursive: true })

    // browser-open: used as BROWSER env var value
    // Many tools (Node.js `open` package, `xdg-open`, etc.) check BROWSER first
    const browserOpenScript = `#!/bin/bash
# Inkess browser interceptor — sends URL to built-in browser via Unix socket
URL="$1"
if [ -z "$URL" ]; then exit 0; fi
if [ -S "$INKESS_BROWSER_SOCK" ]; then
  printf '%s' "$URL" | /usr/bin/nc -U "$INKESS_BROWSER_SOCK" 2>/dev/null
  exit 0
fi
# Fallback: system open
/usr/bin/open "$URL" 2>/dev/null
`
    const browserOpenPath = join(this.binDir, 'browser-open')
    writeFileSync(browserOpenPath, browserOpenScript, { mode: 0o755 })

    // open wrapper: intercepts direct `open URL` calls on macOS
    // Only intercepts URL arguments; passes everything else to /usr/bin/open
    if (process.platform === 'darwin') {
      const openWrapperScript = `#!/bin/bash
# Inkess open wrapper — intercepts URL opens, passes everything else through
# Check if any argument looks like a URL
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      if [ -S "$INKESS_BROWSER_SOCK" ]; then
        printf '%s' "$arg" | /usr/bin/nc -U "$INKESS_BROWSER_SOCK" 2>/dev/null
        exit 0
      fi
      ;;
  esac
done
# Not a URL open — pass through to real open
/usr/bin/open "$@"
`
      const openPath = join(this.binDir, 'open')
      writeFileSync(openPath, openWrapperScript, { mode: 0o755 })
    }
  }
}
