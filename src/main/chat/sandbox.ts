import type { ChatMeta } from './chat-types'
import { ALLOWED_TOOLS } from './constants'

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
  const mcpNull = process.platform === 'win32' ? 'NUL' : '/dev/null'

  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--disallowedTools', '',
    '--mcp-config', mcpNull,
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
