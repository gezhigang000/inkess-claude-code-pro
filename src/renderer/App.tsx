import { useCallback, useRef, useEffect, useState } from 'react'
import { useTerminalStore } from './stores/terminal'
import { useAppStore } from './stores/app'
import { useSettingsStore, applyTheme } from './stores/settings'
import { TerminalView } from './views/terminal/TerminalView'
import { Sidebar } from './views/sidebar/Sidebar'
import { SetupScreen, startInstall, startToolsInstall } from './views/setup/SetupScreen'
import { SettingsPanel } from './views/settings/SettingsPanel'
import { UpdateToast } from './views/update/UpdateToast'
import { StatusBar } from './views/statusbar/StatusBar'
import { CommandPalette } from './views/command-palette/CommandPalette'
import { HistoryView } from './views/history/HistoryView'
import { StatsView } from './views/stats/StatsView'
import { FilePreview } from './views/preview/FilePreview'
import { LoginPage } from './views/subscription/LoginPage'
import { TunGate } from './views/tun/TunGate'
import { useI18n } from './i18n'

const DEFAULT_CWD = window.api?.homedir || '/'
const isMac = window.api?.platform === 'darwin'

/** Shorten absolute path: replace home dir with ~, normalize separators */
export function shortenPath(p: string): string {
  const home = window.api?.homedir || ''
  if (home && p.startsWith(home)) {
    p = '~' + p.slice(home.length)
  }
  return p.replace(/\\/g, '/')
}

/** Get last segment of a path (works with both / and \) */
function pathBasename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || 'terminal'
}

const IDE_SCHEMES: Record<string, string> = {
  vscode: 'vscode://',
  cursor: 'cursor://',
  zed: 'zed://',
}

export function App() {
  const { tabs, activeTabId, addTab, removeTab, setActiveTab } = useTerminalStore()
  const { phase, setPhase, setCliInfo } = useAppStore()
  const proxyUrl = useSettingsStore(s => s.proxyUrl)
  const initRef = useRef(false)
  const [showSettings, setShowSettings] = useState(false)
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const pendingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string } | null>(null)
  const [appUpdateStatus, setAppUpdateStatus] = useState<{
    type: string; version?: string; percent?: number; message?: string
  } | null>(null)
  const [appUpdateDismissed, setAppUpdateDismissed] = useState(false)
  const { t } = useI18n()
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const [showHistory, setShowHistory] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [tunOk, setTunOk] = useState(false)
  const tunOkRef = useRef(false)
  const handleNewTabRef = useRef<(cwd?: string) => void>(() => {})
  useEffect(() => { tunOkRef.current = tunOk }, [tunOk])

  const [subscriptionLoggedIn, setSubscriptionLoggedIn] = useState<boolean | null>(null) // null = checking
  const [subscriptionUsername, setSubscriptionUsername] = useState<string | null>(null)
  const [subscriptionExpiry, setSubscriptionExpiry] = useState<string | null>(null)
  const [subscriptionPlan, setSubscriptionPlan] = useState<string>('monthly')
  const [expiryMinutesRemaining, setExpiryMinutesRemaining] = useState<number | null>(null)
  const expiryAtRef = useRef<string | null>(null)
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // TUN disconnect detection
  useEffect(() => {
    if (!tunOk || !subscriptionLoggedIn) return
    const interval = setInterval(async () => {
      const info = await window.api.singbox.getInfo()
      if (info.status !== 'running') {
        setTunOk(false)
        window.api.browser.closeAll()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [tunOk, subscriptionLoggedIn])

  // Startup: check subscription login, then CLI
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    checkSubscriptionAndProceed()
  }, [])

  const checkSubscriptionAndProceed = useCallback(async () => {
    const session = await window.api.subscription.getSession()
    if (session.isLoggedIn) {
      setSubscriptionLoggedIn(true)
      setSubscriptionUsername(session.username)
      setSubscriptionExpiry(session.session?.expiresAt || null)
      expiryAtRef.current = session.session?.expiresAt || null
      setSubscriptionPlan(session.session?.plan || 'monthly')
      if (session.session?.proxyUrl) {
        const store = useSettingsStore.getState()
        store.setProxyEnabled(true)
        store.setProxyMode('tun')
        store.setProxyUrl(session.session.proxyUrl)
        if (session.session.proxyRegion) store.setProxyRegion(session.session.proxyRegion)
      }
      startStatusPolling(session.session?.plan || 'monthly')
      // Check if TUN is already running and connected
      const singboxInfo = await window.api.singbox.getInfo()
      if (singboxInfo.status === 'running') {
        const test = await window.api.singbox.testConnectivity()
        if (test.success) {
          setTunOk(true)
          checkCliAndProceed()
          return
        }
      }
      // TUN not ready — TunGate will show (tunOk remains false)
    } else {
      setSubscriptionLoggedIn(false)
    }
  }, [])

  const handleSubscriptionLogin = useCallback(async (config: {
    claudeEmail: string; claudePassword: string; proxyUrl: string; proxyRegion: string; expiresAt: string; status: string; plan?: string
  }) => {
    setSubscriptionLoggedIn(true)
    setSubscriptionExpiry(config.expiresAt)
    expiryAtRef.current = config.expiresAt
    setSubscriptionPlan(config.plan || 'monthly')

    // 1. Auto-configure proxy
    const store = useSettingsStore.getState()
    store.setProxyEnabled(true)
    store.setProxyMode('tun')
    store.setProxyUrl(config.proxyUrl)
    store.setProxyRegion(config.proxyRegion)

    // 2. Send Claude credentials to main process for browser auto-fill
    if (config.claudeEmail && config.claudePassword) {
      window.api.claude.setCredentials(config.claudeEmail, config.claudePassword)
    }

    // 3. Start status polling
    startStatusPolling(config.plan || 'monthly')

    // 4. Get username
    const session = await window.api.subscription.getSession()
    setSubscriptionUsername(session.username)

    // TunGate will show automatically (tunOk is false)
    // TunGate.onReady → setTunOk(true) + checkCliAndProceed()
  }, [])

  const forceExpiredLogout = useCallback(() => {
    // Kill all active PTY sessions
    const store = useTerminalStore.getState()
    store.tabs.forEach(tab => {
      if (tab.ptyId && !tab.isExited) {
        window.api.pty.kill(tab.ptyId)
      }
    })
    // Clear polling
    if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    // Clear Claude credentials and logout
    window.api.claude.clearCredentials()
    window.api.subscription.logout()
    setSubscriptionLoggedIn(false)
    setSubscriptionExpiry(null)
    expiryAtRef.current = null
    setExpiryMinutesRemaining(null)
  }, [])

  /** Compute minutes remaining from expiresAt string */
  const calcMinutesRemaining = (expiresAt: string): number => {
    return Math.max(0, (new Date(expiresAt).getTime() - Date.now()) / 60000)
  }

  const startStatusPolling = useCallback((plan: string) => {
    if (statusPollRef.current) return

    const isDaily = plan === 'daily'
    const pollInterval = isDaily ? 60000 : 3600000

    const poll = async () => {
      const status = await window.api.subscription.checkStatus()
      if (!status) {
        // null = token expired (401, already logged out by manager) OR network error.
        // Only force logout if manager already cleared session (401 case).
        const session = await window.api.subscription.getSession()
        if (!session.isLoggedIn) {
          setSubscriptionLoggedIn(false)
        }
        // Network error: do nothing, let local countdown continue but don't force logout
        return
      }

      setSubscriptionExpiry(status.expiresAt)
      expiryAtRef.current = status.expiresAt
      if (status.plan) setSubscriptionPlan(status.plan)

      if (status.status === 'expired' || status.status === 'suspended') {
        forceExpiredLogout()
        return
      }

      // Update remaining from server (authoritative, replaces local estimate)
      setExpiryMinutesRemaining(calcMinutesRemaining(status.expiresAt))

      // Update proxy if server pushed new address
      if (status.proxyUrl) {
        const store = useSettingsStore.getState()
        store.setProxyUrl(status.proxyUrl)
        if (status.proxyRegion) store.setProxyRegion(status.proxyRegion)
      }
    }

    // Seed countdown immediately from stored expiresAt (before first poll)
    if (isDaily) {
      const session = window.api.subscription.getSession()
      session.then(s => {
        if (s.session?.expiresAt) {
          setExpiryMinutesRemaining(calcMinutesRemaining(s.session.expiresAt))
        }
      })
    }

    // Initial poll (will correct the seed value with server truth)
    poll()
    statusPollRef.current = setInterval(poll, pollInterval)

    // Local countdown — ticks every 30s, uses expiresAt-based calculation
    if (isDaily) {
      countdownRef.current = setInterval(async () => {
        setExpiryMinutesRemaining(prev => {
          if (prev === null) return null
          const next = prev - 0.5
          return next <= 0 ? 0 : next
        })
        // Check expiry using ref (avoids stale state read)
        const expiresAt = expiryAtRef.current
        if (!expiresAt) return
        const msRemaining = new Date(expiresAt).getTime() - Date.now()
        if (msRemaining <= 0) {
          const status = await window.api.subscription.checkStatus()
          if (status && (status.status === 'expired' || status.status === 'suspended')) {
            forceExpiredLogout()
          } else if (status) {
            setExpiryMinutesRemaining(calcMinutesRemaining(status.expiresAt))
            expiryAtRef.current = status.expiresAt
          } else {
            setExpiryMinutesRemaining(5)
          }
        }
      }, 30000)
    }
  }, [forceExpiredLogout])

  const checkCliAndProceed = useCallback(async () => {
    const info = await window.api.cli.getInfo()
    setCliInfo(info.installed, info.version)

    if (!info.installed) {
      await startInstall()
      const newInfo = await window.api.cli.getInfo()
      if (!newInfo.installed) return
    } else {
      const toolsInstalled = await window.api.tools.isAllInstalled()
      if (!toolsInstalled) {
        await startToolsInstall()
      }
    }

    setPhase('ready')
  }, [setCliInfo, setPhase])

  const handleNewTab = useCallback(async (cwd?: string) => {
    // Block new sessions if TUN is not connected
    if (!tunOkRef.current) return

    const targetCwd = cwd || (tabs.length > 0 ? tabs[tabs.length - 1].cwd : DEFAULT_CWD)
    const { cliInstalled } = useAppStore.getState()

    const result = await window.api.pty.create({
      cwd: targetCwd,
      launchClaude: cliInstalled,
    })

    if (result.error || !result.id) return

    const id = crypto.randomUUID()
    const title = pathBasename(targetCwd)
    addTab({ id, ptyId: result.id, title, cwd: targetCwd })

    // Persist to recent projects
    saveRecentProject(targetCwd)
  }, [tabs, addTab])

  useEffect(() => { handleNewTabRef.current = handleNewTab }, [handleNewTab])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab?.isExited || tabs.length <= 1) {
        if (tab?.ptyId) window.api.pty.kill(tab.ptyId)
        removeTab(tabId)
        setPendingCloseTabId(null)
        return
      }
      if (pendingCloseTabId === tabId) {
        if (tab?.ptyId) window.api.pty.kill(tab.ptyId)
        removeTab(tabId)
        setPendingCloseTabId(null)
        if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current)
        return
      }
      setPendingCloseTabId(tabId)
      if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current)
      pendingCloseTimerRef.current = setTimeout(() => setPendingCloseTabId(null), 3000)
    },
    [tabs, removeTab, pendingCloseTabId]
  )

  const handleSelectDirectory = useCallback(async () => {
    const dir = await window.api.shell.selectDirectory()
    if (dir) handleNewTab(dir)
  }, [handleNewTab])

  useEffect(() => {
    return () => {
      if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current)
      if (statusPollRef.current) clearInterval(statusPollRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  // Menu keyboard shortcuts
  useEffect(() => {
    const unsubs = [
      window.api.menu.onNewTab(() => handleSelectDirectory()),
      window.api.menu.onCloseTab(() => {
        if (activeTabId) handleCloseTab(activeTabId)
      }),
      window.api.menu.onSwitchTab((index) => {
        if (tabs[index]) setActiveTab(tabs[index].id)
      }),
      window.api.menu.onOpenFolder((path) => handleNewTab(path))
    ]
    return () => unsubs.forEach(fn => { try { fn?.() } catch { /* ignore */ } })
  }, [handleSelectDirectory, handleCloseTab, activeTabId, tabs, setActiveTab])

  // Mark tabs as exited when PTY exits
  useEffect(() => {
    const unsub = window.api.pty.onExit((event) => {
      const { updateTab } = useTerminalStore.getState()
      const tab = useTerminalStore.getState().tabs.find(t => t.ptyId === event.id)
      if (tab) updateTab(tab.id, { isExited: true })
    })
    return () => { unsub() }
  }, [])

  // Check CLI update once on startup
  useEffect(() => {
    if (phase !== 'ready') return
    const check = async () => {
      const info = await window.api.cli.getInfo()
      if (!info.version) return
      const result = await window.api.cli.checkUpdate()
      if (result.available && result.latestVersion) {
        setUpdateInfo({ current: info.version, latest: result.latestVersion })
      }
    }
    check()
  }, [phase])

  // App auto-update status listener
  useEffect(() => {
    const unsub = window.api.appUpdate.onStatus((status) => {
      setAppUpdateStatus(status)
      // Auto-show toast when status changes to actionable states
      if (status.type === 'available' || status.type === 'downloaded' || status.type === 'downloading' || status.type === 'error') {
        setAppUpdateDismissed(false)
      }
    })
    // Periodic re-check every 2 hours
    const recheckTimer = setInterval(() => {
      window.api.appUpdate.check()
    }, 2 * 60 * 60 * 1000)
    return () => { unsub(); clearInterval(recheckTimer) }
  }, [])

  // Desktop notifications
  useEffect(() => {
    const unsub = window.api.notification.onShouldShow(() => {
      const settings = useSettingsStore.getState()
      if (!settings.notificationsEnabled) return
      window.api.notification.show('Task Complete', 'Claude Code has finished the task.')
    })
    return () => { unsub() }
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowCommandPalette(prev => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        const { sidebarCollapsed, setSidebarCollapsed } = useSettingsStore.getState()
        setSidebarCollapsed(!sidebarCollapsed)
      }
      // Cmd+Shift+H: open session history
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        setShowHistory(prev => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setShowStats(prev => !prev)
      }
      // Cmd+Shift+1~5: open pinned project
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key >= '1' && e.key <= '5') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        const { pinnedProjects } = useSettingsStore.getState()
        if (pinnedProjects[idx]) {
          const dir = pinnedProjects[idx]
          const store = useTerminalStore.getState()
          const existing = store.tabs.find(t => t.cwd === dir)
          if (existing) {
            store.setActiveTab(existing.id)
          } else {
            handleNewTabRef.current(dir)
          }
        }
      }
      if (e.shiftKey && e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        const active = document.activeElement
        if (active?.closest('.xterm') || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return
        e.preventDefault()
        const store = useTerminalStore.getState()
        const tab = store.tabs.find(t => t.id === store.activeTabId)
        if (!tab?.ptyId || tab.isRunning) return
        const modes = ['suggest', 'autoedit', 'fullauto'] as const
        const cmds: Record<string, string> = { suggest: '/permissions suggest\n', autoedit: '/permissions auto-edit\n', fullauto: '/permissions full-auto\n' }
        const idx = modes.indexOf((tab.mode || 'suggest') as any)
        const next = modes[(idx + 1) % modes.length]
        window.api.pty.write(tab.ptyId, cmds[next])
        store.updateTab(tab.id, { mode: next })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => applyTheme(useSettingsStore.getState().theme)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // --- Drag & Drop ---
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    for (const file of files) {
      const filePath = (file as any).path as string
      if (!filePath) continue

      const isDir = await window.api.fs.isDirectory(filePath)
      if (isDir) {
        // Directory → new tab
        handleNewTab(filePath)
      } else {
        // File → insert path into active PTY
        const store = useTerminalStore.getState()
        const activeTab = store.tabs.find(t => t.id === store.activeTabId)
        if (activeTab?.ptyId) {
          const escaped = filePath.includes(' ') ? `"${filePath}"` : filePath
          window.api.pty.write(activeTab.ptyId, escaped)
        }
      }
    }
  }, [handleNewTab])

  const handleCliUpdate = useCallback(async () => {
    const result = await window.api.cli.update()
    if (result.success) {
      const info = await window.api.cli.getInfo()
      setCliInfo(info.installed, info.version)
      setUpdateInfo(null)
    }
  }, [setCliInfo])

  const plainTitleBar = (
    <div
      className="titlebar-drag"
      style={{
        height: 38, background: 'var(--bg-secondary)', display: 'flex',
        alignItems: 'center', padding: '0 16px',
        borderBottom: '1px solid var(--border)', flexShrink: 0
      }}
    >
      {isMac && <div style={{ width: 70 }} />}
      <div style={{ flex: 1, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
        {t('app.title')}
      </div>
      {isMac && <div style={{ width: 70 }} />}
    </div>
  )

  // Show login page if not logged in
  if (subscriptionLoggedIn === false) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {plainTitleBar}
        <LoginPage onLoginSuccess={handleSubscriptionLogin} />
      </div>
    )
  }

  // Still checking subscription or loading
  if (subscriptionLoggedIn === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {plainTitleBar}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' }}>
          <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.75s linear infinite' }} />
        </div>
      </div>
    )
  }

  if (phase === 'checking' || phase === 'installing' || phase === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {plainTitleBar}
        <SetupScreen />
      </div>
    )
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(139, 115, 85, 0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
          animation: 'fadeIn 0.15s ease-out',
        }}>
          <div style={{
            padding: '32px 48px', borderRadius: 16,
            border: '2px dashed var(--accent)',
            background: 'var(--bg-secondary)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              <line x1="12" y1="11" x2="12" y2="17" /><polyline points="9 14 12 11 15 14" />
            </svg>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('drag.dropToOpen')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('drag.hint')}
            </div>
          </div>
        </div>
      )}
      <TitleTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        pendingCloseTabId={pendingCloseTabId}
        onSelect={setActiveTab}
        onClose={handleCloseTab}
        onNew={handleSelectDirectory}
        onCommandPalette={() => setShowCommandPalette(true)}
        onSettings={() => { setShowSettings(true); window.api.analytics?.track('settings_open') }}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          onSettings={() => { setShowSettings(true); window.api.analytics?.track('settings_open') }}
          onNewSession={handleSelectDirectory}
          onCommandPalette={() => setShowCommandPalette(true)}
          onStats={() => setShowStats(true)}
          onOpenProject={(cwd) => {
            const existing = tabs.find(t => t.cwd === cwd)
            if (existing) {
              setActiveTab(existing.id)
            } else {
              handleNewTab(cwd)
            }
          }}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {showHistory ? (
            <HistoryView
              onClose={() => setShowHistory(false)}
              onOpenProject={(cwd) => { setShowHistory(false); handleNewTab(cwd) }}
            />
          ) : tabs.length === 0 ? (
            <WelcomeScreen onOpenFolder={handleSelectDirectory} onOpenProject={handleNewTab} />
          ) : (
            <>
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex' }}>
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--terminal-bg, var(--bg-primary))' }}>
                  {tabs.map((tab) => (
                    <TerminalView
                      key={tab.id}
                      ptyId={tab.ptyId}
                      isActive={tab.id === activeTabId}
                      cwd={tab.cwd}
                      onFileClick={(path) => setPreviewFile(path)}
                    />
                  ))}
                </div>
                {previewFile && (
                  <FilePreview
                    filePath={previewFile}
                    cwd={tabs.find(t => t.id === activeTabId)?.cwd || DEFAULT_CWD}
                    onClose={() => setPreviewFile(null)}
                  />
                )}
              </div>
              <StatusBar expiryMinutesRemaining={expiryMinutesRemaining} subscriptionPlan={subscriptionPlan} />
            </>
          )}
        </div>
      </div>
      {showStats && <StatsView onClose={() => setShowStats(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} onLogout={() => { setShowSettings(false); forceExpiredLogout() }} onTunStatusChange={setTunOk} />}
      {/* TUN Gate — mandatory network overlay */}
      {subscriptionLoggedIn && !tunOk && (
        <TunGate
          proxyUrl={proxyUrl}
          onReady={() => {
            setTunOk(true)
            if (phase !== 'ready') checkCliAndProceed()
          }}
        />
      )}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          onNewTab={handleSelectDirectory}
          onSettings={() => { setShowCommandPalette(false); setShowSettings(true) }}
          onToggleTheme={() => {
            const { theme, setTheme } = useSettingsStore.getState()
            setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark')
          }}
        />
      )}
      {updateInfo && (
        <div style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 200 }}>
          <UpdateToast
            currentVersion={updateInfo.current}
            latestVersion={updateInfo.latest}
            onUpdate={handleCliUpdate}
            onDismiss={() => setUpdateInfo(null)}
          />
        </div>
      )}
      {appUpdateStatus && !appUpdateDismissed && (appUpdateStatus.type === 'available' || appUpdateStatus.type === 'downloading' || appUpdateStatus.type === 'downloaded' || appUpdateStatus.type === 'error') && (
        <AppUpdateToast
          status={appUpdateStatus}
          bottomOffset={updateInfo ? 100 : 16}
          onDownload={() => window.api.appUpdate.download()}
          onInstall={() => window.api.appUpdate.install()}
          onDismiss={() => setAppUpdateDismissed(true)}
        />
      )}
    </div>
  )
}

// --- Recent projects persistence ---

const RECENT_PROJECTS_KEY = 'inkess-recent-projects'
const MAX_RECENT = 10

function saveRecentProject(cwd: string) {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    const list: string[] = raw ? JSON.parse(raw) : []
    const filtered = list.filter(p => p !== cwd)
    filtered.unshift(cwd)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT)))
  } catch { /* ignore */ }
}

export function getRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

// --- Sub-components ---

import type { TerminalTab } from './stores/terminal'

function TitleTabBar({ tabs, activeTabId, onSelect, onClose, onNew, pendingCloseTabId, onCommandPalette, onSettings }: {
  tabs: TerminalTab[]; activeTabId: string | null; pendingCloseTabId: string | null
  onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void
  onCommandPalette?: () => void; onSettings?: () => void
}) {
  const [hoveredTab, setHoveredTab] = useState<string | null>(null)
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const { t } = useI18n()

  return (
    <div
      className="titlebar-drag"
      style={{
        height: 38, background: 'var(--bg-secondary)', display: 'flex',
        alignItems: 'stretch', borderBottom: '1px solid var(--border)', flexShrink: 0,
        padding: '0 8px'
      }}
    >
      {isMac && <div style={{ width: 70 }} />}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        const isHovered = tab.id === hoveredTab
        const isPendingClose = tab.id === pendingCloseTabId
        return (
          <div
            key={tab.id}
            className="titlebar-no-drag"
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
            }}
            onMouseEnter={() => setHoveredTab(tab.id)}
            onMouseLeave={() => setHoveredTab(null)}
            title={shortenPath(tab.cwd)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', fontSize: 12,
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer',
              background: isActive ? 'var(--bg-hover)' : 'transparent',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              transition: 'background 0.12s',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            {tab.title}
            {tabs.length > 1 && (
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <span
                  onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
                  style={{
                    width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 4, fontSize: 14, marginLeft: 2,
                    opacity: (isHovered || isActive || isPendingClose) ? 0.7 : 0,
                    background: isPendingClose ? 'var(--error)' : 'transparent',
                    color: isPendingClose ? '#fff' : 'var(--text-muted)',
                    transition: 'opacity 0.15s, background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (!isPendingClose) { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'var(--bg-active)' } }}
                  onMouseLeave={(e) => { if (!isPendingClose) { e.currentTarget.style.opacity = (isHovered || isActive) ? '0.7' : '0'; e.currentTarget.style.background = 'transparent' } }}
                >×</span>
                {isPendingClose && (
                  <span style={{
                    position: 'absolute', top: -28, left: '50%', transform: 'translateX(-50%)',
                    background: 'var(--bg-active)', color: 'var(--text-primary)',
                    padding: '2px 8px', borderRadius: 4, fontSize: 11, whiteSpace: 'nowrap',
                    animation: 'slideUp 0.15s ease-out',
                  }}>
                    {t('tab.pressAgainToClose')}
                  </span>
                )}
              </span>
            )}
          </div>
        )
      })}
      <div
        className="titlebar-no-drag"
        onClick={onNew}
        onMouseEnter={() => setHoveredBtn('new')}
        onMouseLeave={() => setHoveredBtn(null)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, alignSelf: 'center',
          color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16,
          borderRadius: 6,
          background: hoveredBtn === 'new' ? 'var(--bg-hover)' : 'transparent',
          transition: 'background 0.12s',
        }}
      >+</div>
      <div style={{ flex: 1 }} />
      <div className="titlebar-no-drag" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <div
          onClick={onCommandPalette}
          onMouseEnter={() => setHoveredBtn('cmd')}
          onMouseLeave={() => setHoveredBtn(null)}
          title="Commands (⌘K)"
          style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)',
            background: hoveredBtn === 'cmd' ? 'var(--bg-hover)' : 'transparent',
            transition: 'background 0.12s',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <div
          onClick={onSettings}
          onMouseEnter={() => setHoveredBtn('settings')}
          onMouseLeave={() => setHoveredBtn(null)}
          title="Settings"
          style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)',
            background: hoveredBtn === 'settings' ? 'var(--bg-hover)' : 'transparent',
            transition: 'background 0.12s',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </div>
        {!isMac && <>
          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
          {[
            { id: 'min', title: 'Minimize', action: () => window.api.window.minimize(), icon: <rect x="3" y="11" width="18" height="2" rx="1" /> },
            { id: 'max', title: 'Maximize', action: () => window.api.window.maximize(), icon: <rect x="3" y="3" width="18" height="18" rx="2" /> },
            { id: 'close', title: 'Close', action: () => window.api.window.close(), icon: <><line x1="4" y1="4" x2="20" y2="20" /><line x1="20" y1="4" x2="4" y2="20" /></> },
          ].map(({ id, title, action, icon }) => (
            <div
              key={id}
              onClick={action}
              onMouseEnter={() => setHoveredBtn(id)}
              onMouseLeave={() => setHoveredBtn(null)}
              title={title}
              style={{
                width: 40, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: id === 'close' && hoveredBtn === 'close' ? '#fff' : 'var(--text-muted)',
                background: hoveredBtn === id ? (id === 'close' ? '#e81123' : 'var(--bg-hover)') : 'transparent',
                transition: 'background 0.12s, color 0.12s',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill={id === 'max' ? 'none' : 'none'} stroke="currentColor" strokeWidth="2">
                {icon}
              </svg>
            </div>
          ))}
        </>}
      </div>
      {contextMenu && (
        <TabContextMenu
          tab={tabs.find(t => t.id === contextMenu.tabId)!}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => { onClose(contextMenu.tabId); setContextMenu(null) }}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

function TabContextMenu({ tab, x, y, onClose, onDismiss }: {
  tab: TerminalTab; x: number; y: number
  onClose: () => void; onDismiss: () => void
}) {
  const { t } = useI18n()
  const ideChoice = useSettingsStore((s) => s.ideChoice)
  const [hoveredItem, setHoveredItem] = useState<string | null>(null)

  const ideScheme = IDE_SCHEMES[ideChoice] || 'vscode://'
  const ideName = ideChoice === 'vscode' ? 'VS Code' : ideChoice === 'cursor' ? 'Cursor' : 'Zed'

  useEffect(() => {
    const handler = () => onDismiss()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [onDismiss])

  const menuItems: { key: string; label: string; onClick: () => void; separator?: boolean }[] = [
    {
      key: 'finder',
      label: isMac ? t('tab.openInFinder') : t('tab.openInExplorer'),
      onClick: () => { window.api.shell.openPath(tab.cwd); onDismiss() }
    },
    {
      key: 'ide',
      label: t('tab.openInIde', { ide: ideName }),
      onClick: () => { window.api.shell.openExternal(`${ideScheme}file/${tab.cwd}`); onDismiss() }
    },
    {
      key: 'copy',
      label: t('tab.copyPath'),
      onClick: () => { window.api.clipboard.writeText(tab.cwd); onDismiss() }
    },
    {
      key: 'close',
      label: t('tab.closeTab'),
      separator: true,
      onClick: onClose
    }
  ]

  return (
    <div
      style={{
        position: 'fixed', left: x, top: y, zIndex: 9999,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '4px 0', minWidth: 180,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)', fontSize: 13
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {menuItems.map((item) => (
        <div key={item.key}>
          {item.separator && (
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 8px' }} />
          )}
          <div
            onClick={item.onClick}
            onMouseEnter={() => setHoveredItem(item.key)}
            onMouseLeave={() => setHoveredItem(null)}
            style={{
              padding: '6px 16px', cursor: 'pointer',
              color: 'var(--text-primary)',
              background: hoveredItem === item.key ? 'var(--bg-hover)' : 'transparent',
              transition: 'background 0.1s'
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function WelcomeScreen({ onOpenFolder, onOpenProject }: { onOpenFolder: () => void; onOpenProject: (cwd: string) => void }) {
  const { t } = useI18n()
  const [hovered, setHovered] = useState<string | null>(null)
  const recentDirs = getRecentProjects()

  const cards = [
    ...(recentDirs.length > 0
      ? [{
          key: 'recent',
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          ),
          title: t('welcome.cardRecent'),
          desc: t('welcome.cardRecentDesc'),
          onClick: () => onOpenProject(recentDirs[0]),
        }]
      : []),
    {
      key: 'open',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      ),
      title: t('welcome.cardNew'),
      desc: t('welcome.cardNewDesc'),
      onClick: onOpenFolder,
    },
  ]

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 16, padding: 32
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16, background: 'var(--accent-subtle)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4
      }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('welcome.letsBuild')}
        </div>
        <div
          onClick={onOpenFolder}
          onMouseEnter={() => setHovered('title')}
          onMouseLeave={() => setHovered(null)}
          style={{
            fontSize: 15, color: 'var(--text-muted)', cursor: 'pointer',
            opacity: hovered === 'title' ? 0.8 : 1, transition: 'opacity 0.15s',
          }}
        >
          {t('welcome.openProject')} <span style={{ fontSize: 12 }}>▾</span>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 12, marginTop: 24, marginBottom: 16, flexWrap: 'wrap', justifyContent: 'center'
      }}>
        {cards.map((card) => (
          <div
            key={card.key}
            onClick={card.onClick}
            onMouseEnter={() => setHovered(card.key)}
            onMouseLeave={() => setHovered(null)}
            style={{
              width: 200, padding: '16px 16px 14px', borderRadius: 10,
              border: '1px solid var(--border)', cursor: 'pointer',
              background: hovered === card.key ? 'var(--bg-hover)' : 'transparent',
              transform: hovered === card.key ? 'translateY(-2px)' : 'none',
              boxShadow: hovered === card.key ? '0 4px 12px rgba(0,0,0,0.15)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{ marginBottom: 10 }}>{card.icon}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 3 }}>{card.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{card.desc}</div>
          </div>
        ))}
      </div>

      {recentDirs.length > 0 && (
        <div style={{ width: '100%', maxWidth: 420, marginTop: 8 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8
          }}>
            {t('welcome.recentProjects')}
          </div>
          {recentDirs.map((dir) => (
            <div
              key={dir}
              onClick={() => onOpenProject(dir)}
              onMouseEnter={() => setHovered(dir)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: 8,
                borderRadius: 6, cursor: 'pointer', fontSize: 13,
                color: hovered === dir ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: hovered === dir ? 'var(--bg-hover)' : 'transparent',
                transition: 'background 0.12s, color 0.12s',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {shortenPath(dir)}
              </span>
            </div>
          ))}
        </div>
      )}

      {recentDirs.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {t('welcome.noRecent')}
        </div>
      )}

      {/* Keyboard shortcut hints */}
      <div style={{
        display: 'flex', gap: 16, marginTop: 24, fontSize: 11, color: 'var(--text-muted)',
      }}>
        <span><kbd style={kbdStyle}>⌘K</kbd> {t('welcome.hintCommands')}</span>
        <span><kbd style={kbdStyle}>⇧Tab</kbd> {t('welcome.hintMode')}</span>
        <span><kbd style={kbdStyle}>⌘F</kbd> {t('welcome.hintSearch')}</span>
      </div>
    </div>
  )
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-block', padding: '1px 5px', borderRadius: 3,
  border: '1px solid var(--border)', background: 'var(--bg-tertiary)',
  fontFamily: 'inherit', fontSize: 10, lineHeight: '16px',
}

function AppUpdateToast({ status, bottomOffset, onDownload, onInstall, onDismiss }: {
  status: { type: string; version?: string; percent?: number; message?: string }
  bottomOffset?: number
  onDownload?: () => void; onInstall?: () => void; onDismiss: () => void
}) {
  const { t } = useI18n()
  const version = status.version || ''
  const btnStyle: React.CSSProperties = {
    padding: '4px 12px', borderRadius: 4, border: 'none',
    background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  }
  return (
    <div style={{
      position: 'fixed', bottom: bottomOffset ?? 16, right: 16, background: 'var(--bg-secondary)',
      border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px',
      display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-primary)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)', zIndex: 1000, minWidth: 260, maxWidth: 340,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>
          {status.type === 'available' && t('appUpdate.available', { version })}
          {status.type === 'downloading' && t('appUpdate.downloading', { percent: String(Math.round(status.percent ?? 0)) })}
          {status.type === 'downloaded' && t('appUpdate.ready', { version })}
          {status.type === 'error' && t('appUpdate.error', { message: status.message || 'Unknown' })}
        </span>
        {status.type === 'available' && <button onClick={onDownload} style={btnStyle}>{t('appUpdate.download')}</button>}
        {status.type === 'downloaded' && <button onClick={onInstall} style={btnStyle}>{t('appUpdate.restartUpdate')}</button>}
        {status.type === 'error' && <button onClick={onDownload} style={btnStyle}>{t('appUpdate.retry')}</button>}
        <span onClick={onDismiss} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 16, lineHeight: 1 }}>×</span>
      </div>
      {status.type === 'downloading' && (
        <div style={{ height: 3, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2, background: 'var(--accent)',
            width: `${Math.min(status.percent ?? 0, 100)}%`, transition: 'width 0.3s ease',
          }} />
        </div>
      )}
    </div>
  )
}
