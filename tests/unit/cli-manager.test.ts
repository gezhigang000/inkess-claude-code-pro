import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userdata' },
}))

// Mock fs
const mockExistsSync = vi.fn(() => false)
const mockReadFileSync = vi.fn(() => '')
vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ on: vi.fn() })),
}))

// Mock shared fetch utils
vi.mock('@main/utils/fetch', () => ({
  fetchWithTimeout: (...args: any[]) => mockFetch(...args),
  sha256File: vi.fn(async () => 'abc123'),
}))

// Mock child_process
const mockExecSync = vi.fn()
vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}))

// Mock stream/promises
vi.mock('stream/promises', () => ({
  pipeline: vi.fn(async () => {}),
}))

// Mock logger
vi.mock('@main/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { CliManager } from '@main/cli/cli-manager'

describe('CliManager', () => {
  let cli: CliManager

  beforeEach(() => {
    vi.clearAllMocks()
    cli = new CliManager()
  })

  describe('getInfo', () => {
    it('returns not installed when binary missing', () => {
      mockExistsSync.mockReturnValue(false)
      const info = cli.getInfo()
      expect(info.installed).toBe(false)
      expect(info.version).toBeNull()
    })

    it('returns installed with version from .active file', () => {
      // Versioned layout: .active file holds the current version string,
      // {cliDir}/{version}/claude is the binary.
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('1.0.5')
      const info = cli.getInfo()
      expect(info.installed).toBe(true)
      expect(info.version).toBe('1.0.5')
    })

    it('trims whitespace/newline from .active file', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('1.0.5\n')
      const info = cli.getInfo()
      expect(info.installed).toBe(true)
      expect(info.version).toBe('1.0.5')
    })
  })

  describe('isInstalled', () => {
    it('returns false when binary missing', () => {
      mockExistsSync.mockReturnValue(false)
      expect(cli.isInstalled()).toBe(false)
    })

    it('returns true when binary exists', () => {
      mockExistsSync.mockReturnValue(true)
      expect(cli.isInstalled()).toBe(true)
    })
  })
})