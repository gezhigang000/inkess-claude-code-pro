import { create } from 'zustand'

const STORAGE_KEY = 'inkess-settings'

type ThemeChoice = 'auto' | 'dark' | 'light'
type LanguageChoice = 'auto' | 'zh' | 'en'
const VALID_THEMES: ThemeChoice[] = ['auto', 'dark', 'light']
const VALID_LANGUAGES: LanguageChoice[] = ['auto', 'zh', 'en']

interface SettingsState {
  fontSize: number
  ideChoice: string
  language: LanguageChoice
  theme: ThemeChoice
  notificationsEnabled: boolean
  notificationSound: boolean
  sleepInhibitorEnabled: boolean
  sidebarCollapsed: boolean
  pinnedProjects: string[]

  proxyEnabled: boolean
  proxyUrl: string
  proxyRegion: string  // region code: 'us', 'jp', 'sg', 'de', 'gb', 'kr', 'auto' (no override)

  setFontSize: (v: number) => void
  setIdeChoice: (v: string) => void
  setLanguage: (v: LanguageChoice) => void
  setTheme: (v: ThemeChoice) => void
  setNotificationsEnabled: (v: boolean) => void
  setNotificationSound: (v: boolean) => void
  setSleepInhibitorEnabled: (v: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  pinProject: (path: string) => void
  unpinProject: (path: string) => void
  setProxyEnabled: (v: boolean) => void
  setProxyUrl: (v: string) => void
  setProxyRegion: (v: string) => void
}

function loadSettings(): Partial<SettingsState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

function persistSettings(state: SettingsState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fontSize: state.fontSize,
      ideChoice: state.ideChoice,
      language: state.language,
      theme: state.theme,
      notificationsEnabled: state.notificationsEnabled,
      notificationSound: state.notificationSound,
      sleepInhibitorEnabled: state.sleepInhibitorEnabled,
      sidebarCollapsed: state.sidebarCollapsed,
      pinnedProjects: state.pinnedProjects,
      proxyEnabled: state.proxyEnabled,
      proxyUrl: state.proxyUrl,
      proxyRegion: state.proxyRegion,
    }))
  } catch { /* ignore */ }
}

function syncProxyToMain(state: SettingsState) {
  window.api?.proxy?.updateSettings({
    enabled: state.proxyEnabled,
    url: state.proxyUrl,
    region: state.proxyRegion,
  })
}

export function resolveTheme(theme: ThemeChoice): 'dark' | 'light' {
  if (theme === 'dark' || theme === 'light') return theme
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyTheme(theme: ThemeChoice) {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme))
}

const saved = loadSettings()

const validatedTheme: ThemeChoice = VALID_THEMES.includes((saved as any).theme) ? (saved as any).theme : 'auto'
const validatedLanguage: LanguageChoice = VALID_LANGUAGES.includes((saved as any).language) ? (saved as any).language : 'auto'
const validatedFontSize = typeof saved.fontSize === 'number' && saved.fontSize >= 10 && saved.fontSize <= 24 ? saved.fontSize : 14

export const useSettingsStore = create<SettingsState>((set, get) => ({
  fontSize: validatedFontSize,
  ideChoice: saved.ideChoice ?? 'vscode',
  language: validatedLanguage,
  theme: validatedTheme,
  notificationsEnabled: typeof (saved as any).notificationsEnabled === 'boolean' ? (saved as any).notificationsEnabled : true,
  notificationSound: typeof (saved as any).notificationSound === 'boolean' ? (saved as any).notificationSound : true,
  sleepInhibitorEnabled: typeof (saved as any).sleepInhibitorEnabled === 'boolean' ? (saved as any).sleepInhibitorEnabled : true,
  sidebarCollapsed: typeof (saved as any).sidebarCollapsed === 'boolean' ? (saved as any).sidebarCollapsed : false,
  pinnedProjects: Array.isArray((saved as any).pinnedProjects) ? (saved as any).pinnedProjects.filter((p: unknown) => typeof p === 'string').slice(0, 10) : [],

  proxyEnabled: typeof (saved as any).proxyEnabled === 'boolean' ? (saved as any).proxyEnabled : false,
  proxyUrl: typeof (saved as any).proxyUrl === 'string' ? (saved as any).proxyUrl
    : typeof (saved as any).proxyCustomUrl === 'string' ? (saved as any).proxyCustomUrl
    : '',
  proxyRegion: typeof (saved as any).proxyRegion === 'string' ? (saved as any).proxyRegion : 'us',

  setFontSize: (v) => { set({ fontSize: v }); persistSettings(get()) },
  setIdeChoice: (v) => { set({ ideChoice: v }); persistSettings(get()) },
  setLanguage: (v) => { set({ language: v }); persistSettings(get()) },
  setTheme: (v) => { set({ theme: v }); applyTheme(v); persistSettings(get()) },
  setNotificationsEnabled: (v) => { set({ notificationsEnabled: v }); persistSettings(get()) },
  setNotificationSound: (v) => { set({ notificationSound: v }); persistSettings(get()) },
  setSidebarCollapsed: (v) => { set({ sidebarCollapsed: v }); persistSettings(get()) },
  pinProject: (path) => {
    const { pinnedProjects } = get()
    if (pinnedProjects.includes(path) || pinnedProjects.length >= 10) return
    set({ pinnedProjects: [...pinnedProjects, path] })
    persistSettings(get())
  },
  unpinProject: (path) => {
    set({ pinnedProjects: get().pinnedProjects.filter(p => p !== path) })
    persistSettings(get())
  },
  setSleepInhibitorEnabled: (v) => {
    set({ sleepInhibitorEnabled: v })
    persistSettings(get())
    window.api?.power?.setSleepInhibitorEnabled(v)
  },
  setProxyEnabled: (v) => {
    set({ proxyEnabled: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
  setProxyUrl: (v) => {
    set({ proxyUrl: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
  setProxyRegion: (v) => {
    set({ proxyRegion: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
}))

applyTheme(validatedTheme)

// Sync initial proxy settings to main process
setTimeout(() => syncProxyToMain(useSettingsStore.getState()), 0)
