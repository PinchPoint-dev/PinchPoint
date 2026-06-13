import { REST, Routes } from 'discord.js'
import type { Ctx } from '../lib/ctx'

export async function run(ctx: Ctx): Promise<string> {
  const entries = Object.entries(ctx.bots)
  if (entries.length === 0) return 'no bots.json found — run: pinchcord setup'
  const lines = await Promise.all(entries.map(async ([name, entry]) => {
    if (!entry.token) return `  ${name}: ✗ no token in bots.json`
    try {
      const rest = new REST({ version: '10' }).setToken(entry.token)
      const me = await rest.get(Routes.user('@me')) as { username: string }
      return `  ${name}: ✓ token ok (${me.username})${entry.channelId ? '' : ' — ⚠ no channelId'}`
    } catch (err) {
      return `  ${name}: ✗ ${err instanceof Error ? err.message : err}`
    }
  }))
  return ['fleet status (config/auth — see `pinchcord ps` for running sessions):', ...lines].join('\n')
}
