import { useEffect } from 'react'
import { useChatStore } from '../../../stores/chat'

/**
 * Subscribes to chat:listChanged — a broadcast the main process sends after
 * any index.json mutation (create, rename, delete). Reloads the list each
 * time; debounce if the broadcast ever gets chatty (it doesn't today).
 */
export function useChatList(): void {
  const loadChatList = useChatStore((s) => s.loadChatList)

  useEffect(() => {
    // Initial load
    loadChatList()
    const off = window.api.chat.onListChanged(() => { loadChatList() })
    return () => { off() }
  }, [loadChatList])
}
