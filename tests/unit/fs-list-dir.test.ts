import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

/**
 * Inline the core listDir logic (mirrors the IPC handler in index.ts)
 * so we can unit test it without Electron.
 */
function listDir(dirPath: string, homeDir?: string): { name: string; path: string; isDirectory: boolean }[] {
  const { resolve, normalize, join: pjoin, sep } = require('path') as typeof import('path')
  const { realpathSync, readdirSync, existsSync: exists } = require('fs') as typeof import('fs')

  if (typeof dirPath !== 'string') return []
  const resolved = resolve(normalize(dirPath))
  const home = homeDir ?? homedir()
  const homePrefix = home + sep
  if (!resolved.startsWith(homePrefix) && resolved !== home) return []

  let real: string
  try { real = realpathSync(resolved) } catch { return [] }
  if (!real.startsWith(homePrefix) && real !== home) return []
  if (!exists(real)) return []

  const MAX_ENTRIES = 2000
  const entries = readdirSync(real, { withFileTypes: true })
  const result: { name: string; path: string; isDirectory: boolean }[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    result.push({
      name: entry.name,
      path: pjoin(resolved, entry.name),
      isDirectory: entry.isDirectory(),
    })
    if (result.length >= MAX_ENTRIES) break
  }
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return result
}

// Create temp fixtures under $HOME so boundary check passes
const TEST_ROOT = join(homedir(), '.inkess-test-fs-listdir-' + Date.now())

describe('fs:listDir logic', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_ROOT, 'src', 'components'), { recursive: true })
    mkdirSync(join(TEST_ROOT, 'node_modules', 'lodash'), { recursive: true })
    mkdirSync(join(TEST_ROOT, '.git', 'objects'), { recursive: true })
    writeFileSync(join(TEST_ROOT, 'package.json'), '{}')
    writeFileSync(join(TEST_ROOT, 'README.md'), '# hi')
    writeFileSync(join(TEST_ROOT, '.env'), 'SECRET=1')
    writeFileSync(join(TEST_ROOT, 'src', 'index.ts'), 'export {}')
    writeFileSync(join(TEST_ROOT, 'src', 'App.tsx'), 'export {}')
    writeFileSync(join(TEST_ROOT, 'src', 'components', 'Button.tsx'), 'export {}')
    writeFileSync(join(TEST_ROOT, 'node_modules', 'lodash', 'index.js'), '')
  })

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('lists files and directories, dirs first, sorted alphabetically', () => {
    const result = listDir(TEST_ROOT)
    const names = result.map(e => e.name)
    // .env and .git are dotfiles — should be filtered
    expect(names).not.toContain('.env')
    expect(names).not.toContain('.git')
    // dirs come first
    const firstFile = result.findIndex(e => !e.isDirectory)
    const lastDir = result.findLastIndex(e => e.isDirectory)
    if (firstFile >= 0 && lastDir >= 0) {
      expect(lastDir).toBeLessThan(firstFile)
    }
    // both dirs and files present
    expect(names).toContain('src')
    expect(names).toContain('node_modules')
    expect(names).toContain('package.json')
    expect(names).toContain('README.md')
  })

  it('lists subdirectory contents', () => {
    const result = listDir(join(TEST_ROOT, 'src'))
    const names = result.map(e => e.name)
    expect(names).toContain('components')
    expect(names).toContain('index.ts')
    expect(names).toContain('App.tsx')
    // components is a dir, should be first
    expect(result[0].name).toBe('components')
    expect(result[0].isDirectory).toBe(true)
  })

  it('returns correct path property', () => {
    const result = listDir(TEST_ROOT)
    const src = result.find(e => e.name === 'src')!
    expect(src.path).toBe(join(TEST_ROOT, 'src'))
  })

  it('blocks paths outside $HOME', () => {
    const result = listDir('/etc')
    expect(result).toEqual([])
  })

  it('blocks paths outside $HOME via custom homeDir', () => {
    // Use a fake home that doesn't contain TEST_ROOT
    const result = listDir(TEST_ROOT, '/nonexistent/fakehome')
    expect(result).toEqual([])
  })

  it('returns empty array for non-existent directory', () => {
    const result = listDir(join(TEST_ROOT, 'nope-does-not-exist'))
    expect(result).toEqual([])
  })

  it('returns empty array for non-string input', () => {
    expect(listDir(123 as any)).toEqual([])
    expect(listDir(null as any)).toEqual([])
    expect(listDir(undefined as any)).toEqual([])
  })

  it('handles symlink escape attempt', () => {
    const linkPath = join(TEST_ROOT, 'escape-link')
    try {
      symlinkSync('/etc', linkPath)
    } catch {
      // symlink creation may fail on some systems; skip
      return
    }
    // The link itself is under HOME, but it points to /etc
    // listDir should resolve symlink and block it
    const result = listDir(linkPath)
    expect(result).toEqual([])
    rmSync(linkPath)
  })

  it('case-insensitive sort', () => {
    const subdir = join(TEST_ROOT, 'sort-test')
    mkdirSync(subdir, { recursive: true })
    writeFileSync(join(subdir, 'Alpha.ts'), '')
    writeFileSync(join(subdir, 'beta.ts'), '')
    writeFileSync(join(subdir, 'Charlie.ts'), '')
    const result = listDir(subdir)
    const names = result.map(e => e.name)
    expect(names).toEqual(['Alpha.ts', 'beta.ts', 'Charlie.ts'])
    rmSync(subdir, { recursive: true, force: true })
  })

  it('dotfiles are hidden', () => {
    const result = listDir(TEST_ROOT)
    const dotfiles = result.filter(e => e.name.startsWith('.'))
    expect(dotfiles).toEqual([])
  })
})
