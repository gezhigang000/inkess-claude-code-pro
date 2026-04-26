import { afterEach, describe, expect, it } from 'vitest'

import {
  buildSubscriptionApiUrl,
  DEFAULT_SUBSCRIPTION_API_BASE,
  getSubscriptionApiBase,
  setSubscriptionApiBase,
} from '@main/subscription/api-url'

describe('subscription API URL', () => {
  afterEach(() => {
    setSubscriptionApiBase(null)
  })

  it('defaults to llm.inkessai.com', () => {
    expect(DEFAULT_SUBSCRIPTION_API_BASE).toBe('https://llm.inkessai.com')
    expect(getSubscriptionApiBase()).toBe('https://llm.inkessai.com')
  })

  it('builds subscription endpoint URLs from the configured base', () => {
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://llm.inkessai.com/api/subscription/login')
    expect(buildSubscriptionApiUrl('api/subscription/status')).toBe('https://llm.inkessai.com/api/subscription/status')
  })

  it('honors a runtime override for the API base', () => {
    setSubscriptionApiBase('https://staging.inkessai.com/')
    expect(getSubscriptionApiBase()).toBe('https://staging.inkessai.com')
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://staging.inkessai.com/api/subscription/login')
  })

  it('falls back to the default when the override is cleared', () => {
    setSubscriptionApiBase('https://staging.inkessai.com')
    setSubscriptionApiBase(null)
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://llm.inkessai.com/api/subscription/login')
  })

  it('rejects invalid override values', () => {
    expect(() => setSubscriptionApiBase('not-a-url')).toThrow()
    expect(() => setSubscriptionApiBase('ftp://example.com')).toThrow()
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://llm.inkessai.com/api/subscription/login')
  })

  it('strips path, query string, and fragment from override URL', () => {
    setSubscriptionApiBase('https://inkess.cc/api')
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://inkess.cc/api/subscription/login')

    setSubscriptionApiBase('https://inkess.cc?foo=bar')
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://inkess.cc/api/subscription/login')

    setSubscriptionApiBase('https://inkess.cc#anchor')
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://inkess.cc/api/subscription/login')

    setSubscriptionApiBase('https://inkess.cc/some/path?q=1#hash')
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://inkess.cc/api/subscription/login')
  })

  it('preserves port in override URL', () => {
    setSubscriptionApiBase('https://inkess.cc:8443/path')
    expect(getSubscriptionApiBase()).toBe('https://inkess.cc:8443')
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://inkess.cc:8443/api/subscription/login')
  })

  it('falls back to default for empty string and undefined', () => {
    setSubscriptionApiBase('https://inkess.cc')
    setSubscriptionApiBase('')
    expect(getSubscriptionApiBase()).toBe(DEFAULT_SUBSCRIPTION_API_BASE)

    setSubscriptionApiBase('https://inkess.cc')
    setSubscriptionApiBase(undefined)
    expect(getSubscriptionApiBase()).toBe(DEFAULT_SUBSCRIPTION_API_BASE)
  })
})
