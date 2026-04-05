import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'

type Phase = 'idle' | 'installing' | 'resolving' | 'starting' | 'testing' | 'connected' | 'failed'

interface TunGateProps {
  proxyUrl: string
  onReady: () => void
}

const WORKING_PHASES: Phase[] = ['idle', 'installing', 'resolving', 'starting', 'testing']

export function TunGate({ proxyUrl, onReady }: TunGateProps) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [latency, setLatency] = useState<number | null>(null)
  const cancelledRef = useRef(false)

  const connect = async () => {
    cancelledRef.current = false
    setPhase('idle')
    setError(null)
    setLatency(null)

    try {
      // Check if sing-box already running
      const info = await window.api.singbox.getInfo()
      if (cancelledRef.current) return

      if (info.status === 'running') {
        // Already running — test connectivity
        setPhase('testing')
        const result = await window.api.singbox.testConnectivity()
        if (cancelledRef.current) return

        if (result.success) {
          setLatency(result.latency ?? null)
          setPhase('connected')
          setTimeout(() => { if (!cancelledRef.current) onReady() }, 500)
          return
        }
        // Connectivity test failed even though running — fall through to restart
        await window.api.singbox.stop()
        if (cancelledRef.current) return
      }

      // Install if needed
      if (!info.installed) {
        setPhase('installing')
        const installResult = await window.api.singbox.install()
        if (cancelledRef.current) return
        if (!installResult.success) {
          setPhase('failed')
          setError(installResult.error ?? 'Installation failed')
          return
        }
      }

      // Resolve subscription URL
      setPhase('resolving')
      const resolveResult = await window.api.proxy.resolveUrl(proxyUrl)
      if (cancelledRef.current) return
      if (resolveResult.error) {
        setPhase('failed')
        setError(resolveResult.error)
        return
      }

      // Start TUN
      setPhase('starting')
      const startResult = await window.api.singbox.startTun(resolveResult.resolved)
      if (cancelledRef.current) return
      if (!startResult.success) {
        setPhase('failed')
        setError(startResult.error ?? 'Failed to start TUN')
        return
      }

      // Wait 1.5s for TUN to initialize
      await new Promise(resolve => setTimeout(resolve, 1500))
      if (cancelledRef.current) return

      // Test connectivity
      setPhase('testing')
      const connectResult = await window.api.singbox.testConnectivity()
      if (cancelledRef.current) return

      if (connectResult.success) {
        setLatency(connectResult.latency ?? null)
        setPhase('connected')
        setTimeout(() => { if (!cancelledRef.current) onReady() }, 500)
      } else {
        setPhase('failed')
        setError(connectResult.error ?? 'Connectivity test failed')
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setPhase('failed')
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  useEffect(() => {
    connect()
    return () => { cancelledRef.current = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isWorking = WORKING_PHASES.includes(phase) && phase !== 'idle'
  const isConnected = phase === 'connected'
  const isFailed = phase === 'failed'

  const phaseLabel = (() => {
    switch (phase) {
      case 'installing': return t('tun.installing')
      case 'resolving':  return t('tun.resolving')
      case 'starting':   return t('tun.starting')
      case 'testing':    return t('tun.testing')
      case 'connected':  return latency != null ? `${t('tun.connected')} (${latency}ms)` : t('tun.connected')
      case 'failed':     return t('tun.failed')
      default:           return t('tun.testing')
    }
  })()

  const globeColor = isConnected ? '#22c55e' : isFailed ? '#ef4444' : 'var(--accent)'

  return (
    <>
      <style>{`
        @keyframes tun-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-primary)',
      }}>
        <div style={{
          width: 360, padding: '40px 32px', borderRadius: 16,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          textAlign: 'center',
        }}>
          {/* Globe icon */}
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: 'var(--accent-subtle)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
              stroke={globeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>

          {/* Title */}
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)',
          }}>
            {t('tun.title')}
          </h2>

          {/* Phase status + spinner */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 14, color: isConnected ? '#22c55e' : isFailed ? '#ef4444' : 'var(--text-muted)',
          }}>
            {isWorking && (
              <div style={{
                width: 14, height: 14, borderRadius: '50%',
                border: '2px solid var(--accent-subtle)',
                borderTopColor: 'var(--accent)',
                animation: 'tun-spin 0.8s linear infinite',
                flexShrink: 0,
              }} />
            )}
            <span>{phaseLabel}</span>
          </div>

          {/* Error detail box */}
          {isFailed && error && (
            <div style={{
              width: '100%', padding: '10px 14px', borderRadius: 8, boxSizing: 'border-box',
              background: 'var(--bg-primary)', border: '1px solid var(--border)',
              fontSize: 12, color: 'var(--text-muted)',
              textAlign: 'left', wordBreak: 'break-word',
              maxHeight: 100, overflowY: 'auto',
            }}>
              {error}
            </div>
          )}

          {/* Retry button */}
          {isFailed && (
            <button
              onClick={connect}
              style={{
                padding: '9px 24px', fontSize: 14, fontWeight: 600,
                background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer',
              }}
            >
              {t('tun.retry')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
