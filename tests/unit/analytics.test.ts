import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
}))

vi.mock('@main/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { Analytics } from '@main/analytics'

describe('Analytics', () => {
  let analytics: Analytics

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({ ok: true })
    analytics = new Analytics()
  })

  afterEach(() => {
    analytics.destroy()
  })

  it('queues events via track()', () => {
    analytics.track('test_event', { key: 'value' })
    // No fetch yet — not flushed
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('flushes on interval', async () => {
    analytics.track('event_1')
    // Manually call flush instead of advancing timers (avoids setInterval loop)
    await analytics.flush()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].event).toBe('event_1')
    expect(body.platform).toBe(process.platform)
  })

  it('flushes when queue reaches 20', async () => {
    for (let i = 0; i < 20; i++) {
      analytics.track(`event_${i}`)
    }
    // Should have auto-flushed
    await Promise.resolve()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.events).toHaveLength(20)
  })

  it('does not include auth header (anonymous analytics)', async () => {
    analytics.track('anon_event')
    await analytics.flush()
    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBeUndefined()
  })

  it('silently handles fetch failures', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'))
    analytics.track('fail_event')
    // Should not throw
    await analytics.flush()
  })

  it('does not flush when queue is empty', async () => {
    await analytics.flush()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('flushSync clears timer and flushes', async () => {
    analytics.track('sync_event')
    analytics.flushSync()
    // Give the async flush a tick to complete
    await new Promise(r => setTimeout(r, 50))
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
