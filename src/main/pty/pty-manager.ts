import * as pty from 'node-pty'
import { randomUUID } from 'crypto'
import * as os from 'os'
import log from '../logger'

/**
 * Environment isolation strategy: BUILD FROM SCRATCH (whitelist approach).
 *
 * Instead of inheriting process.env and trying to strip dangerous vars (blacklist),
 * we start with an empty env and only add what's needed. This eliminates the
 * "what did I forget to strip" problem entirely.
 *
 * Categories:
 * 1. Shell essentials — HOME, SHELL, TMPDIR, PATH, TERM
 * 2. Region mask — TZ, LANG, LC_*, USER, LOGNAME (always overridden)
 * 3. Dev tools passthrough — EDITOR, JAVA_HOME, GOPATH, NVM_DIR, etc.
 * 4. Caller injections — CLAUDE_CONFIG_DIR, BROWSER, ZDOTDIR, etc.
 */

/** Region overrides — always applied regardless of user's local settings */
export const DEFAULT_REGION_ENV: Record<string, string> = {
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  USER: 'user',
  LOGNAME: 'user',
}

/** Vars safe to pass through from process.env (dev tools, not identity) */
const PASSTHROUGH_VARS = [
  // Editor / pager
  'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'LESSOPEN', 'LESSCLOSE',
  // Java
  'JAVA_HOME', 'JAVA_OPTS', 'MAVEN_HOME', 'GRADLE_HOME', 'GRADLE_USER_HOME',
  // Go
  'GOPATH', 'GOROOT', 'GOBIN', 'GOPROXY', 'GONOSUMCHECK', 'GOPRIVATE',
  // Rust
  'CARGO_HOME', 'RUSTUP_HOME',
  // Python
  'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV', 'CONDA_PREFIX', 'PYENV_ROOT', 'PIPENV_VENV_IN_PROJECT',
  // Ruby
  'GEM_HOME', 'GEM_PATH', 'RUBY_VERSION', 'RBENV_ROOT',
  // Node
  'NVM_DIR', 'VOLTA_HOME', 'FNM_DIR', 'COREPACK_HOME',
  // Docker / container
  'DOCKER_HOST', 'DOCKER_CONFIG', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME',
  // Build tools
  'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'PKG_CONFIG_PATH',
  'CMAKE_PREFIX_PATH', 'MAKEFLAGS',
  // Homebrew (macOS)
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
  // Git (identity-safe vars only — not GIT_PROXY_COMMAND)
  'GIT_EDITOR', 'GIT_PAGER',
  // Misc dev
  'KUBECONFIG', 'AWS_PROFILE', 'AWS_DEFAULT_REGION',
]

/** Var prefixes safe to pass through (wildcard match) */
const PASSTHROUGH_PREFIXES = [
  'DYLD_',    // macOS dynamic linker (needed for native modules)
  'DENO_',    // Deno
  'BUN_',     // Bun
]

/**
 * Build a clean PTY environment from scratch.
 * @param regionEnv — region-specific overrides (TZ, LANG, etc.)
 * @param extraEnv — caller-injected vars (CLAUDE_CONFIG_DIR, BROWSER, etc.)
 */
export function buildCleanEnv(
  regionEnv: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}

  // 1. Shell essentials (always needed)
  env.HOME = process.env.HOME || os.homedir()
  if (process.platform !== 'win32') {
    env.SHELL = process.env.SHELL || '/bin/zsh'
  }
  if (process.platform === 'win32') {
    if (process.env.TEMP) env.TEMP = process.env.TEMP
    if (process.env.TMP) env.TMP = process.env.TMP
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE
    if (process.env.USERNAME) env.USERNAME = process.env.USERNAME
  } else {
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  // 2. Region mask — overrides identity-revealing locale/timezone
  Object.assign(env, DEFAULT_REGION_ENV, regionEnv)

  // 3. Dev tools passthrough — only safe, non-identity vars
  for (const key of PASSTHROUGH_VARS) {
    const val = process.env[key]
    if (val !== undefined) env[key] = val
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (PASSTHROUGH_PREFIXES.some(p => key.startsWith(p))) {
      env[key] = value
    }
  }

  // 4. Caller injections (CLAUDE_CONFIG_DIR, BROWSER, PATH, etc.)
  // Applied last so they take priority over everything
  Object.assign(env, extraEnv)

  return env
}

interface PtySession {
  process: pty.IPty
  onDataCallbacks: ((data: string) => void)[]
  onExitCallbacks: ((exitCode: number) => void)[]
}

export class PtyManager {
  private sessions = new Map<string, PtySession>()

  /**
   * Create a new PTY session.
   * @param cwd — working directory
   * @param env — the COMPLETE env to use (built by caller via buildCleanEnv)
   * @param command — shell binary (default: user's SHELL)
   * @param args — shell args
   */
  create(cwd: string, env?: Record<string, string>, command?: string, args?: string[]): string {
    const id = randomUUID()
    const isWin = os.platform() === 'win32'
    const shell = command || (isWin ? 'powershell.exe' : process.env.SHELL || '/bin/zsh')

    try {
      const ptyProcess = pty.spawn(shell, args || [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: (env || {}) as Record<string, string>,
      })

      // On Windows, switch console codepage to UTF-8 (65001) to prevent GBK mojibake
      if (isWin && !command) {
        ptyProcess.write('chcp 65001 >nul 2>&1\r')
      }

      const session: PtySession = {
        process: ptyProcess,
        onDataCallbacks: [],
        onExitCallbacks: []
      }

      ptyProcess.onData((data) => {
        session.onDataCallbacks.forEach((cb) => cb(data))
      })

      ptyProcess.onExit(({ exitCode }) => {
        session.onExitCallbacks.forEach((cb) => cb(exitCode))
        session.onDataCallbacks = []
        session.onExitCallbacks = []
        this.sessions.delete(id)
      })

      this.sessions.set(id, session)
      return id
    } catch (err) {
      log.error(`PTY spawn failed for shell="${shell}" cwd="${cwd}":`, err)
      throw new Error(`Failed to create terminal: ${(err as Error).message}`)
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) {
      log.warn(`PTY write to dead session: ${id}`)
      return
    }
    session.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 1 || rows < 1 || !Number.isFinite(cols) || !Number.isFinite(rows)) return
    this.sessions.get(id)?.process.resize(Math.floor(cols), Math.floor(rows))
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      const exitCbs = session.onExitCallbacks.slice()
      session.onDataCallbacks = []
      session.onExitCallbacks = []
      this.sessions.delete(id)
      session.process.kill()
      exitCbs.forEach(cb => cb(-1))
    }
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id)
    }
  }

  onData(id: string, callback: (data: string) => void): void {
    this.sessions.get(id)?.onDataCallbacks.push(callback)
  }

  onExit(id: string, callback: (exitCode: number) => void): void {
    this.sessions.get(id)?.onExitCallbacks.push(callback)
  }
}
