import { useEffect } from 'react'
import { useChatStore } from '../../../stores/chat'
import type { ChatEvent, ChatEndPayload } from '../../../../main/chat/chat-types'

/**
 * Subscribes to chat:stream and chat:end exactly once. Mount at the app root
 * (ChatApp) so events keep flowing even when switching between chats.
 */
export function useChatStream(): void {
  const appendEvent = useChatStore((s) => s.appendEvent)
  const markEnded = useChatStore((s) => s.markEnded)

  useEffect(() => {
    const off1 = window.api.chat.onStream((p) => {
      const chatId = useChatStore.getState().findChatByRequestId(p.requestId)
      if (!chatId) return
      appendEvent(chatId, p.event as ChatEvent)
    })
    const off2 = window.api.chat.onEnd((p) => {
      const payload = p as ChatEndPayload
      const chatId = useChatStore.getState().findChatByRequestId(payload.requestId)
      if (!chatId) return
      markEnded(chatId, payload)
    })
    return () => {
      off1()
      off2()
    }
  }, [appendEvent, markEnded])
}
