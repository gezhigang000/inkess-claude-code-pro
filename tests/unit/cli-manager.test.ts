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

    it('returns installed with version from marker file', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('1.0.5|2026-01-01T00:00:00.000Z')
      const info = cli.getInfo()
      expect(info.installed).toBe(true)
      expect(info.version).toBe('1.0.5')
    })

    it('returns installed with version from execSync when no marker', () => {
      // First call: markerPath existsSync → false, second: binaryPath → true
      mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true)
      mockExecSync.mockReturnValue('1.0.5\n')
      const info = cli.getInfo()
      expect(info.installed).toBe(true)
      expect(info.version).toBe('1.0.5')
    })
  })

  describe('checkUpdate', () => {
    it('returns available when versions differ', async () => {
      // getInfo must return a version for checkUpdate to compare
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('1.0.0|2026-01-01')
      // Invalidate cache so getInfo re-reads
      cli.invalidateCache()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '1.1.0',
      })
      const result = await cli.checkUpdate()
      expect(result.available).toBe(true)
      expect(result.latestVersion).toBe('1.1.0')
    })

    it('returns not available when version is null (marker has no version)', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('2026-01-01T00:00:00.000Z') // legacy marker, no version
      cli.invalidateCache()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '1.1.0',
      })
      const result = await cli.checkUpdate()
      expect(result.available).toBe(false)
    })

    it('returns not available on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))
      const result = await cli.checkUpdate()
      expect(result.available).toBe(false)
      expect(result.latestVersion).toBeNull()
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