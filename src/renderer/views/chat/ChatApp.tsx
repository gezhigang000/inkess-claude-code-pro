import { useChatStream } from './hooks/useChatStream'
import { useChatList } from './hooks/useChatList'

export function ChatApp() {
  useChatStream()
  useChatList()

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
        color: 'var(--text-secondary)',
        fontSize: 14,
      }}
    >
      Chat mode (Plan D scaffold — UI coming in subsequent tasks).
    </div>
  )
}
