import { create } from 'zustand'

export interface TerminalTab {
  id: string
  ptyId: string | null
  title: string
  cwd: string
  gitBranch?: string
  model?: string
  isRunning?: boolean
  isExited?: boolean
  mode?: 'suggest' | 'autoedit' | 'fullauto'
}

interface TerminalState {
  tabs: TerminalTab[]
  activeTabId: string | null
  addTab: (tab: TerminalTab) => void
  removeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTab: (id: string, updates: Partial<TerminalTab>) => void
  /** Find tab by ptyId */
  getTabByPtyId: (ptyId: string) => TerminalTab | undefined
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id
    })),

  removeTab: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id)
      const activeTabId =
        state.activeTabId === id
          ? tabs[tabs.length - 1]?.id ?? null
          : state.activeTabId
      return { tabs, activeTabId }
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTab: (id, updates) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t))
    })),

  getTabByPtyId: (ptyId) => get().tabs.find((t) => t.ptyId === ptyId)
}))
