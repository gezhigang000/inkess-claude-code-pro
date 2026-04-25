import { describe, expect, it } from 'vitest'

import { buildSubscriptionApiUrl, DEFAULT_SUBSCRIPTION_API_BASE } from '@main/subscription/api-url'

describe('subscription API URL', () => {
  it('defaults to llm.inkessai.com', () => {
    expect(DEFAULT_SUBSCRIPTION_API_BASE).toBe('https://llm.inkessai.com')
  })

  it('builds subscription endpoint URLs from the configured base', () => {
    expect(buildSubscriptionApiUrl('/api/subscription/login')).toBe('https://llm.inkessai.com/api/subscription/login')
    expect(buildSubscriptionApiUrl('api/subscription/status')).toBe('https://llm.inkessai.com/api/subscription/status')
  })
})
