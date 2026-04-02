import { EventEmitter } from 'events'

export interface PtyActivityEvent {
  id: string
  type: 'task-complete' | 'prompt-idle' | 'streaming' | 'model-info' | 'mode-change'
  payload?: string
}

/**
 * Monitors PTY output streams to detect Claude Code activity patterns.
 * Emits structured events for UI consumption (notifications, status bar, etc.)
 */
export class PtyOutputMonitor extends EventEmitter {
  private sessions = new Map<string, {
    lastDataTime: number
    idleTimer: ReturnType<typeof setTimeout> | null
    isStreaming: boolean
    buffer: string
  }>()

  private static IDLE_TIMEOUT = 2000 // 2s no output = idle
  private static BUFFER_MAX = 2000   // keep last N chars for pattern matching

  /** Strip ANSI escape sequences for clean pattern matching */
  private static stripAnsi(str: string): string {
    // Limit input length to prevent regex DoS on large/malformed sequences
    if (str.length > 10000) str = str.slice(-10000)
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '')
  }

  /** Start monitoring a PTY session */
  watch(id: string): void {
    this.sessions.set(id, {
      lastDataTime: Date.now(),
      idleTimer: null,
      isStreaming: false,
      buffer: ''
    })
  }

  /** Stop monitoring a PTY session */
  unwatch(id: string): void {
    const session = this.sessions.get(id)
    if (session?.idleTimer) clearTimeout(session.idleTimer)
    this.sessions.delete(id)
  }

  /** Feed PTY output data for analysis */
  feed(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return

    session.lastDataTime = Date.now()
    session.buffer = (session.buffer + data).slice(-PtyOutputMonitor.BUFFER_MAX)

    // Mark as streaming
    if (!session.isStreaming) {
      session.isStreaming = true
      this.emit('activity', { id, type: 'streaming' } as PtyActivityEvent)
    }

    // Check for model info (e.g. "claude-sonnet-4-6" in status output)
    const cleanData = PtyOutputMonitor.stripAnsi(data)
    const modelMatch = cleanData.match(/\b(claude-(?:opus|sonnet|haiku)-[\w.-]+)\b/)
    if (modelMatch) {
      this.emit('activity', { id, type: 'model-info', payload: modelMatch[1] } as PtyActivityEvent)
    }

    // Check for mode change (from /permissions output)
    const modeMatch = cleanData.match(/(?:permissions|mode):\s*(suggest|auto-?edit|full-?auto)/i)
    if (modeMatch) {
      const mode = modeMatch[1].toLowerCase().replace('-', '')
      this.emit('activity', { id, type: 'mode-change', payload: mode } as PtyActivityEvent)
    }

    // Reset idle timer
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (!session.isStreaming) return
      session.isStreaming = false

      // Check if output ended with a prompt (task complete)
      const tail = PtyOutputMonitor.stripAnsi(session.buffer.slice(-200))
      // Claude Code prompt patterns: "╰─" or "❯" at end of output
      if (/[╰❯]\s*$/.test(tail) || /\$\s*$/.test(tail)) {
        this.emit('activity', { id, type: 'task-complete' } as PtyActivityEvent)
      } else {
        this.emit('activity', { id, type: 'prompt-idle' } as PtyActivityEvent)
      }
    }, PtyOutputMonitor.IDLE_TIMEOUT)
  }

  /** Check if any session is currently streaming */
  isAnyStreaming(): boolean {
    for (const session of this.sessions.values()) {
      if (session.isStreaming) return true
    }
    return false
  }

  /** Clean up all sessions */
  dispose(): void {
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      this.unwatch(id)
    }
    this.removeAllListeners()
  }
}
