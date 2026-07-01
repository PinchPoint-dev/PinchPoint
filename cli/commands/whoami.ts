import { Routes } from 'discord.js'
import type { Ctx } from '../lib/ctx'

export async function run(ctx: Ctx): Promise<string> {
  // Routes.user() defaults to @me without URI-encoding ('@me' as an arg becomes %40me).
  const me = await ctx.rest.get(Routes.user()) as { id: string; username: string }
  return `${me.username} (id: ${me.id})`
}
