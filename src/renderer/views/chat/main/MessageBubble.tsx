interface Props {
  role: 'user' | 'assistant'
  text: string
}

export function MessageBubble({ role, text }: Props) {
  const isUser = role === 'user'
  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      padding: '4px 0',
    }}>
      <div style={{
        maxWidth: '85%',
        padding: '10px 14px',
        borderRadius: 12,
        background: isUser ? 'var(--accent)' : 'var(--bg-secondary)',
        color: isUser ? '#fff' : 'var(--text-primary)',
        fontSize: 14,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {text}
      </div>
    </div>
  )
}
