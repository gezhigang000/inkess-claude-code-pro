import { describe, it, expect, beforeAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildArgs, initEmptyMcpConfig } from '../../src/main/chat/sandbox'
import { ALLOWED_TOOLS } from '../../src/main/chat/constants'
import type { ChatMeta } from '../../src/main/chat/chat-types'

beforeAll(() => {
  initEmptyMcpConfig(join(tmpdir(), 'inkess-test'))
})

const baseMeta: ChatMeta = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Test',
  createdAt: 0,
  updatedAt: 0,
  cwd: '/work/chat-1',
  mountedDirs: [],
  claudeSessionId: null,
  cliVersion: '2.1.98',
  messageCount: 0,
  starred: false,
}

describe('buildArgs', () => {
  it('includes required base flags', () => {
    const args = buildArgs({ meta: baseMeta, text: 'hi' })
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toMatch(/empty-mcp\.json$/)
    expect(args).toContain('--strict-mcp-config')
  })

  it('joins the full ALLOWED_TOOLS list with --allowedTools', () => {
    const args = buildArgs({ meta: baseMeta, text: 'hi' })
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThanOrEqual(0)
    const value = args[idx + 1]
    for (const tool of ALLOWED_TOOLS) expect(value).toContain(tool)
  })

  it('omits --resume when claudeSessionId is null (first turn)', () => {
    const args = buildArgs({ meta: baseMeta, text: 'hi' })
    expect(args).not.toContain('--resume')
  })

  it('includes --resume <id> when claudeSessionId is present', () => {
    const args = buildArgs({ meta: { ...baseMeta, claudeSessionId: 'sess-abc' }, text: 'hi' })
    const i = args.indexOf('--resume')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('sess-abc')
  })

  it('emits one --add-dir per mounted directory, in order', () => {
    const args = buildArgs({
      meta: { ...baseMeta, mountedDirs: ['/foo', '/bar/baz'] },
      text: 'hi',
    })
    const addDirPairs: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--add-dir') addDirPairs.push(args[i + 1])
    }
    expect(addDirPairs).toEqual(['/foo', '/bar/baz'])
  })

  it('passes the user message via --print', () => {
    const args = buildArgs({ meta: baseMeta, text: 'what is 2+2?' })
    const i = args.indexOf('--print')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('what is 2+2?')
  })

  it('keeps text literal — no shell escaping (spawn arg array bypasses shell)', () => {
    const text = `$(rm -rf /) with "quotes" and 中文`
    const args = buildArgs({ meta: baseMeta, text })
    expect(args).toContain(text)
  })

  it('preserves paths with spaces and unicode in --add-dir', () => {
    const args = buildArgs({
      meta: { ...baseMeta, mountedDirs: ['/Users/me/My Docs', '/工作/项目'] },
      text: 'hi',
    })
    const pairs: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--add-dir') pairs.push(args[i + 1])
    }
    expect(pairs).toEqual(['/Users/me/My Docs', '/工作/项目'])
  })
})
