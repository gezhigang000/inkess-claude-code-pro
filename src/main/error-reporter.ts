import { app } from 'electron'
import log from './logger'
import { readFileSync } from 'fs'

const API_BASE = 'https://llm.starapp.net'
const FLUSH_INTERVAL = 60_000
const QUEUE_LIMIT = 10
const MAX_QUEUE_SIZE = 200

interface ErrorEntry {
  message: string
  stack?: string
  source: 'main' | 'renderer'
  ts: number
}

export class ErrorReporter {
  private queue: ErrorEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private tokenGetter: (() => string | null) | null = null
  private flushing = false

  constructor() {
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL)

    // Hook electron-log: intercept error-level logs from main process
    log.hooks.push((message, transport) => {
      if (transport !== log.transports.file) return message
      if (message.level === 'error') {
        const text = message.data?.map((d: unknown) =>
          typeof d === 'string' ? d : d instanceof Error ? d.message : JSON.stringify(d)
        ).join(' ') || ''
        const stack = message.data?.find((d: unknown) => d instanceof Error)?.stack
        this.report(text, stack, 'main')
      }
      return message
    })
  }

  setTokenGetter(fn: () => string | null): void {
    this.tokenGetter = fn
  }

  /** Queue an error for batch upload */
  report(message: string, stack?: string, source: 'main' | 'renderer' = 'main'): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) this.queue.shift() // Drop oldest to prevent memory leak
    this.queue.push({ message: message.slice(0, 2000), stack: stack?.slice(0, 4000), source, ts: Date.now() })
    if (this.queue.length >= QUEUE_LIMIT && !this.flushing) {
      this.flush()
    }
  }

  /** Upload complete log file */
  async uploadLogFile(): Promise<{ success: boolean; error?: string }> {
    try {
      const logPath = log.transports.file.getFile()?.path
      if (!logPath) return { success: false, error: 'Log file not found' }

      const content = readFileSync(logPath, 'utf-8')
      if (!content) return { success: false, error: 'Log file is empty' }

      const token = this.tokenGetter?.()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)

      const res = await fetch(`${API_BASE}/api/llm/desktop/client-logs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'logfile',
          content,
          version: app.getVersion(),
          platform: process.platform,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0 || this.flushing) return
    this.flushing = true
    const batch = this.queue.splice(0)
    const token = this.tokenGetter?.()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)

      await fetch(`${API_BASE}/api/llm/desktop/client-logs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'errors',
          errors: batch,
          version: app.getVersion(),
          platform: process.platform,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))
    } catch {
      // Silent fail
    } finally {
      this.flushing = false
    }
  }

  flushSync(): void {
    // Best-effort: fire async flush, app exit will happen shortly after
    this.flush()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
