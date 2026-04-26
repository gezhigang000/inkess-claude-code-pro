export const DEFAULT_SUBSCRIPTION_API_BASE = 'https://llm.inkessai.com'

let currentApiBase: string = DEFAULT_SUBSCRIPTION_API_BASE

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
  // Only keep origin (protocol + host + port), strip path/query/fragment
  return parsed.origin
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
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalizedPath}`
}
