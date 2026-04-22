import { useChatStream } from './hooks/useChatStream'
import { useChatList } from './hooks/useChatList'
import { useChatStore } from '../../stores/chat'
import { EmptyState } from './main/EmptyState'

const DRAG_REGION_STYLE: React.CSSProperties = {
  WebkitAppRegion: 'drag',
} as React.CSSProperties

export function ChatApp() {
  useChatStream()
  useChatList()

  const activeChatId = useChatStore((s) => s.activeChatId)

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    }}>
      {/* Top drag bar — matches macOS traffic-light area */}
      <div style={{
        ...DRAG_REGION_STYLE,
        height: 32,
        flex: '0 0 32px',
        background: 'var(--bg-primary)',
      }} />

      {/* Main split */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Sidebar placeholder — Task 3 replaces with <ChatSidebar /> */}
        <aside style={{
          width: 260,
          flex: '0 0 260px',
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
            Sidebar (Task 3)
          </div>
        </aside>

        {/* Main column */}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {activeChatId ? (
            <div style={{ padding: 16, color: 'var(--text-muted)' }}>
              Chat view (Task 4-5) — active: {activeChatId}
            </div>
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  )
}
