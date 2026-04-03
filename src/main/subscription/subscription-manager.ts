import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { platform, release, arch } from 'os'
import log from '../logger'
import { getDeviceId } from './device-id'

const API_BASE = 'https://llm.starapp.net'

export interface SubscriptionConfig {
  claudeEmail: string
  claudePassword: string
  proxyUrl: string
  proxyRegion: string
  expiresAt: string
  status: 'active' | 'expired' | 'suspended'
  daysRemaining?: number
}

export interface SubscriptionStatus {
  status: 'active' | 'expired' | 'suspended'
  expiresAt: string
  daysRemaining: number
  proxyUrl?: string
  proxyRegion?: string
}

interface StoredSession {
  token: string
  username: string
  expiresAt: string
  proxyUrl: string
  proxyRegion: string
}

export class SubscriptionManager {
  private sessionDir: string
  private session: StoredSession | null = null

  constructor() {
    this.sessionDir = join(app.getPath('userData'), 'subscription')
    mkdirSync(this.sessionDir, { recursive: true })
    this.loadSession()
  }

  private get sessionPath(): string {
    return join(this.sessionDir, 'session.json')
  }

  private loadSession(): void {
    try {
      if (existsSync(this.sessionPath)) {
        this.session = JSON.parse(readFileSync(this.sessionPath, 'utf-8'))
      }
    } catch {
      this.session = null
    }
  }

  private saveSession(session: StoredSession): void {
    this.session = session
    try {
      writeFileSync(this.sessionPath, JSON.stringify(session))
    } catch (err) {
      log.error('Failed to save subscription session:', err)
    }
  }

  isLoggedIn(): boolean {
    return this.session !== null
  }

  getSession(): StoredSession | null {
    return this.session
  }

  getUsername(): string | null {
    return this.session?.username || null
  }

  /**
   * Login with subscription credentials.
   * Returns config on success (including Claude credentials — one-time).
   */
  async login(username: string, password: string): Promise<{
    success: boolean
    config?: SubscriptionConfig
    error?: string
    errorCode?: string
  }> {
    const deviceId = getDeviceId()

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)

      const res = await fetch(`${API_BASE}/api/subscription/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, password, deviceId,
          deviceName: `${platform()} ${release()} ${arch()}`,
          appVersion: app.getVersion(),
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return {
          success: false,
          error: body.message || `Login failed (HTTP ${res.status})`,
          errorCode: body.error,
        }
      }

      const data = await res.json()
      const config = data.config as SubscriptionConfig

      // Save session (without Claude password — never persist)
      this.saveSession({
        token: data.token,
        username,
        expiresAt: config.expiresAt,
        proxyUrl: config.proxyUrl,
        proxyRegion: config.proxyRegion,
      })

      log.info(`Subscription login success: ${username}`)
      return { success: true, config }
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('aborted')) {
        return { success: false, error: 'Connection timed out. Please check your network.' }
      }
      return { success: false, error: msg }
    }
  }

  /**
   * Check subscription status (periodic polling).
   */
  async checkStatus(): Promise<SubscriptionStatus | null> {
    if (!this.session?.token) return null

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)

      const res = await fetch(`${API_BASE}/api/subscription/status`, {
        headers: { 'Authorization': `Bearer ${this.session.token}` },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (res.status === 401) {
        // Token expired — clear session
        this.logout()
        return null
      }

      if (!res.ok) return null

      const status = await res.json() as SubscriptionStatus

      // Update local session with any proxy changes
      if (status.proxyUrl && status.proxyUrl !== this.session.proxyUrl) {
        this.session.proxyUrl = status.proxyUrl
        if (status.proxyRegion) this.session.proxyRegion = status.proxyRegion
        this.saveSession(this.session)
      }

      return status
    } catch {
      return null
    }
  }

  logout(): void {
    this.session = null
    try {
      if (existsSync(this.sessionPath)) unlinkSync(this.sessionPath)
    } catch { /* ignore */ }
  }
}
