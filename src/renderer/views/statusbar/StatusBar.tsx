import { useState, useEffect, useRef } from 'react'
import { useTerminalStore } from '../../stores/terminal'
import { useSettingsStore } from '../../stores/settings'
import { useI18n } from '../../i18n'

const MODES = ['suggest', 'autoedit', 'fullauto'] as const
const MODE_LABELS: Record<string, string> = {
  suggest: 'Suggest',
  autoedit: 'Auto Edit',
  fullauto: 'Full Auto',
}
const MODE_COMMANDS: Record<string, string> = {
  suggest: '/permissions suggest\n',
  autoedit: '/permissions auto-edit\n',
  fullauto: '/permissions full-auto\n',
}

/** Simplify model name: "claude-sonnet-4-20250514" → "Sonnet 4" */
function simplifyModel(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'Opus' + (m.includes('-4') ? ' 4' : '')
  if (m.includes('sonnet')) return 'Sonnet' + (m.includes('-4') ? ' 4' : m.includes('-3') ? ' 3.5' : '')
  if (m.includes('haiku')) return 'Haiku' + (m.includes('-4') ? ' 4' : m.includes('-3') ? ' 3.5' : '')
  // Fallback: return first meaningful segment
  return model.split('-').slice(0, 2).join(' ')
}

export function StatusBar() {
  const { tabs, activeTabId, updateTab } = useTerminalStore()
  const { sleepInhibitorEnabled } = useSettingsStore()
  const { t } = useI18n()
  const [sleepActive, setSleepActive] = useState(false)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [modeFlash, setModeFlash] = useState<string | null>(null)
  const modeFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  // Clean up flash timer on unmount
  useEffect(() => {
    return () => { if (modeFlashTimerRef.current) clearTimeout(modeFlashTimerRef.current) }
  }, [])

  // Fetch git branch for active tab
  useEffect(() => {
    if (!activeTab?.cwd || !activeTab.id) return
    window.api.git.getBranch(activeTab.cwd).then((branch) => {
      if (branch) updateTab(activeTab.id, { gitBranch: branch })
    })
  }, [activeTab?.cwd, activeTab?.id])

  // Listen for PTY activity events
  useEffect(() => {
    const unsub = window.api.pty.onActivity((event) => {
      const tab = useTerminalStore.getState().getTabByPtyId(event.id)
      if (!tab) return
      if (event.type === 'streaming') {
        updateTab(tab.id, { isRunning: true })
      } else if (event.type === 'task-complete' || event.type === 'prompt-idle') {
        updateTab(tab.id, { isRunning: false })
      } else if (event.type === 'model-info' && event.payload) {
        updateTab(tab.id, { model: event.payload })
      } else if (event.type === 'mode-change' && event.payload) {
        updateTab(tab.id, { mode: event.payload as any })
      }
    })
    return () => { unsub() }
  }, [])

  // Listen for sleep inhibitor state
  useEffect(() => {
    const unsub = window.api.power.onSleepInhibitChange((active) => setSleepActive(active))
    return () => { unsub() }
  }, [])

  // Track window width for responsive layout
  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const isCompact = windowWidth < 700
  const isMedium = windowWidth < 900
  const currentMode = activeTab?.mode || 'suggest'

  const handleModeClick = (mode: string) => {
    if (!activeTab?.ptyId || activeTab?.isRunning) return
    window.api.pty.write(activeTab.ptyId, MODE_COMMANDS[mode])
    updateTab(activeTab.id, { mode: mode as any })
    // Flash feedback
    setModeFlash(mode)
    if (modeFlashTimerRef.current) clearTimeout(modeFlashTimerRef.current)
    modeFlashTimerRef.current = setTimeout(() => setModeFlash(null), 300)
  }

  const truncateBranch = (branch: string) =>
    branch.length > 20 ? branch.slice(0, 18) + '...' : branch

  return (
    <div style={{
      height: 24, background: 'var(--bg-secondary)', display: 'flex',
      alignItems: 'center', padding: '0 12px', borderTop: '1px solid var(--border)',
      fontSize: 12, color: 'var(--text-muted)', flexShrink: 0, gap: 12
    }}>
      {/* Connection status — green dot only, no text when connected */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={t('app.connected')}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
      </div>

      {/* Git branch — SVG icon */}
      {!isMedium && activeTab?.gitBranch && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={activeTab.gitBranch}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 15V9a6 6 0 006 6h3" />
          </svg>
          {truncateBranch(activeTab.gitBranch)}
        </div>
      )}

      {/* Model — simplified name */}
      {!isMedium && activeTab?.model && (
        <div title={activeTab.model}>{simplifyModel(activeTab.model)}</div>
      )}

      {/* Thinking shimmer */}
      {!isCompact && activeTab?.isRunning && (
        <div className="shimmer-text" style={{
          background: 'linear-gradient(90deg, var(--text-muted) 25%, var(--accent) 50%, var(--text-muted) 75%)',
          backgroundSize: '200% 100%',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          animation: 'shimmer 2s infinite linear',
        }}>
          Thinking...
        </div>
      )}

      {/* Sleep inhibitor */}
      {sleepInhibitorEnabled && sleepActive && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }} title={t('statusbar.preventingSleep')}>
          ☕
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Mode switcher with flash feedback */}
      <div style={{ display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)' }}>
        {MODES.map((mode) => {
          const isActive = currentMode === mode
          const isFlashing = modeFlash === mode
          return (
            <div
              key={mode}
              onClick={() => handleModeClick(mode)}
              style={{
                padding: '0 8px', fontSize: 11, lineHeight: '18px', cursor: 'pointer',
                background: isFlashing ? 'var(--accent-hover)' : isActive ? 'var(--accent)' : 'transparent',
                color: isActive ? '#fff' : 'var(--text-muted)',
                transition: 'background 0.2s, color 0.2s',
                whiteSpace: 'nowrap',
              }}
            >
              {MODE_LABELS[mode]}
            </div>
          )
        })}
      </div>

    </div>
  )
}
