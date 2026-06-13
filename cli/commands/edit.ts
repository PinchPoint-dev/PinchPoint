import { Routes } from 'discord.js'
import type { Ctx } from '../lib/ctx'

export async function run(ctx: Ctx): Promise<string> {
  const [messageId, ...rest] = ctx.positionals
  const text = rest.length ? rest.join(' ') : ctx.stdin
  if (!messageId || !text) throw new Error('edit: usage: edit <message_id> <text> (or pipe text via stdin)')
  if (text.length > 2000) {
    throw new Error(`edit: new text is ${text.length} chars — Discord caps a message at 2000; an edit cannot split. Send a new message instead.`)
  }
  const res = await ctx.rest.patch(Routes.channelMessage(ctx.channelId, messageId), { body: { content: text } }) as { id: string }
  return `edited (id: ${res.id})`
}
