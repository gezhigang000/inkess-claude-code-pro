import { useEffect } from 'react'
import { useSettingsStore, applyTheme } from './stores/settings'
import { TerminalApp } from './TerminalApp'

// Re-export helpers that other modules (Sidebar, etc.) import from '../../App'
export { shortenPath, getRecentProjects } from './TerminalApp'

export function App() {
  const theme = useSettingsStore((s) => s.theme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  return <TerminalApp />
}
