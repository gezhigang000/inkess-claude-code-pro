import { useState, useEffect } from 'react'
import { useI18n } from '../../i18n'

interface StatsViewProps {
  onClose: () => void
}

type TabId = 'events' | 'sessions' | 'latency' | 'syslog'

interface Summary {
  todayTokens: number
  todaySessionCount: number
  avgPingMs: number | null
  avgTtfbMs: number | null
  storageBytes: number
}

interface EventRow {
  ts: number
  event: string
  detail?: string
}

interface SessionRow {
  ts: number
  sessionId: string
  cwd: string
  duration: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cost?: string
  avgLatency?: number
}

interface LatencyRow {
  ts: number
  type: 'ping' | 'ttfb'
  ms: number
  target?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${s}s`
}

function lastSegment(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
}

const TABLE_HEADER_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
}

const TABLE_CELL_STYLE: React.CSSProperties = {
  padding: '7px 12px',
  fontSize: 12,
  color: 'var(--text-primary)',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--font-mono, monospace)',
  whiteSpace: 'nowrap',
  maxWidth: 240,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export function StatsView({ onClose }: StatsViewProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<TabId>('events')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [latency, setLatency] = useState<LatencyRow[] | null>(null)
  const [syslog, setSyslog] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadSummary = async () => {
    try {
      const s = await window.api.stats.getSummary()
      setSummary(s)
    } catch { /* ignore */ }
  }

  const loadTab = async (tab: TabId) => {
    setLoading(true)
    try {
      if (tab === 'events') {
        const rows = await window.api.stats.getEvents()
        setEvents([...rows].reverse())
      } else if (tab === 'sessions') {
        const rows = await window.api.stats.getSessions()
        setSessions([...rows].reverse())
      } else if (tab === 'latency') {
        const rows = await window.api.stats.getLatency()
        setLatency([...rows].reverse())
      } else if (tab === 'syslog') {
        const log = await window.api.stats.getSystemLog()
        setSyslog(log)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => {
    Promise.all([loadSummary(), loadTab('events')])
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    loadTab(tab)
  }

  const handleClear = async () => {
    if (!confirm(t('stats.clearConfirm'))) return
    await window.api.stats.clear()
    setSummary(null)
    setEvents(null)
    setSessions(null)
    setLatency(null)
    setSyslog(null)
    await loadSummary()
    await loadTab(activeTab)
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'events', label: t('stats.tabEvents') },
    { id: 'sessions', label: t('stats.tabSessions') },
    { id: 'latency', label: t('stats.tabLatency') },
    { id: 'syslog', label: t('stats.tabSystemLog') },
  ]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'var(--bg-primary)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header — extra left padding on macOS to avoid traffic-light overlap */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px',
        paddingLeft: window.api?.platform === 'darwin' ? 80 : 20,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('stats.title')}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 20, lineHeight: 1,
            padding: '0 4px', borderRadius: 4,
          }}
        >
          ×
        </button>
      </div>

      {/* Summary cards */}
      <div style={{
        display: 'flex', gap: 12, padding: '16px 20px',
        borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        {[
          {
            label: t('stats.todayTokens'),
            value: summary ? summary.todayTokens.toLocaleString() : '…',
          },
          {
            label: t('stats.avgPing'),
            value: summary
              ? (summary.avgPingMs != null ? `${summary.avgPingMs}ms` : '—')
              : '…',
          },
          {
            label: t('stats.avgTtfb'),
            value: summary
              ? (summary.avgTtfbMs != null ? `${summary.avgTtfbMs}ms` : '—')
              : '…',
          },
          {
            label: t('stats.todaySessions'),
            value: summary ? String(summary.todaySessionCount) : '…',
          },
          {
            label: t('stats.storage'),
            value: summary ? formatBytes(summary.storageBytes) : '…',
          },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '12px 18px', minWidth: 110, flex: '1 1 110px',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              {card.label}
            </div>
            <div style={{
              fontSize: 20, fontWeight: 700, color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono, monospace)',
            }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 0, padding: '0 20px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
        background: 'var(--bg-secondary)',
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 16px', fontSize: 13, fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
              transition: 'color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0' }}>
        {loading && (
          <div style={{
            padding: 32, textAlign: 'center', fontSize: 13,
            color: 'var(--text-muted)',
          }}>
            ...
          </div>
        )}

        {!loading && activeTab === 'events' && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TABLE_HEADER_STYLE}>{t('stats.time')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.event')}</th>
                <th style={{ ...TABLE_HEADER_STYLE, width: '100%' }}>{t('stats.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {events && events.length > 0 ? events.map((row, i) => (
                <tr key={i}>
                  <td style={TABLE_CELL_STYLE}>{formatTimestamp(row.ts)}</td>
                  <td style={TABLE_CELL_STYLE}>{row.event}</td>
                  <td style={{ ...TABLE_CELL_STYLE, color: 'var(--text-secondary)', maxWidth: 400 }}>
                    {row.detail ?? ''}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={3} style={{ ...TABLE_CELL_STYLE, textAlign: 'center', color: 'var(--text-muted)' }}>
                    {t('stats.noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {!loading && activeTab === 'sessions' && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TABLE_HEADER_STYLE}>{t('stats.time')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.cwd')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.duration')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.tokens')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.cost')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.latency')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions && sessions.length > 0 ? sessions.map((row, i) => (
                <tr key={i}>
                  <td style={TABLE_CELL_STYLE}>{formatTimestamp(row.ts)}</td>
                  <td style={{ ...TABLE_CELL_STYLE, maxWidth: 160 }} title={row.cwd}>
                    {lastSegment(row.cwd)}
                  </td>
                  <td style={TABLE_CELL_STYLE}>{formatDuration(Math.round(row.duration / 1000))}</td>
                  <td style={TABLE_CELL_STYLE}>
                    {row.totalTokens != null ? row.totalTokens.toLocaleString() : '—'}
                  </td>
                  <td style={TABLE_CELL_STYLE}>{row.cost ?? '—'}</td>
                  <td style={TABLE_CELL_STYLE}>
                    {row.avgLatency != null ? `${row.avgLatency}ms` : '—'}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={6} style={{ ...TABLE_CELL_STYLE, textAlign: 'center', color: 'var(--text-muted)' }}>
                    {t('stats.noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {!loading && activeTab === 'latency' && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TABLE_HEADER_STYLE}>{t('stats.time')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.type')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.target')}</th>
                <th style={TABLE_HEADER_STYLE}>{t('stats.ms')}</th>
              </tr>
            </thead>
            <tbody>
              {latency && latency.length > 0 ? latency.map((row, i) => (
                <tr key={i}>
                  <td style={TABLE_CELL_STYLE}>{formatTimestamp(row.ts)}</td>
                  <td style={TABLE_CELL_STYLE}>
                    <span style={{
                      display: 'inline-block',
                      padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                      background: row.type === 'ping' ? 'rgba(59,130,246,0.15)' : 'rgba(139,92,246,0.15)',
                      color: row.type === 'ping' ? '#3B82F6' : '#8B5CF6',
                    }}>
                      {row.type}
                    </span>
                  </td>
                  <td style={{ ...TABLE_CELL_STYLE, maxWidth: 200 }} title={row.target}>
                    {row.target ?? '—'}
                  </td>
                  <td style={TABLE_CELL_STYLE}>{row.ms}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={4} style={{ ...TABLE_CELL_STYLE, textAlign: 'center', color: 'var(--text-muted)' }}>
                    {t('stats.noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {!loading && activeTab === 'syslog' && (
          <pre style={{
            margin: 0, padding: '16px 20px',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12, lineHeight: 1.6,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {syslog ?? t('stats.noData')}
          </pre>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 20px', borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)', flexShrink: 0,
        display: 'flex', justifyContent: 'flex-end',
      }}>
        <button
          onClick={handleClear}
          style={{
            padding: '6px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
            background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
        >
          {t('stats.clearData')}
        </button>
      </div>
    </div>
  )
}
