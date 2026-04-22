import { existsSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { sep } from 'path'
import { MAX_TEXT_BYTES } from './constants'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function validateChatId(x: unknown): asserts x is string {
  if (typeof x !== 'string' || !UUID_RE.test(x)) {
    throw new Error('invalid_chat_id')
  }
}

export function validateText(x: unknown): asserts x is string {
  if (typeof x !== 'string') throw new Error('invalid_text')
  if (x.trim().length === 0) throw new Error('invalid_text')
  if (Buffer.byteLength(x, 'utf8') > MAX_TEXT_BYTES) throw new Error('invalid_text')
}

/**
 * Throws if dirPath is not an existing directory strictly under $HOME.
 * Uses realpathSync so symlinks can't escape the boundary.
 *
 * Error codes (spec §6.4):
 *   dir_not_found      — path doesn't exist
 *   dir_outside_home   — path is outside $HOME after realpath
 *   dir_invalid        — path isn't a directory
 */
export function validateDirPath(x: unknown): asserts x is string {
  if (typeof x !== 'string' || !x) throw new Error('dir_invalid')
  if (!existsSync(x)) throw new Error('dir_not_found')

  let resolved: string
  try {
    resolved = realpathSync(x)
  } catch {
    throw new Error('dir_not_found')
  }

  let s
  try {
    s = statSync(resolved)
  } catch {
    throw new Error('dir_not_found')
  }
  if (!s.isDirectory()) throw new Error('dir_invalid')

  const home = realpathSync(homedir())
  // Require strict prefix + sep to rule out "/Users/alice-evil" slipping past a /Users/alice boundary
  const homePrefix = home.endsWith(sep) ? home : home + sep
  if (resolved !== home && !resolved.startsWith(homePrefix)) {
    throw new Error('dir_outside_home')
  }
}
