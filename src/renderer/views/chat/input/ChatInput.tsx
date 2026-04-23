import { useRef, useState, useEffect } from 'react'
import { useChatStore } from '../../../stores/chat'

interface Props {
  chatId: string
  /** Text to insert at cursor (set by drag-drop). Cleared after consumption. */
  pendingInsert?: string
  onInsertConsumed?: () => void
}

export function ChatInput({ chatId, pendingInsert, onInsertConsumed }: Props) {
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const streaming = useChatStore((s) => !!s.inflight[chatId]?.streaming)
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // Consume pending insert from drag-drop
  useEffect(() => {
    if (!pendingInsert) return
    setValue((prev) => {
      const sep = prev && !prev.endsWith('\n') && !prev.endsWith(' ') ? ' ' : ''
      return prev + sep + pendingInsert
    })
    onInsertConsumed?.()
    // Focus the textarea so user can continue typing
    taRef.current?.focus()
  }, [pendingInsert, onInsertConsumed])

  // Auto-grow
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [value])

  const submit = async () => {
    const text = value.trim()
    if (!text || streaming) return
    setValue('')
    try {
      await send(chatId, text)
    } catch (err) {
      // surface back to the input so the user sees a clear failure
      const msg = String((err as Error)?.message ?? err)
      console.warn('[chat] send failed:', msg)
      alert(`Send failed: ${msg}`)
      setValue(text)  // restore draft
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts newline
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div style={{
      borderTop: '1px solid var(--border)',
      padding: '12px 24px 16px',
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        maxWidth: 780,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 8,
      }}>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? 'Streaming response…' : 'Message…'}
          disabled={streaming}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 14,
            lineHeight: 1.5,
            fontFamily: 'inherit',
            padding: '6px 4px',
            maxHeight: 200,
          }}
        />
        {streaming ? (
          <button
            onClick={() => cancel(chatId)}
            title="Cancel"
            style={buttonStyle('var(--error)')}
          >
            ⏹
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!value.trim()}
            title="Send (Enter)"
            style={buttonStyle(value.trim() ? 'var(--accent)' : 'var(--bg-tertiary)')}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  )
}

function buttonStyle(bg: string): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    borderRadius: 8,
    background: bg,
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    fontSize: 16,
    flex: '0 0 32px',
  }
}
