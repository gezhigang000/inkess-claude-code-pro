import { useState, useCallback } from 'react'
import { useChatStore } from '../../../stores/chat'
import { MessageList } from './MessageList'
import { ChatInput } from '../input/ChatInput'

interface Props { chatId: string }

export function ChatView({ chatId }: Props) {
  const chat = useChatStore((s) => s.chats.find((c) => c.id === chatId))
  const [dragOver, setDragOver] = useState(false)
  const [pendingInsert, setPendingInsert] = useState<string | undefined>()
  const clearPendingInsert = useCallback(() => setPendingInsert(undefined), [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    }
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // Only trigger when leaving the container (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragOver(false)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer.files
    if (!files.length) return
    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      const p = (files[i] as File & { path?: string }).path
      if (p) paths.push(p.includes(' ') ? `"${p}"` : p)
    }
    if (paths.length) {
      setPendingInsert(paths.join(' '))
    }
  }, [])

  if (!chat) return null

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div style={{
        padding: '10px 24px',
        borderBottom: '1px solid var(--border)',
        fontSize: 13,
        color: 'var(--text-secondary)',
      }}>
        {chat.title}
      </div>
      <MessageList chatId={chatId} />
      <ChatInput
        chatId={chatId}
        pendingInsert={pendingInsert}
        onInsertConsumed={clearPendingInsert}
      />

      {/* Drag overlay */}
      {dragOver && (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(139, 115, 85, 0.08)',
          border: '2px dashed var(--accent)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 20,
          pointerEvents: 'none',
        }}>
          <div style={{
            fontSize: 14,
            color: 'var(--accent)',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span style={{ fontSize: 20 }}>+</span>
            Drop files to insert path
          </div>
        </div>
      )}
    </div>
  )
}
