import { Routes } from 'discord.js'
import type { Ctx } from '../lib/ctx'

export async function run(ctx: Ctx): Promise<string> {
  const [messageId, emoji] = ctx.positionals
  if (!messageId || !emoji) throw new Error('react: usage: react <message_id> <emoji>')
  await ctx.rest.put(Routes.channelMessageOwnReaction(ctx.channelId, messageId, encodeURIComponent(emoji)))
  return 'reacted'
}
