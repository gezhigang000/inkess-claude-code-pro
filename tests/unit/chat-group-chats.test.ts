import { describe, it, expect } from 'vitest'
import { groupChats } from '../../src/renderer/views/chat/sidebar/groupChats'
import type { ChatMeta } from '../../src/main/chat/chat-types'

function chat(id: string, updatedAt: number): ChatMeta {
  return {
    id, title: id, createdAt: updatedAt, updatedAt,
    cwd: `/tmp/${id}`, mountedDirs: [], claudeSessionId: null,
    cliVersion: '1', messageCount: 0, starred: false,
  }
}

describe('groupChats', () => {
  const NOW = new Date('2026-04-22T10:00:00Z').getTime()

  it('buckets chats into Today / Yesterday / Last 7 days / Older', () => {
    const chats = [
      chat('today',      NOW - 2 * 60 * 60 * 1000),             // 2h ago → Today
      chat('yesterday',  NOW - 26 * 60 * 60 * 1000),            // 26h ago → Yesterday
      chat('3-days',     NOW - 3 * 24 * 60 * 60 * 1000),        // 3d ago → Last 7 days
      chat('10-days',    NOW - 10 * 24 * 60 * 60 * 1000),       // 10d ago → Older
    ]
    const out = groupChats(chats, NOW)
    expect(out.map(g => g.key)).toEqual(['today', 'yesterday', 'last7', 'older'])
    expect(out[0].chats.map(c => c.id)).toEqual(['today'])
    expect(out[1].chats.map(c => c.id)).toEqual(['yesterday'])
    expect(out[2].chats.map(c => c.id)).toEqual(['3-days'])
    expect(out[3].chats.map(c => c.id)).toEqual(['10-days'])
  })

  it('sorts chats within each group newest first', () => {
    const chats = [
      chat('a', NOW - 1 * 60 * 60 * 1000),
      chat('b', NOW - 3 * 60 * 60 * 1000),
      chat('c', NOW - 2 * 60 * 60 * 1000),
    ]
    const out = groupChats(chats, NOW)
    expect(out[0].chats.map(c => c.id)).toEqual(['a', 'c', 'b'])
  })

  it('omits empty groups', () => {
    const chats = [chat('only-today', NOW - 60 * 1000)]
    const out = groupChats(chats, NOW)
    expect(out.map(g => g.key)).toEqual(['today'])
  })

  it('treats midnight-crossings by calendar day, not 24h window', () => {
    // A chat at 23:59 yesterday and another at 00:30 today should go into
    // different groups even though they're <1h apart.
    // Use local-time Date construction so the test is timezone-agnostic
    // (startOfDay uses local time; UTC timestamps collapse to the same local day
    // in some zones).
    const now = new Date(2026, 3, 22, 1, 0, 0).getTime()         // Apr 22 01:00 local
    const chats = [
      chat('late-yesterday', new Date(2026, 3, 21, 23, 59).getTime()),
      chat('early-today',    new Date(2026, 3, 22, 0, 30).getTime()),
    ]
    const out = groupChats(chats, now)
    const keys = out.map(g => g.key)
    expect(keys).toContain('today')
    expect(keys).toContain('yesterday')
    const today = out.find(g => g.key === 'today')!
    const yesterday = out.find(g => g.key === 'yesterday')!
    expect(today.chats.map(c => c.id)).toEqual(['early-today'])
    expect(yesterday.chats.map(c => c.id)).toEqual(['late-yesterday'])
  })
})
