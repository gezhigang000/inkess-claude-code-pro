import * as pty from 'node-pty'
import { randomUUID } from 'crypto'
import * as os from 'os'
import log from '../logger'

/** Default env sanitization rules — user can override via settings */
export const DEFAULT_ENV_OVERRIDES: Record<string, string> = {
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
}

export const DEFAULT_ENV_HIDDEN = [
  'USER', 'LOGNAME', 'HOSTNAME', 'DISPLAY',
  'SSH_*', 'GPG_*', 'APPLE_*', '__CF_*',
  'SECURITYSESSION*', 'XPC_*',
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',
  'ITERM_*', 'VSCODE_*', 'GIT_ASKPASS',
  'ELECTRON_RUN_AS_NODE', 'CHROME_DESKTOP',
  'COMMAND_MODE', 'MallocNanoZone',
  'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'COMPUTERNAME',
]

export interface EnvConfig {
  overrides: Record<string, string>  // key=value to set/override
  hidden: string[]                   // patterns to remove (supports * wildcard suffix)
}

function matchesPattern(key: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return key.startsWith(pattern.slice(0, -1))
  }
  return key === pattern
}

function sanitizeEnv(processEnv: NodeJS.ProcessEnv, config: EnvConfig): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue
    if (config.hidden.some(p => matchesPattern(key, p))) continue
    result[key] = value
  }

  // Apply overrides
  Object.assign(result, config.overrides)

  return result
}

interface PtySession {
  process: pty.IPty
  onDataCallbacks: ((data: string) => void)[]
  onExitCallbacks: ((exitCode: number) => void)[]
}

export class PtyManager {
  private sessions = new Map<string, PtySession>()

  create(cwd: string, env?: Record<string, string>, command?: string, args?: string[], envConfig?: EnvConfig): string {
    const id = randomUUID()
    const isWin = os.platform() === 'win32'
    const shell = command || (isWin ? 'powershell.exe' : process.env.SHELL || '/bin/zsh')

    try {
      const config = envConfig || { overrides: DEFAULT_ENV_OVERRIDES, hidden: DEFAULT_ENV_HIDDEN }
      const sanitizedEnv = sanitizeEnv(process.env, config)

      const ptyProcess = pty.spawn(shell, args || [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: {
          ...sanitizedEnv,
          ...env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          ...(isWin ? { PYTHONIOENCODING: 'utf-8' } : {}),
        } as Record<string, string>
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
      session.onDataCallbacks = []
      session.onExitCallbacks = []
      session.process.kill()
      this.sessions.delete(id)
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
