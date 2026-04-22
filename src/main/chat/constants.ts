/** Maximum number of chats that can be streaming simultaneously (spec §3). */
export const MAX_CONCURRENT = 5

/** Hard cap on a single turn in milliseconds (spec §6.1). */
export const TURN_TIMEOUT_MS = 600_000

/** Grace period between SIGTERM and SIGKILL when cancelling (spec §3). */
export const CANCEL_GRACE_MS = 3_000

/** Maximum text length accepted by chat:send input validation (spec §2). */
export const MAX_TEXT_BYTES = 100 * 1024 // 100KB

/** Claude Code tool whitelist (spec §4 — full list). */
export const ALLOWED_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'MultiEdit',
  'Glob', 'Grep',
  'NotebookEdit',
  'WebSearch', 'WebFetch',
  'TodoWrite',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(find:*)',
  'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(file:*)',
  'Bash(pwd)', 'Bash(echo:*)', 'Bash(date)',
  'Bash(git status)', 'Bash(git log:*)', 'Bash(git diff:*)',
  'Bash(git show:*)', 'Bash(git branch:*)', 'Bash(git remote:*)',
  'Bash(python:--version)', 'Bash(python3:--version)',
  'Bash(node:--version)', 'Bash(npm:--version)',
  'Bash(which:*)', 'Bash(env)',
]
