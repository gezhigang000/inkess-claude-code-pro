import { useEffect } from 'react'
import { useSettingsStore, applyTheme } from './stores/settings'
import { TerminalApp } from './TerminalApp'
import { ChatApp } from './views/chat/ChatApp'
import { ChatErrorBoundary } from './views/chat/ChatErrorBoundary'

// Re-export helpers that other modules (Sidebar, etc.) import from '../../App'
export { shortenPath, getRecentProjects } from './TerminalApp'

export function App() {
  const appMode = useSettingsStore((s) => s.appMode)
  const theme = useSettingsStore((s) => s.theme)
  const setAppMode = useSettingsStore((s) => s.setAppMode)

  // Apply theme defensively — TerminalApp also does this but may not mount
  // immediately on mode switch.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  if (appMode === 'chat') {
    return (
      <ChatErrorBoundary onFallbackToCliMode={() => setAppMode('cli')}>
        <ChatApp />
      </ChatErrorBoundary>
    )
  }

  return <TerminalApp />
}
