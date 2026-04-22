import type { ChatMeta } from '../../../../main/chat/chat-types'

export type GroupKey = 'today' | 'yesterday' | 'last7' | 'older'

export interface ChatGroup {
  key: GroupKey
  label: string          // intentionally not i18n yet — wire to useI18n in a later pass
  chats: ChatMeta[]
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function groupChats(chats: ChatMeta[], now: number = Date.now()): ChatGroup[] {
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - MS_PER_DAY
  const last7Start = todayStart - 7 * MS_PER_DAY

  const buckets: Record<GroupKey, ChatMeta[]> = {
    today: [],
    yesterday: [],
    last7: [],
    older: [],
  }

  for (const c of chats) {
    if (c.updatedAt >= todayStart) buckets.today.push(c)
    else if (c.updatedAt >= yesterdayStart) buckets.yesterday.push(c)
    else if (c.updatedAt >= last7Start) buckets.last7.push(c)
    else buckets.older.push(c)
  }

  const order: Array<{ key: GroupKey; label: string }> = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'last7', label: 'Last 7 days' },
    { key: 'older', label: 'Older' },
  ]

  return order
    .filter(({ key }) => buckets[key].length > 0)
    .map(({ key, label }) => ({
      key,
      label,
      chats: buckets[key].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
}
