export const DEFAULT_SUBSCRIPTION_API_BASE = 'https://llm.inkessai.com'

let currentApiBase: string = DEFAULT_SUBSCRIPTION_API_BASE

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '')
}

function validateBase(base: string): string {
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    throw new Error(`Invalid subscription API base URL: ${base}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Subscription API base must use http(s): ${base}`)
  }
  return normalizeBase(base)
}

export function getSubscriptionApiBase(): string {
  return currentApiBase
}

export function setSubscriptionApiBase(base: string | null | undefined): void {
  if (base === null || base === undefined || base === '') {
    currentApiBase = DEFAULT_SUBSCRIPTION_API_BASE
    return
  }
  currentApiBase = validateBase(base)
}

export function buildSubscriptionApiUrl(path: string, base: string = currentApiBase): string {
  const normalizedBase = normalizeBase(base)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}
