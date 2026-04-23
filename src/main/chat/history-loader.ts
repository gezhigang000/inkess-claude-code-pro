import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import type { ChatEvent, ChatMeta } from './chat-types'
import { normalize } from './normalizer'

/** Cap per-session JSONL at 10 MB to avoid blocking the main thread. */
const MAX_HISTORY_BYTES = 10 * 1024 * 1024

/**
 * Claude Code encodes a project's cwd as the JSONL directory name by
 * normalizing path separators to '/' and then replacing every '/' with '-'.
 * Observed at `~/.claude/projects/` and `{CLAUDE_CONFIG_DIR}/projects/`.
 *   /Users/alice/proj        →  -Users-alice-proj
 *   C:\Users\alice\proj      →  C:-Users-alice-proj  (Windows)
 *
 * On Windows, meta.cwd contains backslashes; without the normalize-first
 * step, the JSONL path would never match what Claude Code wrote and
 * history reload would silently return [] on every chat.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\//g, '-')
}

/**
 * Read the JSONL for this chat's current Claude Code session and normalize
 * every line into a flat ChatEvent. Zero LLM calls — pure file IO.
 *
 * Returns [] when:
 *   - claudeSessionId is null (first turn never completed)
 *   - the JSONL file doesn't exist yet
 */
export async function loadHistory(
  meta: ChatMeta,
  claudeConfigDir: string,
): Promise<ChatEvent[]> {
  if (!meta.claudeSessionId) return []
  const jsonlPath = join(
    claudeConfigDir,
    'projects',
    encodeCwd(meta.cwd),
    `${meta.claudeSessionId}.jsonl`,
  )
  if (!existsSync(jsonlPath)) return []

  try {
    const size = statSync(jsonlPath).size
    if (size > MAX_HISTORY_BYTES) {
      console.warn(`[chat] history file too large (${(size / 1024 / 1024).toFixed(1)} MB), skipping: ${jsonlPath}`)
      return []
    }
  } catch {
    return []
  }

  const raw = readFileSync(jsonlPath, 'utf8')
  const events: ChatEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    events.push(...normalize(parsed))
  }
  return events
}
