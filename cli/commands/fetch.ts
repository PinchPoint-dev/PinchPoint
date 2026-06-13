import { Routes } from 'discord.js'
import type { Ctx } from '../lib/ctx'

interface ApiMessage {
  id: string
  content: string
  author: { username: string; id: string }
  timestamp: string
  attachments: { filename: string }[]
}

const PREVIEW = 300

export async function run(ctx: Ctx): Promise<string> {
  const limit = Math.min(Number(ctx.flags.limit ?? 20) || 20, 100)
  const query = new URLSearchParams({ limit: String(limit) })
  if (typeof ctx.flags.before === 'string') query.set('before', ctx.flags.before)
  const msgs = await ctx.rest.get(Routes.channelMessages(ctx.channelId), { query }) as ApiMessage[]
  const arr = [...msgs].reverse() // API returns newest-first; show oldest-first
  if (ctx.flags.json) return JSON.stringify(arr, null, 2)
  if (arr.length === 0) return '(no messages)'
  const full = Boolean(ctx.flags.full)
  const lines = arr.map(m => {
    const atts = m.attachments.length > 0 ? ` +${m.attachments.length}att` : ''
    const flat = m.content.replace(/[\r\n]+/g, ' ⏎ ')
    const text = full || flat.length <= PREVIEW
      ? flat
      : `${flat.slice(0, PREVIEW)}… [+${flat.length - PREVIEW} chars — use --full]`
    return `[${m.timestamp}] ${m.author.username}: ${text}  (id: ${m.id}${atts})`
  })
  if (arr.length === limit) lines.push(`(older: pinchcord fetch --before ${arr[0].id})`)
  return lines.join('\n')
}
