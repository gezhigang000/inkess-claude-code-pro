/**
 * Integration tests for chat mode isolation and mode-switch scenarios.
 *
 * These tests use the real ChatManager + ChatStore + fake-claude fixture
 * to verify that:
 * 1. Multiple ChatManager instances can init/destroy independently
 * 2. cancelAll reliably cleans up all in-flight children
 * 3. ChatStore survives init failure gracefully
 * 4. Concurrent create + cancel doesn't corrupt state
 * 5. Re-init after cancelAll works cleanly (simulates mode switch back)
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

vi.mock('@main/logger', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

import { initEmptyMcpConfig } from '../../src/main/chat/sandbox'
import { ChatManager } from '../../src/main/chat/chat-manager'

beforeAll(() => {
  initEmptyMcpConfig(join(tmpdir(), 'inkess-test'))
})
import { ChatStore } from '../../src/main/chat/chat-store'
import type { ChatStreamPayload, ChatEndPayload } from '../../src/main/chat/chat-types'

const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')

function setup(scenarioArgs: string[] = ['--scenario=happy']) {
  const baseDir = mkdtempSync(join(tmpdir(), 'chat-switch-'))
  const store = new ChatStore(baseDir, '2.1.98')
  const events: ChatStreamPayload[] = []
  const ends: ChatEndPayload[] = []

  const mgr = new ChatManager({
    store,
    getCliBinaryPath: () => 'node',
    argsPrefix: [FAKE, ...scenarioArgs],
    regionEnv: () => ({}),
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

function waitForNEnds(ends: ChatEndPayload[], n: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ends.length >= n) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`expected ${n} ends, got ${ends.length}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('Mode switch: cancelAll cleans up all in-flight chats', () => {
  it('cancels 3 concurrent chats and leaves inflightCount at 0', async () => {
    const { store, mgr, ends } = setup(['--scenario=cancel-me'])
    await store.init()

    const c1 = await store.create()
    const c2 = await store.create()
    const c3 = await store.create()

    await mgr.send(c1.id, 'a')
    await mgr.send(c2.id, 'b')
    await mgr.send(c3.id, 'c')
    expect(mgr.inflightCount()).toBe(3)

    mgr.cancelAll()

    await waitForNEnds(ends, 3)
    expect(mgr.inflightCount()).toBe(0)
    expect(ends.every((e) => e.ok === false && e.error === 'cancelled')).toBe(true)
  })
})

describe('Mode switch: re-send after cancelAll works', () => {
  it('can send a new message after cancelAll completes', async () => {
    const { store, mgr, ends } = setup(['--scenario=cancel-me'])
    await store.init()

    const chat = await store.create()
    await mgr.send(chat.id, 'first')
    expect(mgr.inflightCount()).toBe(1)

    mgr.cancelAll()
    await waitForNEnds(ends, 1)
    expect(mgr.inflightCount()).toBe(0)

    // Now simulate "mode switch back" — send again with happy scenario
    // (The manager uses the same argsPrefix, so we test with cancel-me which exits on SIGTERM)
    ends.length = 0
    // Chat should accept a new send since inflight is clear
    const { requestId } = await mgr.send(chat.id, 'second')
    expect(requestId).toBeTruthy()

    mgr.cancel(chat.id)
    await waitForEnd(ends)
  })
})

describe('Mode switch: store survives independent of manager', () => {
  it('store data persists even if manager was never created', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'chat-store-only-'))
    const store = new ChatStore(baseDir, '2.1.98')
    await store.init()

    const chat = await store.create()
    await store.update(chat.id, { title: 'persisted' })

    // Simulate re-init (like initChatMode called again)
    const store2 = new ChatStore(baseDir, '2.1.98')
    await store2.init()
    expect(store2.get(chat.id)?.title).toBe('persisted')
  })
})

describe('Mode switch: ChatStore init failure is recoverable', () => {
  it('corrupted index does not prevent re-init', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'chat-corrupt-'))
    const store1 = new ChatStore(baseDir, '2.1.98')
    await store1.init()
    await store1.create()

    // Corrupt the index
    writeFileSync(join(baseDir, 'chats', 'index.json'), 'CORRUPT')

    // Re-init should recover (backup corrupt + start fresh)
    const store2 = new ChatStore(baseDir, '2.1.98')
    await store2.init()
    expect(store2.list()).toEqual([])

    // Can create new chats
    const fresh = await store2.create()
    expect(fresh.id).toBeTruthy()
  })
})

describe('Mode switch: rapid create + cancel does not corrupt store', () => {
  it('create chat, send, cancel immediately — store remains consistent', async () => {
    const { store, mgr, ends } = setup(['--scenario=cancel-me'])
    await store.init()

    // Create and immediately cancel 5 times
    for (let i = 0; i < 5; i++) {
      const chat = await store.create()
      await mgr.send(chat.id, `msg-${i}`)
      mgr.cancel(chat.id)
    }

    await waitForNEnds(ends, 5)
    expect(mgr.inflightCount()).toBe(0)

    // Store should have all 5 chats
    expect(store.list()).toHaveLength(5)

    // Store integrity: all chats are valid ChatMeta objects
    for (const chat of store.list()) {
      expect(chat.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(chat.cwd).toBeTruthy()
      // claudeSessionId may or may not be set — depends on whether the init
      // event arrived before SIGTERM. Both are valid outcomes.
    }
  })
})

describe('Mode switch: getCliBinaryPath failure returns clean error', () => {
  it('returns cli_missing when binary path is empty', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'chat-no-cli-'))
    const store = new ChatStore(baseDir, '2.1.98')
    const ends: ChatEndPayload[] = []

    const mgr = new ChatManager({
      store,
      getCliBinaryPath: () => '', // simulate CLI not installed
      regionEnv: () => ({}),
      extraEnv: () => ({}),
      onEvent: () => {},
      onEnd: (p) => ends.push(p),
    })

    await store.init()
    const chat = await store.create()

    await expect(mgr.send(chat.id, 'hello')).rejects.toThrow('cli_missing')
    expect(mgr.inflightCount()).toBe(0)
  })
})

describe('initChatMode isolation: ChatStore + ChatManager are independent', () => {
  it('two separate store+manager pairs do not interfere', async () => {
    const s1 = setup(['--scenario=happy', '--session=pair-1'])
    const s2 = setup(['--scenario=happy', '--session=pair-2'])

    await s1.store.init()
    await s2.store.init()

    const c1 = await s1.store.create()
    const c2 = await s2.store.create()

    await s1.mgr.send(c1.id, 'from pair 1')
    await s2.mgr.send(c2.id, 'from pair 2')

    await waitForEnd(s1.ends)
    await waitForEnd(s2.ends)

    expect(s1.ends[0].claudeSessionId).toBe('pair-1')
    expect(s2.ends[0].claudeSessionId).toBe('pair-2')

    // Cancelling one doesn't affect the other
    expect(s1.mgr.inflightCount()).toBe(0)
    expect(s2.mgr.inflightCount()).toBe(0)
  })
})
