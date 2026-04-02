import { useState } from 'react'
import { useI18n } from '../../i18n'

interface UpdateToastProps {
  currentVersion: string
  latestVersion: string
  onUpdate: () => void
  onDismiss: () => void
}

export function UpdateToast({ currentVersion, latestVersion, onUpdate, onDismiss }: UpdateToastProps) {
  const [updating, setUpdating] = useState(false)
  const { t } = useI18n()

  const handleUpdate = async () => {
    setUpdating(true)
    onUpdate()
  }

  return (
    <div style={{
      width: 320, padding: 16, background: 'var(--bg-secondary)',
      border: '1px solid var(--border)', borderRadius: 10,
      boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t('update.available')}</span>
        </div>
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, padding: 0 }}>×</button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('update.description', { latest: latestVersion, current: currentVersion })}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleUpdate}
          disabled={updating}
          style={{
            flex: 1, padding: '6px 0', background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500,
            cursor: updating ? 'wait' : 'pointer'
          }}
        >
          {updating ? t('update.updating') : t('update.now')}
        </button>
        <button
          onClick={onDismiss}
          style={{
            padding: '6px 12px', background: 'transparent', color: 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer'
          }}
        >
          {t('update.later')}
        </button>
      </div>
    </div>
  )
}
