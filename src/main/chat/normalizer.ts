import type { ChatEvent } from './chat-types'

/**
 * Translate one raw stream-json object emitted by Claude Code into zero or
 * more flat ChatEvents the renderer can consume directly.
 *
 * Schema (best-effort; update this file if Claude Code changes its output):
 *   - system/init    → meta { sessionId }
 *   - assistant msg  → one event per content block (text | tool_use | thinking)
 *   - user msg       → one tool_result per content block
 *   - result         → usage + meta (raw preserved for debugging)
 *   - anything else  → meta { raw }
 */
export function normalize(raw: unknown): ChatEvent[] {
  if (!raw || typeof raw !== 'object') return []
  const r = raw as Record<string, unknown>

  if (r.type === 'system' && r.subtype === 'init') {
    return [{ kind: 'meta', sessionId: str(r.session_id), raw }]
  }

  if (r.type === 'assistant') {
    const msg = r.message as { content?: unknown[] } | undefined
    const content = Array.isArray(msg?.content) ? msg!.content : []
    return content.map(normalizeAssistantBlock).filter(Boolean) as ChatEvent[]
  }

  if (r.type === 'user') {
    const msg = r.message as { content?: unknown } | undefined
    // Claude Code stores user-typed text two ways:
    //   (a) message.content: string              (short messages)
    //   (b) message.content: [{ type:'text', text }, ...]   (richer messages)
    // And tool results come back as message.content: [{ type:'tool_result', ... }, ...]
    if (typeof msg?.content === 'string') {
      return msg.content ? [{ kind: 'user_text', text: msg.content }] : []
    }
    const content = Array.isArray(msg?.content) ? msg!.content as unknown[] : []
    return content.map(normalizeUserBlock).filter(Boolean) as ChatEvent[]
  }

  if (r.type === 'result') {
    const out: ChatEvent[] = []
    const usage = r.usage as { input_tokens?: number; output_tokens?: number } | undefined
    if (usage) {
      out.push({
        kind: 'usage',
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      })
    }
    out.push({ kind: 'meta', raw })
    return out
  }

  return [{ kind: 'meta', raw }]
}

function normalizeAssistantBlock(block: unknown): ChatEvent | null {
  if (!block || typeof block !== 'object') return null
  const b = block as Record<string, unknown>
  if (b.type === 'text') {
    return { kind: 'text', delta: str(b.text) }
  }
  if (b.type === 'tool_use') {
    return {
      kind: 'tool_use',
      id: str(b.id),
      name: str(b.name),
      input: b.input ?? {},
    }
  }
  if (b.type === 'thinking') {
    return { kind: 'thinking', delta: str(b.thinking) }
  }
  return null
}

function normalizeUserBlock(block: unknown): ChatEvent | null {
  if (!block || typeof block !== 'object') return null
  const b = block as Record<string, unknown>

  // User-typed text block (from history replay — spawn-time user input
  // is shown optimistically by the renderer store and persisted by Claude
  // Code to the JSONL with the same shape).
  if (b.type === 'text') {
    const text = str(b.text)
    return text ? { kind: 'user_text', text } : null
  }

  if (b.type !== 'tool_result') return null

  let content: string
  if (typeof b.content === 'string') {
    content = b.content
  } else if (Array.isArray(b.content)) {
    content = b.content
      .map((item) => {
        if (item && typeof item === 'object' && (item as any).type === 'text') {
          return str((item as any).text)
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  } else {
    content = ''
  }

  return {
    kind: 'tool_result',
    toolUseId: str(b.tool_use_id),
    content,
    isError: b.is_error === true,
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
