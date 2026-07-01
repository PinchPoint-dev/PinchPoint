import { Routes } from 'discord.js'
import type { Ctx } from '../lib/ctx'

export async function run(ctx: Ctx): Promise<string> {
  const [messageId] = ctx.positionals
  if (!messageId) throw new Error('delete: usage: delete <message_id>')
  await ctx.rest.delete(Routes.channelMessage(ctx.channelId, messageId))
  return 'deleted'
}
