import { useState, useEffect, useRef, useCallback } from 'react'
import { useTerminalStore } from '../../stores/terminal'
import { useSettingsStore } from '../../stores/settings'
import { useI18n } from '../../i18n'

const RECENT_KEY = 'inkess-recent-commands'
const MAX_RECENT = 5

interface Command {
  id: string
  label: string
  category: string
  shortcut?: string
  action: () => void
}

export function CommandPalette({ onClose, onNewTab, onSettings, onToggleTheme }: {
  onClose: () => void
  onNewTab: () => void
  onSettings: () => void
  onToggleTheme: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useI18n()

  const recentIds = getRecentCommands()

  const writeToPty = useCallback((text: string) => {
    const store = useTerminalStore.getState()
    const tab = store.tabs.find(t => t.id === store.activeTabId)
    if (tab?.ptyId) window.api.pty.write(tab.ptyId, text)
  }, [])

  const commands: Command[] = [
    // Claude Code commands
    { id: '/model', label: '/model', category: 'Claude Code', shortcut: isMac ? '⌘M' : 'Ctrl+M', action: () => writeToPty('/model\n') },
    { id: '/compact', label: '/compact', category: 'Claude Code', shortcut: isMac ? '⌘⇧C' : 'Ctrl+Shift+C', action: () => writeToPty('/compact\n') },
    { id: '/permissions', label: '/permissions', category: 'Claude Code', action: () => writeToPty('/permissions\n') },
    { id: '/status', label: '/status', category: 'Claude Code', action: () => writeToPty('/status\n') },
    { id: '/help', label: '/help', category: 'Claude Code', action: () => writeToPty('/help\n') },
    { id: '/clear', label: '/clear', category: 'Claude Code', action: () => writeToPty('/clear\n') },
    { id: '/config', label: '/config', category: 'Claude Code', action: () => writeToPty('/config\n') },
    // App commands
    { id: 'new-tab', label: t('cmdPalette.newTab'), category: 'App', shortcut: isMac ? '⌘T' : 'Ctrl+T', action: onNewTab },
    { id: 'settings', label: t('cmdPalette.settings'), category: 'App', shortcut: isMac ? '⌘,' : 'Ctrl+,', action: onSettings },
    { id: 'toggle-theme', label: t('cmdPalette.toggleTheme'), category: 'App', action: onToggleTheme },
    // Mode commands
    { id: 'mode-suggest', label: t('cmdPalette.modeSuggest'), category: 'Mode', action: () => writeToPty('/permissions suggest\n') },
    { id: 'mode-autoedit', label: t('cmdPalette.modeAutoEdit'), category: 'Mode', action: () => writeToPty('/permissions auto-edit\n') },
    { id: 'mode-fullauto', label: t('cmdPalette.modeFullAuto'), category: 'Mode', action: () => writeToPty('/permissions full-auto\n') },
  ]

  // Filter by query (substring match)
  const filtered = query
    ? commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()) || c.category.toLowerCase().includes(query.toLowerCase()))
    : commands

  // Sort: recent first, then by category
  const sorted = [...filtered].sort((a, b) => {
    const aRecent = recentIds.indexOf(a.id)
    const bRecent = recentIds.indexOf(b.id)
    if (aRecent !== -1 && bRecent === -1) return -1
    if (aRecent === -1 && bRecent !== -1) return 1
    if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent
    return 0
  })

  // Group by category for display
  const groups: { category: string; items: Command[] }[] = []
  const recentItems = sorted.filter(c => recentIds.includes(c.id))
  const nonRecentItems = sorted.filter(c => !recentIds.includes(c.id))

  if (recentItems.length > 0 && !query) {
    groups.push({ category: 'Recent', items: recentItems })
  }
  const cats = [...new Set(nonRecentItems.map(c => c.category))]
  cats.forEach(cat => {
    groups.push({ category: cat, items: nonRecentItems.filter(c => c.category === cat) })
  })

  const flatItems = groups.flatMap(g => g.items)

  const executeCommand = (cmd: Command) => {
    saveRecentCommand(cmd.id)
    cmd.action()
    onClose()
  }

  // Keyboard navigation — use refs to avoid stale closures
  const flatItemsRef = useRef(flatItems)
  flatItemsRef.current = flatItems
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, flatItemsRef.current.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter') {
        const cmd = flatItemsRef.current[selectedIndexRef.current]
        if (cmd) executeCommand(cmd)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Reset selection when query changes
  useEffect(() => { setSelectedIndex(0) }, [query])

  // Auto-focus input
  useEffect(() => { inputRef.current?.focus() }, [])

  let itemIndex = -1

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', justifyContent: 'center', paddingTop: 80,
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480, maxHeight: 400, background: 'var(--bg-secondary)',
          borderRadius: 12, border: '1px solid var(--border)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column',
          animation: 'scaleIn 0.15s ease-out',
          alignSelf: 'flex-start',
        }}
      >
        {/* Search input */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('cmdPalette.placeholder')}
            style={{
              width: '100%', height: 32, background: 'transparent', border: 'none',
              color: 'var(--text-primary)', fontSize: 15, outline: 'none',
            }}
          />
        </div>
        {/* Command list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {groups.map((group) => (
            <div key={group.category}>
              <div style={{
                padding: '6px 16px', fontSize: 11, fontWeight: 600,
                color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5,
                borderLeft: '2px solid var(--accent)', marginLeft: 8,
                paddingLeft: 8,
              }}>
                {group.category}
              </div>
              {group.items.map((cmd) => {
                itemIndex++
                const idx = itemIndex
                const isSelected = idx === selectedIndex
                return (
                  <div
                    key={cmd.id}
                    onClick={() => executeCommand(cmd)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    style={{
                      height: 36, display: 'flex', alignItems: 'center', padding: '0 16px',
                      cursor: 'pointer', fontSize: 13,
                      color: 'var(--text-primary)',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      transition: 'background 0.08s',
                    }}
                  >
                    <span style={{ flex: 1 }}>{cmd.label}</span>
                    {cmd.shortcut && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {cmd.shortcut}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {flatItems.length === 0 && (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              {t('cmdPalette.noResults')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const isMac = typeof window !== 'undefined' && navigator.platform?.includes('Mac')

function getRecentCommands(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveRecentCommand(id: string) {
  try {
    const list = getRecentCommands().filter(c => c !== id)
    list.unshift(id)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)))
  } catch { /* ignore */ }
}
