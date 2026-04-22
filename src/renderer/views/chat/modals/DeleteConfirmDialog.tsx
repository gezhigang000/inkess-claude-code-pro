import type { ChatMeta } from '../../../../main/chat/chat-types'

interface Props {
  chat: ChatMeta
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteConfirmDialog({ chat, onCancel, onConfirm }: Props) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 20,
          width: 380,
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
          Delete this chat?
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
          <div style={{ marginBottom: 8 }}>"{chat.title}"</div>
          <div>The chat workspace and all files inside it will be removed.</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 13,
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 13,
              background: 'var(--error)', color: '#fff',
              border: 'none', cursor: 'pointer',
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
