import { useState } from 'react'

interface Props { text: string }

export function ThinkingBlock({ text }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{
      borderLeft: '2px solid var(--border)',
      paddingLeft: 10,
      margin: '4px 0',
      color: 'var(--text-muted)',
      fontSize: 13,
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: 12,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {open ? '▾' : '▸'} Thinking
      </button>
      {open && (
        <div style={{
          marginTop: 4,
          whiteSpace: 'pre-wrap',
          fontStyle: 'italic',
          lineHeight: 1.55,
        }}>
          {text}
        </div>
      )}
    </div>
  )
}
