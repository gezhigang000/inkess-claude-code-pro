import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub localStorage since vitest env is 'node'
class MemoryStorage {
  private store = new Map<string, string>()
  getItem(k: string) { return this.store.get(k) ?? null }
  setItem(k: string, v: string) { this.store.set(k, v) }
  removeItem(k: string) { this.store.delete(k) }
  clear() { this.store.clear() }
}

describe('settings store appMode', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as any).localStorage = new MemoryStorage()
    ;(globalThis as any).window = {
      api: {},
      matchMedia: () => ({ matches: false }),
    }
    ;(globalThis as any).document = {
      documentElement: { setAttribute: () => {} },
    }
  })

  it('defaults to "cli" when no saved state', async () => {
    const { useSettingsStore } = await import('../../src/renderer/stores/settings')
    expect(useSettingsStore.getState().appMode).toBe('cli')
  })

  it('defaults to "cli" for legacy users without appMode in saved state', async () => {
    ;(globalThis as any).localStorage.setItem(
      'inkess-settings',
      JSON.stringify({ fontSize: 14, theme: 'dark' }),
    )
    const { useSettingsStore } = await import('../../src/renderer/stores/settings')
    expect(useSettingsStore.getState().appMode).toBe('cli')
  })

  it('setAppMode updates state and persists', async () => {
    const { useSettingsStore } = await import('../../src/renderer/stores/settings')
    useSettingsStore.getState().setAppMode('chat')
    expect(useSettingsStore.getState().appMode).toBe('chat')

    const raw = (globalThis as any).localStorage.getItem('inkess-settings')
    const parsed = JSON.parse(raw!)
    expect(parsed.appMode).toBe('chat')
  })

  it('rejects invalid values (fallback to "cli")', async () => {
    ;(globalThis as any).localStorage.setItem(
      'inkess-settings',
      JSON.stringify({ appMode: 'garbage' }),
    )
    const { useSettingsStore } = await import('../../src/renderer/stores/settings')
    expect(useSettingsStore.getState().appMode).toBe('cli')
  })
})
