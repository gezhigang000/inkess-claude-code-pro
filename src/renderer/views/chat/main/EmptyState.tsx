export function EmptyState() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: 12,
      color: 'var(--text-muted)',
    }}>
      <div style={{ fontSize: 48, opacity: 0.4 }}>✦</div>
      <div style={{ fontSize: 15 }}>Start a new conversation.</div>
    </div>
  )
}
