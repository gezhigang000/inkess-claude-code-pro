import { describe, it, expect } from 'vitest'
import { normalize } from '../../src/main/chat/normalizer'
import type { ChatEvent } from '../../src/main/chat/chat-types'

describe('normalize', () => {
  it('extracts session_id from system.init as meta event', () => {
    const out = normalize({ type: 'system', subtype: 'init', session_id: 'abc-123', tools: [] })
    expect(out).toEqual([{ kind: 'meta', sessionId: 'abc-123', raw: expect.anything() }])
  })

  it('emits text kind for assistant text block', () => {
    const out = normalize({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    })
    expect(out).toEqual([{ kind: 'text', delta: 'Hello' }])
  })

  it('emits multiple events for multi-block assistant message', () => {
    const out = normalize({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading file.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.txt' } },
        ],
      },
    })
    expect(out).toEqual<ChatEvent[]>([
      { kind: 'text', delta: 'Reading file.' },
      { kind: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.txt' } },
    ])
  })

  it('emits thinking kind for thinking block', () => {
    const out = normalize({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'Let me think...' }] },
    })
    expect(out).toEqual([{ kind: 'thinking', delta: 'Let me think...' }])
  })

  it('emits tool_result from user message (string content)', () => {
    const out = normalize({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file content', is_error: false }],
      },
    })
    expect(out).toEqual([
      { kind: 'tool_result', toolUseId: 'tu_1', content: 'file content', isError: false },
    ])
  })

  it('flattens array content in tool_result to a string', () => {
    const out = normalize({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }],
          is_error: false,
        }],
      },
    })
    expect(out).toEqual([
      { kind: 'tool_result', toolUseId: 'tu_2', content: 'line 1\nline 2', isError: false },
    ])
  })

  it('preserves is_error true', () => {
    const out = normalize({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: 'oops', is_error: true }],
      },
    })
    expect(out[0]).toMatchObject({ kind: 'tool_result', isError: true })
  })

  it('emits usage from result event', () => {
    const out = normalize({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    expect(out).toContainEqual({ kind: 'usage', inputTokens: 100, outputTokens: 50 })
  })

  it('yields meta with raw for unknown type', () => {
    const raw = { type: 'unknown-future-event', foo: 'bar' }
    const out = normalize(raw)
    expect(out).toEqual([{ kind: 'meta', raw }])
  })

  it('returns empty array for non-object input', () => {
    expect(normalize(null)).toEqual([])
    expect(normalize('string')).toEqual([])
    expect(normalize(42)).toEqual([])
  })

  it('tolerates missing optional fields', () => {
    expect(normalize({ type: 'assistant', message: {} })).toEqual([])
    const out = normalize({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    })
    expect(out[0]).toMatchObject({ isError: false })
  })
})
