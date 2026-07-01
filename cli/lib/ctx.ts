import type { REST } from 'discord.js'
import type { BotsJson } from './config'

export interface Ctx {
  rest: REST
  channelId: string
  positionals: string[]
  flags: Record<string, unknown>
  stdin: string
  sub?: string
  bots: BotsJson
  bot?: string
}
