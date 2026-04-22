import { useState } from 'react'
import { useChatStore } from '../../../stores/chat'
import { groupChats } from './groupChats'
import { ChatListItem } from './ChatListItem'
import { DeleteConfirmDialog } from '../modals/DeleteConfirmDialog'
import type { ChatMeta } from '../../../../main/chat/chat-types'

export function ChatSidebar() {
  const chats = useChatStore((s) => s.chats)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const selectChat = useChatStore((s) => s.selectChat)
  const del = useChatStore((s) => s.delete)
  const [pendingDelete, setPendingDelete] = useState<ChatMeta | null>(null)

  const createNew = async () => {
    const meta = await window.api.chat.create()
    selectChat(meta.id)
  }

  const groups = groupChats(chats)

  return (
    <>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <button
          onClick={createNew}
          style={{
            width: '100%',
            padding: '8px 12px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + New chat
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {groups.length === 0 && (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 12,
          }}>
            No chats yet.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <div style={{
              padding: '10px 12px 4px',
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}>
              {g.label}
            </div>
            {g.chats.map((c) => (
              <ChatListItem
                key={c.id}
                chat={c}
                active={c.id === activeChatId}
                onRequestDelete={setPendingDelete}
              />
            ))}
          </div>
        ))}
      </div>

      {pendingDelete && (
        <DeleteConfirmDialog
          chat={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            await del(pendingDelete.id, true)
            setPendingDelete(null)
          }}
        />
      )}
    </>
  )
}
