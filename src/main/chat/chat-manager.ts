import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import log from '../logger'
import { buildCleanEnv } from '../utils/clean-env'
import { StreamJsonParser } from './stream-parser'
import { normalize } from './normalizer'
import { buildArgs } from './sandbox'
import type { ChatStore } from './chat-store'
import type { ChatEndPayload, ChatStreamPayload } from './chat-types'
import { CANCEL_GRACE_MS, MAX_CONCURRENT, TURN_TIMEOUT_MS } from './constants'

export interface ChatManagerDeps {
  store: ChatStore
  /** Returns absolute path to the `claude` binary. Throws if not installed. */
  getCliBinaryPath: () => string
  /**
   * Optional args to prepend before the normal buildArgs output. Used by
   * tests to invoke `node fake-claude.mjs <args>` where the binary is 'node'
   * and the prefix is the fixture path. Production code leaves this empty.
   */
  argsPrefix?: string[]
  regionEnv: () => Record<string, string>
  extraEnv: () => Record<string, string>
  onEvent: (p: ChatStreamPayload) => void
  onEnd: (p: ChatEndPayload) => void
}

interface Inflight {
  child: ChildProcess
  requestId: string
  watchdog: NodeJS.Timeout
  cancelled: boolean
  timedOut: boolean
}

export class ChatManager {
  private inflight = new Map<string, Inflight>()

  /** Test-only override — set by integration tests via `(mgr as any).__testOverrideTimeoutMs`. */
  private __testOverrideTimeoutMs?: number

  constructor(private readonly deps: ChatManagerDeps) {}

  inflightCount(): number {
    return this.inflight.size
  }

  async send(chatId: string, text: string): Promise<{ requestId: string }> {
    if (this.inflight.has(chatId)) {
      throw new Error('busy')
    }
    if (this.inflight.size >= MAX_CONCURRENT) {
      throw new Error('too_many_concurrent_chats')
    }

    const meta = this.deps.store.get(chatId)
    if (!meta) throw new Error('invalid_chat_id')

    const binary = this.deps.getCliBinaryPath()
    if (!binary) throw new Error('cli_missing')

    const baseArgs = buildArgs({ meta, text })
    const args = [...(this.deps.argsPrefix ?? []), ...baseArgs]
    const env = buildCleanEnv(this.deps.regionEnv(), this.deps.extraEnv())

    let child: ChildProcess
    try {
      child = spawn(binary, args, {
        cwd: meta.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      log.warn('[chat] spawn failed:', err)
      throw new Error('spawn_failed')
    }

    const requestId = randomUUID()
    const parser = new StreamJsonParser()
    let sessionFromInit: string | null = null

    child.stdout!.on('data', (chunk: Buffer) => {
      for (const raw of parser.feed(chunk)) {
        const events = normalize(raw)
        for (const event of events) {
          if (event.kind === 'meta' && event.sessionId) {
            sessionFromInit = event.sessionId
          }
          this.deps.onEvent({ requestId, event })
        }
      }
    })

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text) log.warn('[chat] stderr:', text.slice(0, 500))
    })

    const rec: Inflight = {
      child,
      requestId,
      watchdog: undefined as unknown as NodeJS.Timeout,
      cancelled: false,
      timedOut: false,
    }
    this.inflight.set(chatId, rec)

    const timeoutMs = this.__testOverrideTimeoutMs ?? TURN_TIMEOUT_MS
    rec.watchdog = setTimeout(() => {
      log.warn('[chat] turn timeout', { chatId })
      const cur = this.inflight.get(chatId)
      if (!cur) return
      cur.timedOut = true
      this.killChild(cur)
    }, timeoutMs)

    child.on('error', (err) => {
      log.warn('[chat] child error:', err)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(rec.watchdog)
      this.inflight.delete(chatId)

      const finalSession = sessionFromInit ?? meta.claudeSessionId ?? null

      let ok = code === 0
      let error: string | undefined
      if (rec.timedOut) {
        ok = false
        error = 'timeout'
      } else if (rec.cancelled) {
        ok = false
        error = 'cancelled'
      } else if (!ok) {
        error = `exit_${code ?? signal ?? 'unknown'}`
      }

      if (ok) {
        // Successful turn — bump counter and persist session id
        this.deps.store
          .update(chatId, {
            messageCount: meta.messageCount + 1,
            claudeSessionId: finalSession,
          })
          .catch((err) => log.warn('[chat] store.update failed:', err))
      } else if (finalSession && !meta.claudeSessionId) {
        // First-turn failure — still persist the session id so retry can resume
        this.deps.store
          .update(chatId, { claudeSessionId: finalSession })
          .catch(() => void 0)
      }

      this.deps.onEnd({
        requestId,
        ok,
        error,
        claudeSessionId: finalSession ?? undefined,
      })
    })

    return { requestId }
  }

  cancel(chatId: string): void {
    const rec = this.inflight.get(chatId)
    if (!rec) return
    rec.cancelled = true
    this.killChild(rec)
  }

  /**
   * Cancel + wait for the child to exit (up to CANCEL_GRACE_MS + 500ms slack).
   * Callers that immediately delete or reuse the chat's cwd must use this
   * rather than fire-and-forget `cancel()` — otherwise the child can keep
   * writing to a soon-to-be-deleted directory during the SIGTERM→SIGKILL
   * grace window (spec §6.5).
   */
  async cancelAndWait(chatId: string): Promise<void> {
    if (!this.inflight.has(chatId)) return
    const deadline = Date.now() + CANCEL_GRACE_MS + 500
    this.cancel(chatId)
    while (this.inflight.has(chatId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  cancelAll(): void {
    for (const id of Array.from(this.inflight.keys())) this.cancel(id)
  }

  private killChild(rec: Inflight): void {
    try {
      rec.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (rec.child.exitCode === null && rec.child.signalCode === null) {
        try {
          rec.child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, CANCEL_GRACE_MS)
  }
}
