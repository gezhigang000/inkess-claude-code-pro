import { app } from 'electron'
import log from './logger'

const API_BASE = 'https://llm.inkessai.com'
const FLUSH_INTERVAL = 60_000
const QUEUE_LIMIT = 20

interface AnalyticsEvent {
  event: string
  props?: Record<string, unknown>
  ts: number
}

export class Analytics {
  private queue: AnalyticsEvent[] = []
  private timer: NodeJS.Timeout | null = null

  constructor() {
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL)
  }

  track(event: string, props?: Record<string, unknown>): void {
    this.queue.push({ event, props, ts: Date.now() })
    if (this.queue.length >= QUEUE_LIMIT) {
      this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)

      await fetch(`${API_BASE}/api/llm/desktop/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          events: batch,
          platform: process.platform,
          version: app.getVersion(),
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))
    } catch {
      // Silent fail — analytics should never break the app
      log.warn(`Analytics: failed to flush ${batch.length} events`)
    }
  }

  flushSync(): void {
    // Best-effort sync flush on app quit
    this.flush()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
