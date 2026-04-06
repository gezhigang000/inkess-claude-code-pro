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
  private zdotdir: string
  private onUrlOpen: ((url: string) => void) | null = null

  constructor() {
    const userData = app.getPath('userData')
    this.socketPath = join(userData, SOCKET_NAME)
    this.binDir = join(userData, 'bin')
    this.zdotdir = join(userData, 'zdotdir')
  }

  /** Start socket server and create wrapper scripts */
  start(onUrlOpen: (url: string) => void): void {
    this.onUrlOpen = onUrlOpen
    this.startSocketServer()
    this.createWrapperScripts()
    if (process.platform === 'darwin') this.createZdotdir()
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
      INKESS_BIN_DIR: this.binDir,
      BROWSER: join(this.binDir, 'browser-open'),
    }
    // macOS: ZDOTDIR wrapper ensures our bin dir stays first in PATH
    // (path_helper in /etc/zprofile reorders PATH, moving custom dirs to end)
    if (process.platform === 'darwin') {
      env.ZDOTDIR = this.zdotdir
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

    const MAX_URL_SIZE = 4096
    this.server = createServer((conn) => {
      let data = ''
      conn.on('data', (chunk) => {
        data += chunk.toString()
        if (data.length > MAX_URL_SIZE) { conn.destroy(); return }
      })
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

  /**
   * Create ZDOTDIR wrapper files for zsh on macOS.
   *
   * Problem: macOS /etc/zprofile calls path_helper which reorders PATH,
   * pushing our bin dir to the end (after /usr/bin). This means our `open`
   * wrapper is never found by child processes like Claude Code CLI.
   *
   * Solution: Use ZDOTDIR to wrap zsh config files. Our .zshrc sources the
   * user's real .zshrc, then re-prepends our bin dir to PATH.
   */
  private createZdotdir(): void {
    mkdirSync(this.zdotdir, { recursive: true })

    // .zshenv — source user's, keep ZDOTDIR pointing here for later files
    writeFileSync(join(this.zdotdir, '.zshenv'),
      `[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"\n`,
      { mode: 0o644 })

    // .zprofile — source user's (path_helper already ran via /etc/zprofile)
    writeFileSync(join(this.zdotdir, '.zprofile'),
      `[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"\n`,
      { mode: 0o644 })

    // .zshrc — source user's, re-isolate env, fix PATH, reset ZDOTDIR
    writeFileSync(join(this.zdotdir, '.zshrc'),
      `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n` +
      '# --- Post-init isolation (user .zshrc may have overridden our env) ---\n' +
      '# 1. Re-strip ANTHROPIC_*/CLAUDE_* that user\'s .zshrc may have re-set\n' +
      'for __k in $(env 2>/dev/null | grep -oE \'^(ANTHROPIC|CLAUDE)_[^=]*\'); do\n' +
      '  unset "$__k" 2>/dev/null\n' +
      'done; unset __k\n' +
      `# 2. Re-inject our isolated CLAUDE_CONFIG_DIR\n` +
      `[ -n "$__INKESS_CLAUDE_CONFIG_DIR" ] && export CLAUDE_CONFIG_DIR="$__INKESS_CLAUDE_CONFIG_DIR"\n` +
      `# 3. Re-apply region env (user's .zshrc may have set TZ/LANG to local values)\n` +
      'if [ -n "$__INKESS_REGION_ENV" ]; then\n' +
      '  IFS=\':\' read -rA __pairs <<< "$__INKESS_REGION_ENV"\n' +
      '  for __p in "${__pairs[@]}"; do\n' +
      '    export "${__p%%=*}=${__p#*=}"\n' +
      '  done; unset __pairs __p\n' +
      'fi\n' +
      `# 4. Re-prepend Inkess bin dir (path_helper moved it to end)\n` +
      `[ -n "$INKESS_BIN_DIR" ] && export PATH="$INKESS_BIN_DIR:$PATH"\n` +
      `hash -r\n` +
      `# 5. Clean up internal vars (keep INKESS_BROWSER_SOCK for open wrapper)\n` +
      'for __k in $(env 2>/dev/null | grep -oE \'^__INKESS_[^=]*\'); do unset "$__k" 2>/dev/null; done; unset __k\n' +
      `unset INKESS_BIN_DIR 2>/dev/null\n` +
      `ZDOTDIR="$HOME"\n`,
      { mode: 0o644 })

    // .zlogin — source user's
    writeFileSync(join(this.zdotdir, '.zlogin'),
      `[ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"\n`,
      { mode: 0o644 })
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
      const logDir = app.getPath('userData')
      const openWrapperScript = `#!/bin/bash
# Inkess open wrapper — intercepts URL opens, passes everything else through
LOG="${logDir}/browser-intercept.log"
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      echo "[$(date '+%H:%M:%S')] intercept: $arg sock=$INKESS_BROWSER_SOCK" >> "$LOG" 2>/dev/null
      if [ -S "$INKESS_BROWSER_SOCK" ]; then
        printf '%s' "$arg" | /usr/bin/nc -U "$INKESS_BROWSER_SOCK" 2>/dev/null
        exit 0
      else
        echo "[$(date '+%H:%M:%S')] WARN: socket not found, fallback to system open" >> "$LOG" 2>/dev/null
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
