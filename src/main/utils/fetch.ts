/**
 * Shared fetch utility with timeout and retry support.
 * Used by CliManager and ToolsManager for binary downloads.
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 15000,
  retries = 2
): Promise<Response> {
  const attempt = (): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    return fetch(url, { ...options, signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    )
  }
  const run = async (): Promise<Response> => {
    let lastErr: unknown
    for (let i = 0; i <= retries; i++) {
      try { return await attempt() } catch (err) {
        lastErr = err
        if (i < retries) await new Promise(r => setTimeout(r, 1500 * (i + 1)))
      }
    }
    throw lastErr
  }
  return run()
}

/**
 * Streaming SHA-256 hash of a file. Memory-efficient for large binaries.
 */
export async function sha256File(filePath: string): Promise<string> {
  const { createReadStream } = await import('fs')
  const { createHash } = await import('crypto')
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}
