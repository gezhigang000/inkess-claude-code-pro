import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNetworkStore } from '../../stores/network'
import { useI18n } from '../../i18n'

interface NetworkPopoverProps {
  anchorEl: HTMLElement | null
  onClose: () => void
}

/**
 * Detail panel for the NetworkIndicator. Anchors above the indicator in the
 * StatusBar (pops upward). Shows cached status + action buttons:
 *   - Test Now: re-run the connectivity probe
 *   - Reconnect: confirm + call tun.reconnect() (stops + starts sing-box)
 *
 * Reads + writes useNetworkStore; does not manage its own async state.
 * Network errors from actions are surfaced via the store's lastError.
 */
export function NetworkPopover({ anchorEl, onClose }: NetworkPopoverProps) {
  const { t } = useI18n()
  const tunRunning = useNetworkStore(s => s.tunRunning)
  const latencyMs = useNetworkStore(s => s.latencyMs)
  const actualIp = useNetworkStore(s => s.actualIp)
  const expectedIp = useNetworkStore(s => s.expectedIp)
  const lastError = useNetworkStore(s => s.lastError)
  const lastTestAt = useNetworkStore(s => s.lastTestAt)
  const testing = useNetworkStore(s => s.testing)
  const reconnecting = useNetworkStore(s => s.reconnecting)
  const setTesting = useNetworkStore(s => s.setTesting)
  const setReconnecting = useNetworkStore(s => s.setReconnecting)

  const [confirmingReconnect, setConfirmingReconnect] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Guard against setState on an unmounted component — user may close the
  // popover while a test or reconnect is still in flight. The store flags
  // (testing/reconnecting) still need to be updated globally after unmount,
  // but local state (actionError) must not be touched.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const safeSetActionError = (e: string | null) => {
    if (mountedRef.current) setActionError(e)
  }

  // Compute popover position from anchor rect. The anchor (NetworkIndicator)
  // lives in the StatusBar which may be offset horizontally by the Sidebar,
  // so we cannot hardcode `left`. useLayoutEffect runs synchronously after
  // DOM commit but before paint, so the popover is positioned correctly on
  // first render (no visible flash). Re-compute on window resize.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    const update = () => {
      if (!anchorEl) return
      const rect = anchorEl.getBoundingClientRect()
      const POPOVER_WIDTH = 280
      const MARGIN = 8
      // Align popover's left with the anchor, but keep it fully on-screen.
      let left = rect.left
      if (left + POPOVER_WIDTH + MARGIN > window.innerWidth) {
        left = window.innerWidth - POPOVER_WIDTH - MARGIN
      }
      if (left < MARGIN) left = MARGIN
      // Pop upward: bottom = viewport height - anchor's top + 4px gap
      const bottom = window.innerHeight - rect.top + 4
      setPos({ left, bottom })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchorEl])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current) return
      const target = e.target as Node
      if (popoverRef.current.contains(target)) return
      if (anchorEl && anchorEl.contains(target)) return
      onClose()
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [anchorEl, onClose])

  const handleTest = async () => {
    if (testing || reconnecting) return
    safeSetActionError(null)
    setTesting(true)
    try {
      // Pass current expectedIp so the probe also verifies the exit IP
      // matches the subscription's allocated one.
      const result = await window.api.tun.testConnectivity(expectedIp || undefined)
      if (!result.success && result.error) safeSetActionError(result.error)
    } catch (err) {
      safeSetActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const handleReconnectConfirm = async () => {
    if (reconnecting) return
    safeSetActionError(null)
    setReconnecting(true)
    setConfirmingReconnect(false)
    try {
      const result = await window.api.tun.reconnect()
      if (!result.success) {
        safeSetActionError(result.error || t('network.reconnectFailed'))
      } else {
        // After reconnect, immediately re-test so the UI shows fresh latency
        try { await window.api.tun.testConnectivity(expectedIp || undefined) } catch { /* ignore */ }
      }
    } catch (err) {
      safeSetActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnecting(false)
    }
  }

  // Format lastTestAt as HH:MM:SS
  const formatTime = (ts: number | null) => {
    if (!ts) return '—'
    const d = new Date(ts)
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  const statusText = reconnecting
    ? t('network.reconnecting')
    : testing
    ? t('network.testing')
    : !tunRunning
    ? t('network.offline')
    : lastError
    ? t('network.error')
    : t('network.connected')

  const statusColor = reconnecting || testing
    ? 'var(--text-muted)'
    : !tunRunning || lastError
    ? 'var(--error, #ef4444)'
    : 'var(--success, #22c55e)'

  const ipMismatch = actualIp && expectedIp && actualIp !== expectedIp
  const btnDisabled = testing || reconnecting

  if (!pos) return null
  return (
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        left: pos.left,
        bottom: pos.bottom,
        width: 280,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        padding: 12,
        fontSize: 12,
        color: 'var(--text-primary)',
        zIndex: 1000,
      }}
    >
      {/* Header: state */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: statusColor,
          animation: (testing || reconnecting) ? 'pulse 1s infinite' : undefined,
        }} />
        <span style={{ fontWeight: 600 }}>{statusText}</span>
      </div>

      {/* Detail rows */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', color: 'var(--text-secondary)', marginBottom: 10 }}>
        <span>{t('network.exitIp')}</span>
        <span style={{ fontFamily: 'var(--font-mono, monospace)', color: ipMismatch ? 'var(--error, #ef4444)' : 'var(--text-primary)' }}>
          {actualIp || '—'}
        </span>

        <span>{t('network.latency')}</span>
        <span>{latencyMs != null ? `${latencyMs} ms` : '—'}</span>

        <span>{t('network.lastTest')}</span>
        <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatTime(lastTestAt)}</span>
      </div>

      {/* Warning/error banner */}
      {ipMismatch && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: 4,
          padding: 6,
          marginBottom: 8,
          color: 'var(--error, #ef4444)',
          fontSize: 11,
        }}>
          {t('network.ipMismatch', { expected: expectedIp || '', actual: actualIp || '' })}
        </div>
      )}
      {actionError && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: 4,
          padding: 6,
          marginBottom: 8,
          color: 'var(--error, #ef4444)',
          fontSize: 11,
          wordBreak: 'break-word',
        }}>
          {actionError}
        </div>
      )}

      {/* Action buttons or confirm panel */}
      {!confirmingReconnect ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleTest}
            disabled={btnDisabled}
            style={{
              flex: 1,
              padding: '6px 0',
              background: 'transparent',
              color: btnDisabled ? 'var(--text-muted)' : 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              cursor: btnDisabled ? 'not-allowed' : 'pointer',
              fontSize: 12,
            }}
          >
            {testing ? t('network.testing') : t('network.testNow')}
          </button>
          <button
            onClick={() => setConfirmingReconnect(true)}
            disabled={btnDisabled}
            style={{
              flex: 1,
              padding: '6px 0',
              background: btnDisabled ? 'transparent' : 'var(--accent)',
              color: btnDisabled ? 'var(--text-muted)' : '#fff',
              border: '1px solid ' + (btnDisabled ? 'var(--border)' : 'var(--accent)'),
              borderRadius: 4,
              cursor: btnDisabled ? 'not-allowed' : 'pointer',
              fontSize: 12,
            }}
          >
            {reconnecting ? t('network.reconnecting') : t('network.reconnect')}
          </button>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {t('network.reconnectConfirm')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setConfirmingReconnect(false)}
              style={{
                flex: 1, padding: '6px 0', background: 'transparent',
                color: 'var(--text-primary)', border: '1px solid var(--border)',
                borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              {t('network.cancel')}
            </button>
            <button
              onClick={handleReconnectConfirm}
              style={{
                flex: 1, padding: '6px 0', background: 'var(--error, #ef4444)',
                color: '#fff', border: '1px solid var(--error, #ef4444)',
                borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              {t('network.reconnect')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
