import * as pty from 'node-pty'
import { randomUUID } from 'crypto'
import * as os from 'os'
import log from '../logger'

// Re-export for backward compat with existing import sites.
// New code should import directly from '../utils/clean-env'.
export { buildCleanEnv, DEFAULT_REGION_ENV } from '../utils/clean-env'

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
    try {
      this.sessions.get(id)?.process.resize(Math.floor(cols), Math.floor(rows))
    } catch { /* PTY already exited — ignore resize */ }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      const exitCbs = session.onExitCallbacks.slice()
      session.onDataCallbacks = []
      session.onExitCallbacks = []
      this.sessions.delete(id)
      try { session.process.kill() } catch { /* already exited */ }
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
