import { useState, useEffect, useRef } from 'react'
import { useSettingsStore } from '../../stores/settings'
import { useTerminalStore } from '../../stores/terminal'
import { useI18n } from '../../i18n'

interface SettingsPanelProps {
  onClose: () => void
  onLogout?: () => void
  onTunStatusChange?: (ok: boolean) => void
}

export function SettingsPanel({ onClose, onLogout, onTunStatusChange }: SettingsPanelProps) {
  const [activeSection, setActiveSection] = useState<'account' | 'network' | 'appearance' | 'language' | 'about'>('account')
  const { fontSize, language, theme, setFontSize, setLanguage, setTheme } = useSettingsStore()
  const { t } = useI18n()

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const sections = [
    { id: 'account' as const, label: t('settings.account'), icon: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 3a4 4 0 100 8 4 4 0 000-8z' },
    { id: 'network' as const, label: t('settings.network'), icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' },
    { id: 'appearance' as const, label: t('settings.appearance'), icon: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z' },
    { id: 'language' as const, label: t('settings.language'), icon: 'M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129' },
    { id: 'about' as const, label: t('settings.about'), icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  ]

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{
        position: 'relative', margin: 'auto', width: 640, height: 480,
        background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border)',
        display: 'flex', overflow: 'hidden'
      }}>
        {/* Sidebar */}
        <div style={{ width: 180, background: 'var(--bg-secondary)', padding: '16px 8px', borderRight: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '0 8px', marginBottom: 8 }}>{t('settings.title')}</div>
          {sections.map(s => (
            <div
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6,
                fontSize: 13, cursor: 'pointer',
                color: activeSection === s.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: activeSection === s.id ? 'var(--bg-hover)' : 'transparent'
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={s.icon} /></svg>
              {s.label}
            </div>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
              {sections.find(s => s.id === activeSection)?.label}
            </h3>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
          </div>

          {activeSection === 'account' && (
            <AccountSection onLogout={onLogout} />
          )}
          {activeSection === 'network' && (
            <NetworkSection onTunStatusChange={onTunStatusChange} />
          )}
          {activeSection === 'appearance' && (
            <AppearanceSection
              fontSize={fontSize} onFontSizeChange={setFontSize}
              theme={theme} onThemeChange={setTheme}
            />
          )}
          {activeSection === 'language' && (
            <LanguageSection language={language} onChange={setLanguage} />
          )}
          {activeSection === 'about' && (
            <AboutSection />
          )}
        </div>
      </div>
    </div>
  )
}

// --- Shared styles ---

const focusableInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
  transition: 'border-color 0.15s',
}

const disabledBtnBase: React.CSSProperties = {
  cursor: 'not-allowed', opacity: 0.5,
}

// --- Section Components ---

const REGION_OPTIONS = [
  { id: 'us',   label: '🇺🇸 US East',       tz: 'America/New_York' },
  { id: 'usw',  label: '🇺🇸 US West',       tz: 'America/Los_Angeles' },
  { id: 'gb',   label: '🇬🇧 United Kingdom', tz: 'Europe/London' },
  { id: 'de',   label: '🇩🇪 Germany',        tz: 'Europe/Berlin' },
  { id: 'jp',   label: '🇯🇵 Japan',          tz: 'Asia/Tokyo' },
  { id: 'kr',   label: '🇰🇷 Korea',          tz: 'Asia/Seoul' },
  { id: 'sg',   label: '🇸🇬 Singapore',      tz: 'Asia/Singapore' },
  { id: 'hk',   label: '🇭🇰 Hong Kong',      tz: 'Asia/Hong_Kong' },
  { id: 'tw',   label: '🇹🇼 Taiwan',         tz: 'Asia/Taipei' },
  { id: 'au',   label: '🇦🇺 Australia',      tz: 'Australia/Sydney' },
  { id: 'auto', label: '🖥 System (no mask)', tz: '' },
]

function NetworkSection({ onTunStatusChange }: { onTunStatusChange?: (ok: boolean) => void }) {
  const { t } = useI18n()
  const { proxyUrl, proxyRegion, setProxyUrl, setProxyRegion } = useSettingsStore()

  const region = REGION_OPTIONS.find(r => r.id === proxyRegion) || REGION_OPTIONS[0]

  const envVars: string[] = []
  if (proxyRegion !== 'auto' && region.tz) {
    envVars.push(`TZ=${region.tz}`)
    const lang = proxyRegion === 'de' ? 'de_DE' : proxyRegion === 'jp' ? 'ja_JP' : proxyRegion === 'kr' ? 'ko_KR' : proxyRegion === 'tw' ? 'zh_TW' : 'en_US'
    envVars.push(`LANG=${lang}.UTF-8`)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* TUN proxy URL */}
      <SettingsGroup title={t('settings.proxyUrl')}>
        <FocusInput value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} placeholder="ss://... / vmess://... / https://panel.xxx/api/sub/..." />
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{t('settings.proxyTunUrlHint')}</div>
      </SettingsGroup>
      <TunControl proxyUrl={proxyUrl} onTunStatusChange={onTunStatusChange} />

      {/* Region selector */}
      <SettingsGroup title={t('settings.proxyRegion')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {REGION_OPTIONS.map(r => (
            <div key={r.id} onClick={() => setProxyRegion(r.id)} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
              borderRadius: 6, cursor: 'pointer', fontSize: 13,
              background: proxyRegion === r.id ? 'var(--accent-subtle)' : 'transparent',
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: proxyRegion === r.id ? 'var(--accent)' : 'transparent',
                border: proxyRegion === r.id ? 'none' : '2px solid var(--text-muted)',
              }} />
              <span style={{ color: 'var(--text-primary)' }}>{r.label}</span>
              {r.tz && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{r.tz}</span>}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{t('settings.proxyRegionHint')}</div>
      </SettingsGroup>

      {/* Env preview */}
      {envVars.length > 0 && (
        <SettingsGroup title={t('settings.proxyStatus')}>
          <div style={{
            padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 6,
            fontSize: 12, color: 'var(--text-secondary)', fontFamily: '"Menlo", "Consolas", monospace',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            {envVars.map(v => <div key={v}>{v}</div>)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{t('settings.proxyApplyHint')}</div>
        </SettingsGroup>
      )}
    </div>
  )
}

function AppearanceSection({ fontSize, onFontSizeChange, theme, onThemeChange }: {
  fontSize: number; onFontSizeChange: (v: number) => void
  theme: 'auto' | 'dark' | 'light'; onThemeChange: (v: 'auto' | 'dark' | 'light') => void
}) {
  const { t } = useI18n()
  const {
    notificationsEnabled, setNotificationsEnabled,
    sleepInhibitorEnabled, setSleepInhibitorEnabled
  } = useSettingsStore()
  const themeOptions: { id: 'auto' | 'dark' | 'light'; label: string }[] = [
    { id: 'auto', label: t('settings.themeAuto') },
    { id: 'dark', label: t('settings.themeDark') },
    { id: 'light', label: t('settings.themeLight') },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SettingsGroup title={t('settings.theme')}>
        {themeOptions.map(opt => (
          <div
            key={opt.id}
            onClick={() => onThemeChange(opt.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              borderRadius: 6, cursor: 'pointer',
              background: theme === opt.id ? 'var(--accent-subtle)' : 'transparent'
            }}
          >
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: theme === opt.id ? 'var(--accent)' : 'transparent',
              border: theme === opt.id ? 'none' : '2px solid var(--text-muted)'
            }} />
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{opt.label}</span>
          </div>
        ))}
      </SettingsGroup>
      <SettingsGroup title={t('settings.terminalFontSize')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="range" min={10} max={24} value={fontSize}
            onChange={(e) => onFontSizeChange(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-primary)', minWidth: 30 }}>{fontSize}px</span>
        </div>
      </SettingsGroup>
      <SettingsGroup title={t('settings.notifications')}>
        <ToggleRow
          label={t('settings.notificationsEnabled')}
          checked={notificationsEnabled}
          onChange={setNotificationsEnabled}
        />
      </SettingsGroup>
      <SettingsGroup title={t('settings.sleepInhibitor')}>
        <ToggleRow
          label={t('settings.sleepInhibitorEnabled')}
          checked={sleepInhibitorEnabled}
          onChange={setSleepInhibitorEnabled}
        />
      </SettingsGroup>
    </div>
  )
}

function LanguageSection({ language, onChange }: { language: 'auto' | 'zh' | 'en'; onChange: (v: 'auto' | 'zh' | 'en') => void }) {
  const { t } = useI18n()
  const options: { id: 'auto' | 'zh' | 'en'; label: string }[] = [
    { id: 'auto', label: t('settings.languageAuto') },
    { id: 'zh', label: t('settings.languageZh') },
    { id: 'en', label: t('settings.languageEn') },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SettingsGroup title={t('settings.languageLabel')}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>{t('settings.languageHint')}</div>
        {options.map(opt => (
          <div
            key={opt.id}
            onClick={() => onChange(opt.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              borderRadius: 6, cursor: 'pointer',
              background: language === opt.id ? 'var(--accent-subtle)' : 'transparent'
            }}
          >
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: language === opt.id ? 'var(--accent)' : 'transparent',
              border: language === opt.id ? 'none' : '2px solid var(--text-muted)'
            }} />
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{opt.label}</span>
          </div>
        ))}
      </SettingsGroup>
    </div>
  )
}

function AboutSection() {
  const { t } = useI18n()
  const [appVersion, setAppVersion] = useState('')
  const [cliVersion, setCliVersion] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle')

  useEffect(() => {
    window.api.app.getVersion().then(setAppVersion)
    window.api.cli.getInfo().then(info => setCliVersion(info.version))
  }, [])

  const handleUploadLogs = async () => {
    setUploadStatus('uploading')
    try {
      const result = await window.api.log.uploadFile()
      setUploadStatus(result.success ? 'success' : 'error')
    } catch {
      setUploadStatus('error')
    }
    setTimeout(() => setUploadStatus('idle'), 3000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SettingsGroup title={t('settings.version')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Inkess Claude Code Pro</span>
            <span style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>v{appVersion}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Claude Code CLI</span>
            <span style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>{cliVersion ? `v${cliVersion}` : '—'}</span>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup title={t('settings.diagnostics')}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{t('settings.diagnosticsHint')}</div>
        <button
          onClick={handleUploadLogs}
          disabled={uploadStatus === 'uploading'}
          style={{
            padding: '6px 14px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 6, fontSize: 12,
            ...(uploadStatus === 'uploading' ? disabledBtnBase : { cursor: 'pointer' }),
          }}
        >
          {uploadStatus === 'uploading' ? t('settings.uploadingLogs') :
           uploadStatus === 'success' ? t('settings.logsUploaded') :
           uploadStatus === 'error' ? t('settings.logsUploadFailed') :
           t('settings.uploadLogs')}
        </button>
      </SettingsGroup>
    </div>
  )
}

function AccountSection({ onLogout }: { onLogout?: () => void }) {
  const { t } = useI18n()
  const [session, setSession] = useState<{ isLoggedIn: boolean; username: string | null; session: { plan?: string; expiresAt: string; proxyUrl: string; proxyRegion: string } | null } | null>(null)

  useEffect(() => {
    window.api.subscription.getSession().then(setSession)
  }, [])

  if (!session) return null

  const expiresAt = session.session?.expiresAt
  const plan = session.session?.plan || 'monthly'
  const isDaily = plan === 'daily'
  const msRemaining = expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / 86400000))
  const hoursRemaining = Math.max(0, Math.ceil(msRemaining / 3600000))
  const isExpiringSoon = isDaily ? hoursRemaining <= 2 : daysRemaining <= 7

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SettingsGroup title={t('settings.accountInfo')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.accountUsername')}</span>
            <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{session.username || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.accountExpires')}</span>
            <span style={{ fontSize: 13, color: isExpiringSoon ? 'var(--warning)' : 'var(--text-primary)', fontWeight: 500 }}>
              {expiresAt ? (isDaily ? new Date(expiresAt).toLocaleString() : new Date(expiresAt).toLocaleDateString()) : '—'}
              {isDaily
                ? hoursRemaining > 0 && ` (${hoursRemaining}h)`
                : daysRemaining > 0 && ` (${daysRemaining}${t('settings.accountDaysLeft')})`}
            </span>
          </div>
          {session.session?.proxyUrl && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.accountProxy')}</span>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                {session.session.proxyUrl.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@')}
              </span>
            </div>
          )}
        </div>
      </SettingsGroup>

      {onLogout && (
        <button
          onClick={() => {
            onLogout?.()
          }}
          style={{
            padding: '8px 0', fontSize: 13, fontWeight: 500,
            background: 'transparent', color: 'var(--error-text)',
            border: '1px solid var(--border)', borderRadius: 6,
            cursor: 'pointer', width: '100%',
          }}
        >
          {t('settings.logout')}
        </button>
      )}
    </div>
  )
}

function killAllPtySessions() {
  const store = useTerminalStore.getState()
  store.tabs.forEach(tab => {
    if (tab.ptyId && !tab.isExited) {
      window.api.pty.kill(tab.ptyId)
    }
  })
}

function TunControl({ proxyUrl, onTunStatusChange }: { proxyUrl: string; onTunStatusChange?: (ok: boolean) => void }) {
  const { t } = useI18n()
  const [info, setInfo] = useState<{ mode: string; status: string; installed: boolean; lastError: string | null }>({ mode: 'off', status: 'stopped', installed: false, lastError: null })
  const [loading, setLoading] = useState(false)
  const [testResult, setTestResult] = useState<{ status: 'idle' | 'testing' | 'ok' | 'fail'; latency?: number; error?: string }>({ status: 'idle' })

  useEffect(() => {
    window.api.singbox.getInfo().then(setInfo)
    const interval = setInterval(() => window.api.singbox.getInfo().then(setInfo), 3000)
    return () => clearInterval(interval)
  }, [])

  const handleStart = async () => {
    setLoading(true)
    setTestResult({ status: 'idle' })
    if (!info.installed) {
      const install = await window.api.singbox.install()
      if (!install.success) { setLoading(false); return }
    }
    // Resolve subscription URL → protocol URL if needed
    const resolved = await window.api.proxy.resolveUrl(proxyUrl)
    if (resolved.isSubscription && resolved.error) {
      setLoading(false)
      setInfo(prev => ({ ...prev, lastError: resolved.error || 'Failed to fetch subscription' }))
      return
    }
    const tunUrl = resolved.resolved || proxyUrl
    if (!tunUrl) {
      setLoading(false)
      setInfo(prev => ({ ...prev, lastError: 'No proxy URL available' }))
      return
    }
    const result = await window.api.singbox.startTun(tunUrl)
    if (!result.success) {
      setLoading(false)
      setInfo(prev => ({ ...prev, lastError: result.error || 'Failed to start' }))
      return
    }
    // Auto-test after start — wait a moment for TUN to be ready
    await new Promise(r => setTimeout(r, 1500))
    window.api.singbox.getInfo().then(setInfo)
    setTestResult({ status: 'testing' })
    const test = await window.api.singbox.testConnectivity()
    setLoading(false)
    if (test.success) {
      setTestResult({ status: 'ok', latency: test.latency })
      onTunStatusChange?.(true)
    } else {
      // TUN started but proxy is broken — keep TUN (block traffic), don't allow sessions
      setTestResult({ status: 'fail', error: test.error })
      onTunStatusChange?.(false)
    }
  }

  const handleStop = async () => {
    await window.api.singbox.stop()
    setTestResult({ status: 'idle' })
    onTunStatusChange?.(false)
    killAllPtySessions()
    window.api.singbox.getInfo().then(setInfo)
  }

  const handleTest = async () => {
    setTestResult({ status: 'testing' })
    const result = await window.api.singbox.testConnectivity()
    if (result.success) {
      setTestResult({ status: 'ok', latency: result.latency })
      onTunStatusChange?.(true)
    } else {
      // Proxy broken — keep TUN running (block traffic), kill PTY sessions
      killAllPtySessions()
      onTunStatusChange?.(false)
      setTestResult({ status: 'fail', error: result.error })
    }
  }

  const isRunning = info.status === 'running'
  const statusColor = isRunning ? 'var(--success)' : info.status === 'error' ? 'var(--error)' : 'var(--text-muted)'

  return (
    <SettingsGroup title="TUN">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>
          {isRunning ? t('settings.tunRunning') : t('settings.tunStopped')}
        </span>
        {isRunning && (
          <button onClick={handleTest} disabled={testResult.status === 'testing'} style={{
            padding: '5px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
            background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)',
            opacity: testResult.status === 'testing' ? 0.5 : 1,
          }}>
            {testResult.status === 'testing' ? t('settings.tunTesting') : t('settings.tunTest')}
          </button>
        )}
        {isRunning ? (
          <button onClick={handleStop} style={{
            padding: '5px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
            background: 'var(--error)', color: '#fff', border: 'none',
          }}>
            {t('settings.tunStop')}
          </button>
        ) : (
          <button onClick={handleStart} disabled={loading || !proxyUrl} style={{
            padding: '5px 14px', fontSize: 12, borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading || !proxyUrl ? 0.5 : 1,
            background: 'var(--accent)', color: '#fff', border: 'none',
          }}>
            {loading ? '...' : t('settings.tunStart')}
          </button>
        )}
      </div>
      {/* Test result */}
      {testResult.status === 'ok' && (
        <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 4 }}>
          ✓ {t('settings.tunTestOk')} ({testResult.latency}ms)
        </div>
      )}
      {testResult.status === 'fail' && (
        <div style={{ fontSize: 11, color: 'var(--error-text)', marginTop: 4 }}>
          ✗ {t('settings.tunTestFail')}{testResult.error ? ` — ${testResult.error}` : ''}
        </div>
      )}
      {info.lastError && (
        <div style={{ fontSize: 11, color: 'var(--error-text)', marginTop: 4 }}>{info.lastError}</div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{t('settings.tunHint')}</div>
    </SettingsGroup>
  )
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function FocusInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{ ...focusableInputStyle, ...props.style }}
      onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; props.onFocus?.(e) }}
      onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; props.onBlur?.(e) }}
    />
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
      <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 40, height: 22, borderRadius: 11, cursor: 'pointer',
          background: checked ? 'var(--accent)' : 'var(--bg-active)',
          position: 'relative', transition: 'background 0.2s',
        }}
      >
        <div style={{
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          position: 'absolute', top: 2,
          left: checked ? 20 : 2,
          transition: 'left 0.2s',
        }} />
      </div>
    </div>
  )
}
