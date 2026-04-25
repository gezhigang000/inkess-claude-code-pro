import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => ({
      cookies: {
        get: vi.fn(async () => []),
        set: vi.fn(async () => {}),
      },
    })),
  },
  BrowserWindow: vi.fn(),
}))

vi.mock('@main/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { BrowserSync } from '@main/subscription/browser-sync'

describe('BrowserSync API URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('downloads browser data from the default Inkess AI subscription host', async () => {
    mockFetch.mockResolvedValueOnce({ status: 204, ok: true })

    const browserSync = new BrowserSync()
    await browserSync.downloadAndImportCookies('alice', 'token-123')

    expect(mockFetch.mock.calls[0][0]).toBe('https://llm.inkessai.com/api/subscription/browser-data')
  })

  it('uploads browser data to the default Inkess AI subscription host', async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 204, ok: true })
      .mockResolvedValueOnce({ status: 200, ok: true })

    const browserSync = new BrowserSync()
    await browserSync.downloadAndImportCookies('alice', 'token-123')
    await browserSync.upload()

    expect(mockFetch.mock.calls[1][0]).toBe('https://llm.inkessai.com/api/subscription/browser-data')
  })
})
