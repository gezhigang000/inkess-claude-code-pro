import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildCleanEnv, DEFAULT_REGION_ENV } from '../../src/main/utils/clean-env'

describe('buildCleanEnv', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Reset to a minimal known state
    for (const k of Object.keys(process.env)) delete process.env[k]
    process.env.HOME = '/home/test'
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = '/usr/bin:/bin'
    process.env.EDITOR = 'vim'
    process.env.ANTHROPIC_API_KEY = 'secret-should-not-leak'
    process.env.LD_PRELOAD = 'evil.so'
  })

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, originalEnv)
  })

  it('returns HOME, SHELL, TERM, COLORTERM', () => {
    const env = buildCleanEnv()
    expect(env.HOME).toBe('/home/test')
    if (process.platform !== 'win32') expect(env.SHELL).toBe('/bin/zsh')
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
  })

  it('applies DEFAULT_REGION_ENV', () => {
    const env = buildCleanEnv()
    for (const [k, v] of Object.entries(DEFAULT_REGION_ENV)) {
      expect(env[k]).toBe(v)
    }
  })

  it('regionEnv overrides DEFAULT_REGION_ENV', () => {
    const env = buildCleanEnv({ TZ: 'Asia/Tokyo', LANG: 'ja_JP.UTF-8' })
    expect(env.TZ).toBe('Asia/Tokyo')
    expect(env.LANG).toBe('ja_JP.UTF-8')
  })

  it('passes through whitelisted dev-tool vars', () => {
    const env = buildCleanEnv()
    expect(env.EDITOR).toBe('vim')
  })

  it('does NOT leak ANTHROPIC_* or LD_PRELOAD', () => {
    const env = buildCleanEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.LD_PRELOAD).toBeUndefined()
  })

  it('extraEnv wins over all other layers', () => {
    const env = buildCleanEnv({ TZ: 'Asia/Tokyo' }, { TZ: 'Europe/London', CLAUDE_CONFIG_DIR: '/cfg' })
    expect(env.TZ).toBe('Europe/London')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg')
  })
})
