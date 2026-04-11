import { useState, useRef, useEffect } from 'react'
import { useNetworkStore } from '../../stores/network'
import { useI18n } from '../../i18n'
import { NetworkPopover } from './NetworkPopover'

/**
 * Color-coded dot + latency text for the StatusBar. Click opens the
 * NetworkPopover with detail + actions (test / reconnect).
 */
export function NetworkIndicator() {
  const { t } = useI18n()
  const tunRunning = useNetworkStore(s => s.tunRunning)
  const latencyMs = useNetworkStore(s => s.latencyMs)
  const lastError = useNetworkStore(s => s.lastError)
  const testing = useNetworkStore(s => s.testing)
  const reconnecting = useNetworkStore(s => s.reconnecting)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  // Close popover on Escape
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [popoverOpen])

  // Choose color + text based on state.
  // Precedence: reconnecting > testing > error > no data > latency buckets
  let dotColor: string
  let text: string
  if (reconnecting) {
    dotColor = 'var(--warning-text, #f59e0b)'
    text = t('network.reconnecting')
  } else if (testing) {
    dotColor = 'var(--text-muted)'
    text = t('network.testing')
  } else if (!tunRunning) {
    dotColor = 'var(--error, #ef4444)'
    text = t('network.offline')
  } else if (lastError) {
    dotColor = 'var(--error, #ef4444)'
    text = t('network.error')
  } else if (latencyMs == null) {
    dotColor = 'var(--text-muted)'
    text = '—'
  } else if (latencyMs < 300) {
    dotColor = 'var(--success, #22c55e)'
    text = `${latencyMs}ms`
  } else if (latencyMs < 800) {
    dotColor = 'var(--warning-text, #f59e0b)'
    text = `${latencyMs}ms`
  } else {
    dotColor = 'var(--error, #ef4444)'
    text = `${latencyMs}ms`
  }

  return (
    <>
      <div
        ref={anchorRef}
        onClick={() => setPopoverOpen((v) => !v)}
        title={t('network.indicatorTooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          cursor: 'pointer',
          userSelect: 'none',
          height: '100%',
          padding: '0 2px',
          // Reserve enough width for "Reconnecting..." so the StatusBar
          // layout does not jitter as the latency text length changes.
          minWidth: 72,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
            transition: 'background 0.3s',
            animation: (reconnecting || testing) ? 'pulse 1s infinite' : undefined,
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {text}
        </span>
      </div>
      {popoverOpen && (
        <NetworkPopover
          anchorEl={anchorRef.current}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </>
  )
}
