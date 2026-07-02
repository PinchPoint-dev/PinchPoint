import { readFileSync } from 'fs'

export interface BotEntry {
  token?: string
  channelId?: string
  runtime?: 'claude' | 'codex'
  appServerUrl?: string
}
export type BotsJson = Record<string, BotEntry>

export function loadBotsFrom(
  candidates: string[],
  read: (p: string) => string = p => readFileSync(p, 'utf8'),
  warn: (msg: string) => void = m => process.stderr.write(m + '\n'),
): BotsJson {
  for (const p of candidates) {
    let raw: string
    try { raw = read(p) } catch { continue } // missing file — try next candidate
    try { return JSON.parse(raw) as BotsJson } catch (err) {
      warn(`pinchcord: bots.json at ${p} is invalid JSON: ${err instanceof Error ? err.message : err}`)
    }
  }
  return {}
}

interface ResolveInput {
  flags: Record<string, unknown>
  env: Record<string, string | undefined>
  bots: BotsJson
  bot: string | undefined
}

export function botNameFromEnv(env: Record<string, string | undefined>): string | undefined {
  const name = env.CLAUDE_SESSION_NAME
  if (!name) return undefined
  return name.replace(/-discord$/, '')
}

export function resolveToken({ flags, env, bots, bot }: ResolveInput): string {
  const fromFlag = typeof flags.token === 'string' ? flags.token : undefined
  const fromEnv = env.DISCORD_BOT_TOKEN
  const fromBots = bot ? bots[bot]?.token : undefined
  const tok = fromFlag ?? fromEnv ?? fromBots
  if (!tok) throw new Error('no bot token: pass --token, set DISCORD_BOT_TOKEN, or add the bot to bots.json')
  return tok
}

export function resolveChannel({ flags, env, bots, bot }: ResolveInput): string {
  const fromFlag = typeof flags.channel === 'string' ? flags.channel : undefined
  const fromEnv = env.PINCHHUB_CHANNEL_ID
  const fromBots = bot ? bots[bot]?.channelId : undefined
  const chan = fromFlag ?? fromEnv ?? fromBots
  if (!chan) throw new Error('no channel: pass --channel, set PINCHHUB_CHANNEL_ID, or add channelId to bots.json')
  return chan
}
