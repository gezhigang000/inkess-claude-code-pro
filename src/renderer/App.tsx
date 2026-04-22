import { useEffect, useRef } from 'react'
import { useSettingsStore, applyTheme } from './stores/settings'
import { useChatStore } from './stores/chat'
import { TerminalApp } from './TerminalApp'
import { ChatApp } from './views/chat/ChatApp'

// Re-export helpers that other modules (Sidebar, etc.) import from '../../App'
export { shortenPath, getRecentProjects } from './TerminalApp'

export function App() {
  const appMode = useSettingsStore((s) => s.appMode)
  const theme = useSettingsStore((s) => s.theme)
  const prevModeRef = useRef(appMode)

  // Apply theme defensively — TerminalApp also does this but may not mount
  // immediately on mode switch.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Mode hot-switch cleanup (spec §5.8 §6.5):
  //   CLI → chat: PTYs survive, nothing to cancel here
  //   chat → CLI: cancel any in-flight chat turns so their child processes
  //               aren't orphaned with no UI listening
  useEffect(() => {
    const prev = prevModeRef.current
    if (prev !== appMode) {
      if (prev === 'chat' && appMode === 'cli') {
        const inflight = useChatStore.getState().inflight
        for (const chatId of Object.keys(inflight)) {
          useChatStore.getState().cancel(chatId).catch(() => void 0)
        }
      }
      prevModeRef.current = appMode
    }
  }, [appMode])

  return appMode === 'chat' ? <ChatApp /> : <TerminalApp />
}
