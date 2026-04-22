import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// electron-log requires Electron app context for initialize() — stub it out
vi.mock('@main/logger', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

import { ChatManager } from '../../src/main/chat/chat-manager'
import { ChatStore } from '../../src/main/chat/chat-store'
import type { ChatStreamPayload, ChatEndPayload } from '../../src/main/chat/chat-types'

const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')

function wireUp(scenarioArgs: string[] = []) {
  const baseDir = mkdtempSync(join(tmpdir(), 'chat-mgr-'))
  const store = new ChatStore(baseDir, '2.1.98')
  const events: ChatStreamPayload[] = []
  const ends: ChatEndPayload[] = []

  const mgr = new ChatManager({
    store,
    getCliBinaryPath: () => 'node',
    // argsPrefix is prepended BEFORE the buildArgs output, so fake-claude
    // sees scenario/session args before the -p/--print from buildArgs.
    argsPrefix: [FAKE, ...scenarioArgs],
    regionEnv: () => ({}),
    // buildCleanEnv strips PATH by design — reinject here so the fake-claude
    // fixture can locate `node`. Production code (Plan C) will do the same.
    extraEnv: () => ({ PATH: process.env.PATH || '/usr/bin:/bin' }),
    onEvent: (p) => events.push(p),
    onEnd: (p) => ends.push(p),
  })
  return { store, mgr, events, ends, baseDir }
}

function waitForEnd(ends: ChatEndPayload[], timeoutMs = 5000): Promise<ChatEndPayload> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ends.length) return resolve(ends[ends.length - 1])
      if (Date.now() - start > timeoutMs) return reject(new Error('end timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('ChatManager — happy path', () => {
  it('streams events and ends ok, capturing session id', async () => {
    const { store, mgr, events, ends } = wireUp(['--scenario=happy', '--session=sess-happy'])
    await store.init()
    const chat = await store.create()

    const { requestId } = await mgr.send(chat.id, 'hello')
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)

    const end = await waitForEnd(ends)
    expect(end.ok).toBe(true)
    expect(end.claudeSessionId).toBe('sess-happy')

    const textDeltas = events.filter((e) => e.event.kind === 'text')
    expect(textDeltas).toHaveLength(2)
    expect(textDeltas.map((e) => (e.event as any).delta).join('')).toBe('Hello world.')

    const after = store.get(chat.id)!
    expect(after.claudeSessionId).toBe('sess-happy')
    expect(after.messageCount).toBe(1)
  })
})

describe('ChatManager — single-chat in-flight lock', () => {
  it('rejects second send to same chat while first is running', async () => {
    const { store, mgr } = wireUp(['--scenario=cancel-me'])
    await store.init()
    const chat = await store.create()

    await mgr.send(chat.id, 'first')
    await expect(mgr.send(chat.id, 'second')).rejects.toThrow(/busy/)
    mgr.cancel(chat.id)
  })
})

describe('ChatManager — global concurrency cap', () => {
  it('rejects a 6th concurrent chat', async () => {
    const { store, mgr } = wireUp(['--scenario=cancel-me'])
    await store.init()
    const chats = [
      await store.create(),
      await store.create(),
      await store.create(),
      await store.create(),
      await store.create(),
      await store.create(),
    ]
    for (let i = 0; i < 5; i++) {
      await mgr.send(chats[i].id, 'hi')
    }
    expect(mgr.inflightCount()).toBe(5)
    await expect(mgr.send(chats[5].id, 'hi'))
      .rejects.toThrow(/too_many_concurrent_chats/)

    mgr.cancelAll()
  })
})

describe('ChatManager — cancel', () => {
  it('SIGTERMs the child, reports end ok=false error=cancelled', async () => {
    const { store, mgr, ends } = wireUp(['--scenario=cancel-me'])
    await store.init()
    const chat = await store.create()

    await mgr.send(chat.id, 'hi')
    await new Promise((r) => setTimeout(r, 250))
    mgr.cancel(chat.id)

    const end = await waitForEnd(ends, 5000)
    expect(end.ok).toBe(false)
    expect(end.error).toBe('cancelled')
  })

  it('cancelAndWait resolves only after the child has fully exited', async () => {
    const { store, mgr } = wireUp(['--scenario=cancel-me'])
    await store.init()
    const chat = await store.create()

    await mgr.send(chat.id, 'hi')
    await new Promise((r) => setTimeout(r, 150))
    expect(mgr.inflightCount()).toBe(1)

    await mgr.cancelAndWait(chat.id)
    // Post-return: the inflight record must be gone (child exited + cleaned up)
    expect(mgr.inflightCount()).toBe(0)
  })

  it('cancelAndWait on a non-running chat returns immediately', async () => {
    const { store, mgr } = wireUp()
    await store.init()
    const chat = await store.create()

    const start = Date.now()
    await mgr.cancelAndWait(chat.id)
    expect(Date.now() - start).toBeLessThan(50)
  })
})

describe('ChatManager — crash', () => {
  it('reports end ok=false error=exit_<code> on non-zero exit', async () => {
    const { store, mgr, ends } = wireUp(['--scenario=crash'])
    await store.init()
    const chat = await store.create()

    await mgr.send(chat.id, 'hi')
    const end = await waitForEnd(ends)
    expect(end.ok).toBe(false)
    expect(end.error).toMatch(/^exit_/)
  })
})

describe('ChatManager — bad lines survive', () => {
  it('ignores malformed stream-json lines, still ends ok', async () => {
    const { store, mgr, ends, events } = wireUp(['--scenario=bad-lines', '--session=sess-bad'])
    await store.init()
    const chat = await store.create()

    await mgr.send(chat.id, 'hi')
    const end = await waitForEnd(ends)
    expect(end.ok).toBe(true)
    const texts = events.filter((e) => e.event.kind === 'text')
    expect(texts).toHaveLength(1)
    expect((texts[0].event as any).delta).toBe('survived')
  })
})

describe('ChatManager — timeout watchdog', () => {
  it('SIGTERMs hung child after timeout (override for test)', async () => {
    const { store, mgr, ends } = wireUp(['--scenario=hang'])
    await store.init()
    const chat = await store.create()

    ;(mgr as any).__testOverrideTimeoutMs = 300
    await mgr.send(chat.id, 'hi')
    const end = await waitForEnd(ends, 5000)
    expect(end.ok).toBe(false)
    expect(end.error).toBe('timeout')
  })
})
