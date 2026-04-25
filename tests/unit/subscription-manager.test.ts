import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-userdata',
    getVersion: () => '1.2.2',
  },
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

vi.mock('@main/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('@main/subscription/device-id', () => ({
  getDeviceId: vi.fn(() => 'device-123'),
}))

vi.mock('@main/utils/crypto', () => ({
  encrypt: vi.fn((value: string) => value),
  decrypt: vi.fn((value: string) => value),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { SubscriptionManager } from '@main/subscription/subscription-manager'

describe('SubscriptionManager API URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('posts login requests to the default Inkess AI subscription host', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'token-123',
        config: {
          claudeEmail: 'user@example.com',
          claudePassword: 'secret',
          proxyUrl: 'socks5://proxy.example.com:1080',
          proxyRegion: 'us',
          exitIp: '1.2.3.4',
          expiresAt: '2026-05-01T00:00:00Z',
          status: 'active',
          plan: 'monthly',
        },
      }),
    })

    const manager = new SubscriptionManager()
    await manager.login('alice', 'password')

    expect(mockFetch.mock.calls[0][0]).toBe('https://llm.inkessai.com/api/subscription/login')
  })

  it('checks status through the default Inkess AI subscription host', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'token-123',
          config: {
            claudeEmail: 'user@example.com',
            claudePassword: 'secret',
            proxyUrl: 'socks5://proxy.example.com:1080',
            proxyRegion: 'us',
            exitIp: '1.2.3.4',
            expiresAt: '2026-05-01T00:00:00Z',
            status: 'active',
            plan: 'monthly',
          },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          status: 'active',
          expiresAt: '2026-05-01T00:00:00Z',
          daysRemaining: 5,
        }),
      })

    const manager = new SubscriptionManager()
    await manager.login('alice', 'password')
    await manager.checkStatus()

    expect(mockFetch.mock.calls[1][0]).toBe('https://llm.inkessai.com/api/subscription/status')
  })
})
