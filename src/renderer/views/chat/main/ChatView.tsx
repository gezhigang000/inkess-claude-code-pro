import { useChatStore } from '../../../stores/chat'
import { MessageList } from './MessageList'
import { ChatInput } from '../input/ChatInput'

interface Props { chatId: string }

export function ChatView({ chatId }: Props) {
  const chat = useChatStore((s) => s.chats.find((c) => c.id === chatId))
  if (!chat) return null

  return (
    <>
      <div style={{
        padding: '10px 24px',
        borderBottom: '1px solid var(--border)',
        fontSize: 13,
        color: 'var(--text-secondary)',
      }}>
        {chat.title}
      </div>
      <MessageList chatId={chatId} />
      <ChatInput chatId={chatId} />
    </>
  )
}
