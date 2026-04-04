import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { useSettingsStore, resolveTheme } from '../../stores/settings'
import { useI18n } from '../../i18n'

interface SessionMeta {
  id: string
  cwd: string
  title: string
  createdAt: number
  closedAt?: number
  size: number
}

interface HistoryViewProps {
  onClose: () => void
  onOpenProject: (cwd: string) => void
}

const DARK_THEME = {
  background: '#191919', foreground: '#F0EDE8', cursor: '#191919',
  cursorAccent: '#191919', selectionBackground: 'rgba(139, 115, 85, 0.3)',
  black: '#191919', red: '#FC8181', green: '#68D391', yellow: '#ECC94B',
  blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#F0EDE8',
  brightBlack: '#6B6B6B', brightRed: '#FC8181', brightGreen: '#68D391',
  brightYellow: '#ECC94B', brightBlue: '#7AA2F7', brightMagenta: '#BB9AF7',
  brightCyan: '#7DCFFF', brightWhite: '#FFFFFF'
}

const LIGHT_THEME = {
  background: '#FFFFFF', foreground: '#1A1A1A', cursor: '#FFFFFF',
  cursorAccent: '#FFFFFF', selectionBackground: 'rgba(139, 115, 85, 0.2)',
  black: '#1A1A1A', red: '#C53030', green: '#2E8B57', yellow: '#B8860B',
  blue: '#2563EB', magenta: '#7C3AED', cyan: '#0891B2', white: '#F0EFED',
  brightBlack: '#999999', brightRed: '#E53E3E', brightGreen: '#38A169',
  brightYellow: '#D69E2E', brightBlue: '#3B82F6', brightMagenta: '#8B5CF6',
  brightCyan: '#06B6D4', brightWhite: '#FFFFFF'
}

function getTermTheme() {
  return resolveTheme(useSettingsStore.getState().theme) === 'light' ? LIGHT_THEME : DARK_THEME
}

function safeFit(container: HTMLDivElement | null, fitAddon: FitAddon | null) {
  if (!fitAddon || !container || container.offsetWidth === 0) return
  try { fitAddon.fit() } catch { /* ignore */ }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(start: number, end?: number): string {
  if (!end) return ''
  const secs = Math.round((end - start) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function HistoryView({ onClose, onOpenProject }: HistoryViewProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Map<string, string[]> | null>(null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const { t } = useI18n()
  const termContainerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const theme = useSettingsStore((s) => s.theme)
  const fontSize = useSettingsStore((s) => s.fontSize)

  // Load session list
  useEffect(() => {
    window.api.session.list().then(setSessions)
  }, [])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Initialize readonly terminal
  useEffect(() => {
    if (!termContainerRef.current) return

    const term = new Terminal({
      theme: getTermTheme(),
      fontFamily: '"Menlo", "Consolas", "DejaVu Sans Mono", "Courier New", monospace',
      fontSize: useSettingsStore.getState().fontSize,
      lineHeight: 1.5,
      cursorBlink: false,
      disableStdin: true,
      allowProposedApi: true,
      scrollback: 10000,
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.open(termContainerRef.current)

    // Copy support in readonly terminal
    term.attachCustomKeyEventHandler((event) => {
      const modifier = navigator.platform.includes('Mac') ? event.metaKey : event.ctrlKey
      if (!modifier) return true
      if (event.type === 'keydown' && event.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection())
        return false
      }
      return true
    })

    termRef.current = term
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    requestAnimationFrame(() => safeFit(termContainerRef.current, fitAddon))

    const ro = new ResizeObserver(() => safeFit(termContainerRef.current, fitAddon))
    ro.observe(termContainerRef.current)

    return () => { ro.disconnect(); term.dispose() }
  }, [])

  // React to theme changes
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = getTermTheme()
  }, [theme])

  // React to fontSize changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize
      safeFit(termContainerRef.current, fitAddonRef.current)
    }
  }, [fontSize])

  // Load session content when selected
  useEffect(() => {
    if (!selectedId || !termRef.current) return
    let cancelled = false
    setLoading(true)

    window.api.session.read(selectedId).then((content) => {
      if (cancelled || !content || !termRef.current) { setLoading(false); return }
      termRef.current.clear()
      termRef.current.reset()

      const lines = content.split('\n').filter(Boolean)
      let i = 0
      const batchSize = 200
      const writeBatch = () => {
        if (cancelled) { setLoading(false); return }
        const end = Math.min(i + batchSize, lines.length)
        for (; i < end; i++) {
          try {
            const entry = JSON.parse(lines[i]) as { d: string; s?: string }
            if (entry.s !== 'input') termRef.current!.write(entry.d)
          } catch { /* skip */ }
        }
        if (i < lines.length) {
          requestAnimationFrame(writeBatch)
        } else {
          setLoading(false)
          requestAnimationFrame(() => safeFit(termContainerRef.current, fitAddonRef.current))
          if (searchQuery && searchAddonRef.current) {
            searchAddonRef.current.findNext(searchQuery)
          }
        }
      }
      writeBatch()
    })

    return () => { cancelled = true }
  }, [selectedId])

  // Debounced search (300ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!searchQuery.trim()) {
      setSearchResults(null)
      return
    }
    debounceRef.current = setTimeout(async () => {
      const results = await window.api.session.search(searchQuery)
      const map = new Map<string, string[]>()
      for (const r of results) map.set(r.id, r.matches)
      setSearchResults(map)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [searchQuery])

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await window.api.session.delete(id)
    setSessions(prev => prev.filter(s => s.id !== id))
    if (selectedId === id) { setSelectedId(null); termRef.current?.clear() }
  }, [selectedId])

  const handleCopyAll = useCallback(() => {
    if (!termRef.current) return
    termRef.current.selectAll()
    navigator.clipboard.writeText(termRef.current.getSelection())
    termRef.current.clearSelection()
  }, [])

  // Filter + group
  const displayed = searchResults
    ? sessions.filter(s => searchResults.has(s.id))
    : sessions
  const grouped = groupByDate(displayed, t('history.today'), t('history.yesterday'))
  const selectedSession = sessions.find(s => s.id === selectedId)

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Left: session list */}
      <div style={{
        width: 260, background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', flexShrink: 0,
      }}>
        {/* Header */}
        <div
          onClick={onClose}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px',
            cursor: 'pointer', borderBottom: '1px solid var(--border)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.7 }}>
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {t('history.title')}
          </span>
        </div>

        {/* Search with icon */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ position: 'relative' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{
              position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.4, pointerEvents: 'none'
            }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('history.search')}
              style={{
                width: '100%', padding: '6px 8px 6px 28px', fontSize: 12,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-primary)', outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {displayed.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              {searchQuery ? t('history.noResults') : t('history.empty')}
            </div>
          )}
          {grouped.map((group) => (
            <div key={group.label}>
              <div style={{
                padding: '8px 14px 4px', fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)',
              }}>
                {group.label}
              </div>
              {group.items.map((s) => {
                const isSelected = s.id === selectedId
                const isHovered = s.id === hovered
                const matchCount = searchResults?.get(s.id)?.length
                return (
                  <div
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    onMouseEnter={() => setHovered(s.id)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      position: 'relative', padding: '8px 12px 8px 16px', cursor: 'pointer',
                      background: isSelected ? 'var(--accent-subtle)' : isHovered ? 'var(--bg-hover)' : 'transparent',
                      borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
                      transition: 'background 0.1s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, opacity: 0.6 }}>
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                      </svg>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                        {s.title}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 19, fontSize: 10, color: 'var(--text-muted)' }}>
                      <span>{formatTime(s.createdAt)}</span>
                      {s.closedAt && <span>{formatDuration(s.createdAt, s.closedAt)}</span>}
                      <span>{formatSize(s.size)}</span>
                      {matchCount !== undefined && (
                        <span style={{
                          background: 'var(--accent-subtle)', color: 'var(--accent)',
                          borderRadius: 3, padding: '1px 5px', fontWeight: 600,
                        }}>
                          {matchCount}
                        </span>
                      )}
                    </div>
                    {(isHovered || isSelected) && (
                      <span
                        onClick={(e) => handleDelete(s.id, e)}
                        style={{
                          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                          cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: '2px 4px',
                          borderRadius: 4, lineHeight: 1,
                        }}
                      >×</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Right: session content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedSession ? (
          <>
            <div style={{
              padding: '10px 16px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
              background: 'var(--bg-secondary)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedSession.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedSession.cwd}
                </div>
              </div>
              <button
                onClick={handleCopyAll}
                style={{
                  padding: '5px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
                  background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
                }}
              >
                {t('history.copyAll')}
              </button>
              <button
                onClick={() => onOpenProject(selectedSession.cwd)}
                style={{
                  padding: '5px 10px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
                  background: 'var(--accent)', color: '#fff', border: 'none',
                }}
              >
                {t('history.openInTerminal')}
              </button>
            </div>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
              {loading && (
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--bg-primary)', zIndex: 10,
                }}>
                  <div style={{
                    width: 24, height: 24, border: '2px solid var(--border)',
                    borderTopColor: 'var(--accent)', borderRadius: '50%',
                    animation: 'spin 0.75s linear infinite',
                  }} />
                </div>
              )}
              <div ref={termContainerRef} style={{ position: 'absolute', inset: 0 }} />
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            {t('history.selectSession')}
          </div>
        )}
      </div>
    </div>
  )
}

function groupByDate(sessions: SessionMeta[], todayLabel: string, yesterdayLabel: string): { label: string; items: SessionMeta[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000

  const groups = new Map<string, SessionMeta[]>()
  for (const s of sessions) {
    const day = new Date(s.createdAt)
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
    const label = dayStart === today ? todayLabel
      : dayStart === yesterday ? yesterdayLabel
      : day.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(s)
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }))
}
