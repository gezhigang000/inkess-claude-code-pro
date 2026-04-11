import { create } from 'zustand'

/**
 * Runtime tunnel status + manual-action flags for the StatusBar network
 * indicator. Updated from two sources:
 *   1. tun:statusUpdate push events (sing-box → main → preload → here).
 *      Fire on startTun, stop, and every connectivity test.
 *   2. User actions dispatched from NetworkPopover (test / reconnect).
 */
interface NetworkState {
  // Backend-pushed state
  tunRunning: boolean
  latencyMs: number | null
  actualIp: string | null
  expectedIp: string | null
  lastError: string | null
  lastTestAt: number | null

  // UI-only flags
  testing: boolean
  reconnecting: boolean

  // Reducers (wired from the App.tsx status subscription)
  applyStatusUpdate: (update: {
    tunRunning: boolean
    latencyMs: number | null
    actualIp: string | null
    expectedIp: string | null
    error: string | null
    lastTestAt: number
  }) => void

  setTesting: (v: boolean) => void
  setReconnecting: (v: boolean) => void
}

export const useNetworkStore = create<NetworkState>((set) => ({
  tunRunning: false,
  latencyMs: null,
  actualIp: null,
  expectedIp: null,
  lastError: null,
  lastTestAt: null,
  testing: false,
  reconnecting: false,

  applyStatusUpdate: (update) =>
    set({
      tunRunning: update.tunRunning,
      latencyMs: update.latencyMs,
      actualIp: update.actualIp,
      expectedIp: update.expectedIp,
      lastError: update.error,
      lastTestAt: update.lastTestAt,
    }),

  setTesting: (v) => set({ testing: v }),
  setReconnecting: (v) => set({ reconnecting: v }),
}))
