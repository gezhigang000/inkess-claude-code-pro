import { useState } from 'react'

interface Props {
  name: string
  input: unknown
  result?: string
  isError?: boolean
}

const ICON: Record<string, string> = {
  Read: '📁', Write: '📝', Edit: '✏️', MultiEdit: '✏️',
  Glob: '🔍', Grep: '🔍', NotebookEdit: '📓',
  WebFetch: '🌐', WebSearch: '🌐',
  TodoWrite: '📝', Bash: '⚡',
}

function summarize(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const i = input as Record<string, unknown>
  if (typeof i.file_path === 'string') return `${name} ${i.file_path}`
  if (typeof i.pattern === 'string') return `${name} ${i.pattern}`
  if (typeof i.command === 'string') return `${name} ${i.command}`
  if (typeof i.url === 'string') return `${name} ${i.url}`
  return name
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function ToolCard({ name, input, result, isError }: Props) {
  const [open, setOpen] = useState(false)
  const icon = ICON[name] ?? (name.startsWith('Bash') ? '⚡' : '🔧')
  const waiting = result === undefined

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--bg-secondary)',
      margin: '4px 0',
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summarize(name, input)}
        </span>
        {waiting && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>running…</span>}
        {isError && <span style={{ color: 'var(--error-text)', fontSize: 11 }}>error</span>}
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border)',
          fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
          fontSize: 12,
          color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap',
          maxHeight: 240,
          overflowY: 'auto',
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Input</div>
          <div style={{ marginBottom: result !== undefined ? 8 : 0 }}>{formatInput(input)}</div>
          {result !== undefined && (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Result</div>
              <div style={{ color: isError ? 'var(--error-text)' : 'var(--text-primary)' }}>
                {result}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
