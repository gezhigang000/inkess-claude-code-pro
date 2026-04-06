import { app } from 'electron'
import { join } from 'path'
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
  unlinkSync, readdirSync, statSync,
} from 'fs'
import log from '../logger'

const MAX_SESSION_SIZE = 10 * 1024 * 1024 // 10MB per session
const MAX_TOTAL_SIZE = 500 * 1024 * 1024  // 500MB total
const MIN_SESSION_SIZE = 100              // bytes — sessions smaller than this are auto-deleted
const INDEX_FILE = 'index.json'

export interface SessionMeta {
  id: string
  cwd: string
  title: string
  createdAt: number
  closedAt?: number
  size: number
}

export class SessionRecorder {
  private sessionsDir: string
  private index: SessionMeta[] = []
  private activeSessions = new Map<string, { meta: SessionMeta; size: number }>()

  constructor() {
    this.sessionsDir = join(app.getPath('userData'), 'sessions')
    mkdirSync(this.sessionsDir, { recursive: true })
    this.loadIndex()
  }

  private get indexPath(): string {
    return join(this.sessionsDir, INDEX_FILE)
  }

  private loadIndex(): void {
    try {
      if (existsSync(this.indexPath)) {
        const raw = readFileSync(this.indexPath, 'utf-8')
        this.index = JSON.parse(raw)
      }
    } catch (err) {
      log.warn('SessionRecorder: failed to load index:', err)
      this.index = []
    }
  }

  private saveIndex(): void {
    try {
      writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), { mode: 0o600 })
    } catch (err) {
      log.warn('SessionRecorder: failed to save index:', err)
    }
  }

  private static isValidId(id: string): boolean {
    return /^[a-zA-Z0-9-]{1,64}$/.test(id)
  }

  private getSessionPath(id: string): string {
    return join(this.sessionsDir, `${id}.jsonl`)
  }

  /** Start recording a new session */
  startSession(sessionId: string, cwd: string, title: string): void {
    if (!SessionRecorder.isValidId(sessionId)) return
    const meta: SessionMeta = {
      id: sessionId,
      cwd,
      title,
      createdAt: Date.now(),
      size: 0
    }
    this.activeSessions.set(sessionId, { meta, size: 0 })
    this.index.push(meta)
    this.saveIndex()
  }

  /** Record PTY output data */
  recordData(sessionId: string, data: string): void {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    if (session.size >= MAX_SESSION_SIZE) return

    const line = JSON.stringify({ t: Date.now(), d: data, s: 'pty' }) + '\n'
    try {
      appendFileSync(this.getSessionPath(sessionId), line, { mode: 0o600 })
      session.size += Buffer.byteLength(line)
    } catch {
      // Silently ignore write errors
    }
  }

  /** Record user input — disabled: do not record keystrokes for security */
  recordInput(_sessionId: string, _data: string): void { /* no-op */ }

  /** Close a session */
  closeSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    this.activeSessions.delete(sessionId)

    // Get actual file size
    const path = this.getSessionPath(sessionId)
    let actualSize = 0
    try { actualSize = statSync(path).size } catch { /* file may not exist */ }

    // Delete empty/tiny sessions
    if (actualSize < MIN_SESSION_SIZE) {
      try { if (existsSync(path)) unlinkSync(path) } catch { /* ignore */ }
      this.index = this.index.filter(m => m.id !== sessionId)
      log.info(`SessionRecorder: deleted empty session ${sessionId} (${actualSize} bytes)`)
      this.saveIndex()
      return
    }

    const meta = this.index.find(m => m.id === sessionId)
    if (meta) {
      meta.closedAt = Date.now()
      meta.size = actualSize
    }
    this.saveIndex()

    // Check total storage and clean up if needed
    this.enforceStorageLimit()
  }

  /** Get list of all sessions (newest first) */
  listSessions(): SessionMeta[] {
    return [...this.index].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Read session content as array of JSONL entries */
  async readSession(sessionId: string): Promise<string | null> {
    if (!SessionRecorder.isValidId(sessionId)) return null
    const path = this.getSessionPath(sessionId)
    if (!existsSync(path)) return null
    try {
      const { readFile } = require('fs/promises') as typeof import('fs/promises')
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  }

  /** Delete a single session */
  deleteSession(sessionId: string): void {
    if (!SessionRecorder.isValidId(sessionId)) return
    const path = this.getSessionPath(sessionId)
    try { if (existsSync(path)) unlinkSync(path) } catch { /* ignore */ }
    this.index = this.index.filter(m => m.id !== sessionId)
    this.saveIndex()
  }

  /** Search sessions for a keyword (returns matching session IDs with context) */
  async searchSessions(query: string): Promise<{ id: string; matches: string[] }[]> {
    const results: { id: string; matches: string[] }[] = []
    const lowerQuery = query.toLowerCase()
    const MAX_SEARCH_SESSIONS = 50
    const TIMEOUT_MS = 3000
    const YIELD_INTERVAL = 5

    const startTime = Date.now()
    const { readFile } = require('fs/promises') as typeof import('fs/promises')
    let searched = 0

    for (const meta of this.index) {
      if (searched >= MAX_SEARCH_SESSIONS) break
      if (Date.now() - startTime > TIMEOUT_MS) break

      const path = this.getSessionPath(meta.id)
      if (!existsSync(path)) continue

      searched++

      // Yield to event loop every YIELD_INTERVAL files
      if (searched % YIELD_INTERVAL === 0) {
        await new Promise<void>(r => setImmediate(r))
      }

      try {
        const content = await readFile(path, 'utf-8')
        const matches: string[] = []
        const lines = content.split('\n')

        for (const line of lines) {
          if (!line) continue
          try {
            const entry = JSON.parse(line) as { t: number; d: string; s: string }
            // Strip ANSI for search
            const clean = entry.d.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '')
            if (clean.toLowerCase().includes(lowerQuery)) {
              // Extract ~80 chars context around match
              const idx = clean.toLowerCase().indexOf(lowerQuery)
              const start = Math.max(0, idx - 30)
              const end = Math.min(clean.length, idx + query.length + 50)
              matches.push(clean.slice(start, end).trim())
              if (matches.length >= 3) break // max 3 matches per session
            }
          } catch { /* skip malformed lines */ }
        }

        if (matches.length > 0) {
          results.push({ id: meta.id, matches })
        }
      } catch { /* ignore read errors */ }
    }

    return results
  }

  /** Clear all session history */
  clearAll(): void {
    for (const meta of this.index) {
      const path = this.getSessionPath(meta.id)
      try { if (existsSync(path)) unlinkSync(path) } catch { /* ignore */ }
    }
    this.index = []
    this.saveIndex()
  }

  /** Enforce total storage limit by removing oldest sessions */
  private enforceStorageLimit(): void {
    // Clean up orphaned .jsonl files not in the index
    try {
      const indexedIds = new Set(this.index.map(m => m.id))
      const orphans = readdirSync(this.sessionsDir).filter(f => f.endsWith('.jsonl') && !indexedIds.has(f.replace('.jsonl', '')))
      for (const f of orphans) {
        try { unlinkSync(join(this.sessionsDir, f)) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    let totalSize = 0
    // Calculate total size from actual files
    try {
      const files = readdirSync(this.sessionsDir).filter(f => f.endsWith('.jsonl'))
      for (const f of files) {
        try {
          totalSize += statSync(join(this.sessionsDir, f)).size
        } catch { /* ignore */ }
      }
    } catch { return }

    if (totalSize <= MAX_TOTAL_SIZE) return

    // Sort by createdAt ascending (oldest first)
    const sorted = [...this.index].sort((a, b) => a.createdAt - b.createdAt)
    let removed = 0
    for (const meta of sorted) {
      if (totalSize - removed <= MAX_TOTAL_SIZE) break
      const path = this.getSessionPath(meta.id)
      try {
        const size = statSync(path).size
        unlinkSync(path)
        removed += size
        this.index = this.index.filter(m => m.id !== meta.id)
      } catch { /* ignore */ }
    }
    this.saveIndex()
    log.info(`SessionRecorder: cleaned up ${(removed / 1024 / 1024).toFixed(1)}MB of old sessions`)
  }
}
