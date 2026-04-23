import { join } from 'path'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import type { ChatMeta } from './chat-types'
import { ALLOWED_TOOLS } from './constants'

/**
 * Path to an empty MCP config file used to disable MCP in chat mode.
 * Call `initEmptyMcpConfig(userDataDir)` at startup to set the path.
 */
let _emptyMcpConfig: string | null = null

export function initEmptyMcpConfig(userDataDir: string): void {
  const dir = join(userDataDir, 'chat')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = join(dir, 'empty-mcp.json')
  writeFileSync(p, '{"mcpServers":{}}', 'utf8')
  _emptyMcpConfig = p
}

function getEmptyMcpConfig(): string {
  if (!_emptyMcpConfig) {
    // Fallback: lazy init (should not happen if initEmptyMcpConfig was called at startup)
    const { app } = require('electron')
    initEmptyMcpConfig(app.getPath('userData'))
  }
  return _emptyMcpConfig!
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
 *   - stream-json + verbose output for ChatManager to parse (--verbose required
 *     by CLI ≥2.1.98 when combining --print with --output-format stream-json)
 *   - --dangerously-skip-permissions silences Claude Code's built-in per-tool
 *     Y/N prompt; the whitelist passed via --allowedTools still applies
 *   - --mcp-config empty-mcp.json + --strict-mcp-config disables MCP entirely
 *     (strict prevents CLI from loading ~/.claude.json or .mcp.json servers)
 *   - --add-dir for each user-mounted directory (empty on v0.1)
 *   - --resume <id> only on follow-up turns (first turn starts fresh)
 */
export function buildArgs(input: BuildArgsInput): string[] {
  const { meta, text } = input
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--disallowedTools', '',
    '--mcp-config', getEmptyMcpConfig(),
    '--strict-mcp-config',
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
