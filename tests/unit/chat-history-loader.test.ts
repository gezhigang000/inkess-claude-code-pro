import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHistory, encodeCwd } from '../../src/main/chat/history-loader'
import type { ChatMeta } from '../../src/main/chat/chat-types'

function makeMeta(overrides: Partial<ChatMeta> = {}): ChatMeta {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    cwd: '/Users/foo/bar',
    mountedDirs: [],
    claudeSessionId: 'sess-1',
    cliVersion: '2.1.98',
    messageCount: 0,
    starred: false,
    ...overrides,
  }
}

function writeJsonl(path: string, lines: unknown[]) {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

describe('encodeCwd', () => {
  it('replaces every "/" with "-"', () => {
    expect(encodeCwd('/Users/alice/proj')).toBe('-Users-alice-proj')
  })
  it('handles unicode', () => {
    expect(encodeCwd('/工作/项目')).toBe('-工作-项目')
  })
})

describe('loadHistory', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'claude-cfg-'))
  })

  it('returns [] when session id is null', async () => {
    const events = await loadHistory(makeMeta({ claudeSessionId: null }), configDir)
    expect(events).toEqual([])
  })

  it('returns [] when the jsonl file is missing', async () => {
    const events = await loadHistory(makeMeta(), configDir)
    expect(events).toEqual([])
  })

  it('normalizes each JSONL line through the normalizer', async () => {
    const meta = makeMeta()
    const projDir = join(configDir, 'projects', encodeCwd(meta.cwd))
    mkdirSync(projDir, { recursive: true })
    writeJsonl(join(projDir, `${meta.claudeSessionId}.jsonl`), [
      { type: 'system', subtype: 'init', session_id: meta.claudeSessionId },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ])
    const events = await loadHistory(meta, configDir)
    expect(events.some((e) => e.kind === 'meta' && (e as any).sessionId === meta.claudeSessionId)).toBe(true)
    expect(events.some((e) => e.kind === 'text' && (e as any).delta === 'hi')).toBe(true)
    expect(events.some((e) => e.kind === 'tool_result')).toBe(true)
  })

  it('skips malformed lines without throwing', async () => {
    const meta = makeMeta()
    const projDir = join(configDir, 'projects', encodeCwd(meta.cwd))
    mkdirSync(projDir, { recursive: true })
    writeFileSync(
      join(projDir, `${meta.claudeSessionId}.jsonl`),
      'not-json\n{"type":"assistant","message":{"content":[{"type":"text","text":"survived"}]}}\n{oops\n',
    )
    const events = await loadHistory(meta, configDir)
    expect(events.some((e) => e.kind === 'text' && (e as any).delta === 'survived')).toBe(true)
  })
})
