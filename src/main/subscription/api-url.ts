export const DEFAULT_SUBSCRIPTION_API_BASE = 'https://llm.inkessai.com'

export function buildSubscriptionApiUrl(path: string, base = DEFAULT_SUBSCRIPTION_API_BASE): string {
  const normalizedBase = base.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}
