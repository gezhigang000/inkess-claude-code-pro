import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { resolve, join } from 'path'

const REPO = resolve(__dirname, '../..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

function importsMatching(
  files: string[],
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      // Match all import/require forms:
      //   import X from 'mod'       | import { X } from 'mod'
      //   import * as X from 'mod'  | import type { X } from 'mod'
      //   import('mod')             | require('mod')
      //   import 'mod'              (side-effect)
      const m =
        line.match(/(?:from|require\(|import\()\s*['"]([^'"]+)['"]/) ||
        line.match(/^\s*import\s+['"]([^'"]+)['"]/)
      if (!m) return
      if (pattern.test(m[1])) {
        hits.push({ file, line: i + 1, text: line.trim() })
      }
    })
  }
  return hits
}

describe('chat ↔ pty isolation (spec §2.5)', () => {
  const chatFiles = walk(resolve(REPO, 'src/main/chat'))
  const ptyFiles = walk(resolve(REPO, 'src/main/pty'))
  const sessionFiles = walk(resolve(REPO, 'src/main/session'))

  it('main/chat/** does NOT import from main/pty/**', () => {
    const violations = importsMatching(chatFiles, /(?:^|\/)\.\.?\/.*\bpty\b/)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })

  it('main/chat/** does NOT import from main/session/**', () => {
    const violations = importsMatching(chatFiles, /(?:^|\/)\.\.?\/.*\bsession\b/)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })

  it('main/pty/** does NOT import from main/chat/**', () => {
    const violations = importsMatching(ptyFiles, /(?:^|\/)\.\.?\/.*\bchat\b/)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })

  it('main/session/** does NOT import from main/chat/**', () => {
    const violations = importsMatching(sessionFiles, /(?:^|\/)\.\.?\/.*\bchat\b/)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })
})

describe('chat store isolation (spec §2.5)', () => {
  it('renderer chat store does NOT import renderer terminal store', () => {
    // chat store file is created in Plan C; this test no-ops until then.
    const storePath = resolve(REPO, 'src/renderer/stores/chat.ts')
    let text: string
    try {
      text = readFileSync(storePath, 'utf8')
    } catch {
      // Plan C hasn't shipped yet — this guard becomes active once the file lands.
      return
    }
    expect(text).not.toMatch(/from\s+['"][^'"]*\bterminal\b/)
  })
})
