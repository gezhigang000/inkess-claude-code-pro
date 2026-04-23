import { join } from 'path'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import type { ChatMeta } from './chat-types'
import { ALLOWED_TOOLS } from './constants'

/** Path to an empty MCP config file used to disable MCP in chat mode. */
let _emptyMcpConfig: string | null = null
function getEmptyMcpConfig(): string {
  if (process.platform !== 'win32') return '/dev/null'
  if (_emptyMcpConfig) return _emptyMcpConfig
  // Lazy import to avoid pulling Electron into unit tests
  const { app } = require('electron')
  const dir = join(app.getPath('userData'), 'chat')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = join(dir, 'empty-mcp.json')
  writeFileSync(p, '{"mcpServers":{}}', 'utf8')
  _emptyMcpConfig = p
  return p
}

export interface BuildArgsInput {
  meta: ChatMeta
  text: string
}

/**
 * Compose `claude` CLI arguments for a single turn.
 * Pure function — no process spawning, no filesystem access.
 *
 * Sandbox policy (spec §4):
 *   - stream-json output for ChatManager to parse
 *   - --dangerously-skip-permissions silences Claude Code's built-in per-tool
 *     Y/N prompt; the whitelist passed via --allowedTools still applies
 *   - --mcp-config /dev/null disables MCP entirely (Windows: NUL)
 *   - --add-dir for each user-mounted directory (empty on v0.1)
 *   - --resume <id> only on follow-up turns (first turn starts fresh)
 */
export function buildArgs(input: BuildArgsInput): string[] {
  const { meta, text } = input
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--disallowedTools', '',
    '--mcp-config', getEmptyMcpConfig(),
  ]

  if (meta.claudeSessionId) {
    args.push('--resume', meta.claudeSessionId)
  }

  for (const dir of meta.mountedDirs) {
    args.push('--add-dir', dir)
  }

  args.push('--print', text)
  return args
}
