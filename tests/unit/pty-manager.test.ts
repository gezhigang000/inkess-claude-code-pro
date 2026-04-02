import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock node-pty
const mockPtyProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
}
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyProcess),
}))

// Mock logger
vi.mock('@main/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { PtyManager } from '@main/pty/pty-manager'
import * as pty from 'node-pty'

describe('PtyManager', () => {
  let manager: PtyManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new PtyManager()
  })

  describe('create', () => {
    it('returns a UUID and spawns pty', () => {
      const id = manager.create('/tmp')
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(pty.spawn).toHaveBeenCalledOnce()
    })

    it('passes custom command and args', () => {
      manager.create('/tmp', undefined, '/usr/bin/claude', ['--help'])
      expect(pty.spawn).toHaveBeenCalledWith(
        '/usr/bin/claude',
        ['--help'],
        expect.objectContaining({ cwd: '/tmp' })
      )
    })

    it('throws descriptive error when spawn fails', () => {
      vi.mocked(pty.spawn).mockImplementationOnce(() => {
        throw new Error('spawn ENOENT')
      })
      expect(() => manager.create('/tmp')).toThrow('Failed to create terminal')
    })
  })

  describe('write', () => {
    it('forwards data to pty process', () => {
      const id = manager.create('/tmp')
      manager.write(id, 'hello')
      expect(mockPtyProcess.write).toHaveBeenCalledWith('hello')
    })
  })

  describe('resize', () => {
    it('forwards resize to pty process', () => {
      const id = manager.create('/tmp')
      manager.resize(id, 80, 24)
      expect(mockPtyProcess.resize).toHaveBeenCalledWith(80, 24)
    })
  })

  describe('kill', () => {
    it('kills process and removes session', () => {
      const id = manager.create('/tmp')
      manager.kill(id)
      expect(mockPtyProcess.kill).toHaveBeenCalled()
    })
  })

  describe('killAll', () => {
    it('kills all sessions', () => {
      manager.create('/tmp')
      manager.create('/tmp')
      manager.killAll()
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(2)
    })
  })
})