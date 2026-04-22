import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ChatEvent, ChatMeta } from './chat-types'
import { normalize } from './normalizer'

/**
 * Claude Code encodes a project's cwd as the JSONL directory name by
 * replacing every '/' with '-'. Observed at `~/.claude/projects/` and
 * `{CLAUDE_CONFIG_DIR}/projects/`.
 *   /Users/alice/proj  →  -Users-alice-proj
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
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
