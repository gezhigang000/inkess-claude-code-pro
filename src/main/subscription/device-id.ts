import { createHash } from 'crypto'
import { networkInterfaces, cpus } from 'os'
import { execSync } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import log from '../logger'

/**
 * Generate a stable device fingerprint based on hardware identifiers.
 * Cached to disk so it survives reinstalls on the same machine.
 */
export function getDeviceId(): string {
  const cacheDir = join(app.getPath('userData'), 'device')
  const cachePath = join(cacheDir, 'device-id')

  // Return cached value if exists
  if (existsSync(cachePath)) {
    try {
      const cached = readFileSync(cachePath, 'utf-8').trim()
      if (/^[0-9a-f]{32}$/.test(cached)) return cached
    } catch { /* regenerate */ }
  }

  const id = generateDeviceId()

  // Cache to disk
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath, id)
  } catch (err) {
    log.warn('Failed to cache device ID:', err)
  }

  return id
}

function generateDeviceId(): string {
  const parts: string[] = []

  // 1. MAC address (first non-internal, non-zero interface)
  try {
    const nets = networkInterfaces()
    for (const ifaces of Object.values(nets)) {
      for (const iface of ifaces || []) {
        if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
          parts.push(iface.mac)
          break
        }
      }
      if (parts.length > 0) break
    }
  } catch { /* ignore */ }

  // 2. CPU model
  try {
    parts.push(cpus()[0]?.model || 'unknown-cpu')
  } catch {
    parts.push('unknown-cpu')
  }

  // 3. Platform-specific hardware serial
  try {
    if (process.platform === 'darwin') {
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformSerialNumber',
        { encoding: 'utf-8', timeout: 3000 }
      ).trim()
      parts.push(output)
    } else if (process.platform === 'win32') {
      const output = execSync(
        'wmic diskdrive get serialnumber',
        { encoding: 'utf-8', timeout: 3000 }
      ).trim()
      parts.push(output)
    }
  } catch {
    parts.push('no-serial')
  }

  // 4. App path as fallback uniqueness
  parts.push(app.getPath('userData'))

  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}
