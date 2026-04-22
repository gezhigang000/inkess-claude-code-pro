import { describe, it, expect } from 'vitest'
import {
  validateChatId,
  validateText,
  validateDirPath,
} from '../../src/main/chat/validators'
import { mkdtempSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

describe('validateChatId', () => {
  it('accepts uuid v4', () => {
    expect(() => validateChatId('550e8400-e29b-41d4-a716-446655440000')).not.toThrow()
  })
  it('rejects non-string', () => {
    expect(() => validateChatId(123 as any)).toThrow(/invalid_chat_id/)
  })
  it('rejects bad format', () => {
    expect(() => validateChatId('not-a-uuid')).toThrow(/invalid_chat_id/)
    expect(() => validateChatId('')).toThrow(/invalid_chat_id/)
    expect(() => validateChatId('a'.repeat(65))).toThrow(/invalid_chat_id/)
  })
})

describe('validateText', () => {
  it('accepts non-empty string under cap', () => {
    expect(() => validateText('hello')).not.toThrow()
  })
  it('rejects non-string', () => {
    expect(() => validateText(null as any)).toThrow(/invalid_text/)
  })
  it('rejects empty', () => {
    expect(() => validateText('')).toThrow(/invalid_text/)
    expect(() => validateText('   ')).toThrow(/invalid_text/)
  })
  it('rejects oversize', () => {
    expect(() => validateText('x'.repeat(100 * 1024 + 1))).toThrow(/invalid_text/)
  })
})

describe('validateDirPath', () => {
  const HOME = homedir()

  it('accepts a real directory under $HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'val-'))
    // tmpdir is often NOT under HOME; this test just confirms the "exists" check passes
    // and the function throws for the right reason, not the wrong one.
    // We use a known-under-HOME path instead:
    expect(() => validateDirPath(HOME)).not.toThrow()
    void dir
  })

  it('rejects non-string', () => {
    expect(() => validateDirPath(42 as any)).toThrow(/dir_/)
  })

  it('rejects non-existent', () => {
    expect(() => validateDirPath(join(HOME, '__nope__xxx__'))).toThrow(/dir_not_found/)
  })

  it('rejects paths outside $HOME', () => {
    expect(() => validateDirPath('/etc')).toThrow(/dir_outside_home/)
  })

  it('rejects .. traversal', () => {
    expect(() => validateDirPath(`${HOME}/../etc`)).toThrow(/dir_/)
  })
})
