import { useEffect, useRef } from 'react'
import { useChatStore, type RenderMessage } from '../../../stores/chat'
import { MessageBubble } from './MessageBubble'
import { ToolCard } from './ToolCard'
import { ThinkingBlock } from './ThinkingBlock'

interface Props { chatId: string }

// Module-level stable fallback. CRITICAL: zustand selectors must return a
// reference-stable value when the underlying state is missing — otherwise
// useSyncExternalStore sees "store changed" on every getSnapshot call and
// triggers an infinite re-render (React error #185).
const EMPTY_MESSAGES: RenderMessage[] = []

export function MessageList({ chatId }: Props) {
  const messages = useChatStore((s) => s.messages[chatId] ?? EMPTY_MESSAGES)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Smart auto-scroll: only snap to bottom when the user is already near the
  // bottom. Lets them scroll up to read old context without being yanked down
  // on every stream event.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 24px',
      }}
    >
      <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
      </div>
    </div>
  )
}

function MessageRow({ message }: { message: RenderMessage }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    return <MessageBubble role="user" text={text} />
  }
  // Assistant — render each part in order
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {message.parts.map((p, idx) => {
        if (p.kind === 'text') return <MessageBubble key={idx} role="assistant" text={p.text} />
        if (p.kind === 'tool') return (
          <ToolCard key={idx}
            name={p.name}
            input={p.input}
            result={p.result}
            isError={p.isError}
          />
        )
        if (p.kind === 'thinking') return <ThinkingBlock key={idx} text={p.text} />
        return null
      })}
    </div>
  )
}
