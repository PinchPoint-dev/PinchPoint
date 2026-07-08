#!/usr/bin/env bun
import { REST } from 'discord.js'
import { homedir } from 'os'
import { join } from 'path'
import { parseArgs } from './lib/args'
import { resolveToken, resolveChannel, botNameFromEnv, loadBotsFrom, type BotsJson } from './lib/config'
import { describeError } from './lib/errors'
import pkg from './package.json'

export function botsJsonCandidates(): string[] {
  return [
    process.env.PINCHCORD_BOTS_JSON,
    join(process.cwd(), '.pinchme', 'cord', 'bots.json'),
    join(homedir(), '.pinchme', 'cord', 'bots.json'),
  ].filter(Boolean) as string[]
}

function loadBots(): BotsJson {
  return loadBotsFrom(botsJsonCandidates())
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

// What each command needs resolved before dispatch. Fleet/diagnostic commands
// resolve nothing — they must work (and explain) when config is broken.
const NEEDS: Record<string, { token: boolean; channel: boolean }> = {
  send: { token: true, channel: true },
  react: { token: true, channel: true },
  edit: { token: true, channel: true },
  fetch: { token: true, channel: true },
  download: { token: true, channel: true },
  thread: { token: true, channel: true },
  delete: { token: true, channel: true },
  whoami: { token: true, channel: false },
  doctor: { token: false, channel: false },
  setup: { token: false, channel: false },
  status: { token: false, channel: false },
  launch: { token: false, channel: false },
  stop: { token: false, channel: false },
  restart: { token: false, channel: false },
  ps: { token: false, channel: false },
  view: { token: false, channel: false },
}

const USAGE = `pinchcord — outbound Discord for bot fleets

Usage:
  pinchcord send [text] [--channel ID] [--reply-to MID] [--file PATH ...]
  pinchcord react <message_id> <emoji> [--channel ID]
  pinchcord edit <message_id> <text> [--channel ID]
  pinchcord fetch [--channel ID] [--limit N] [--before MID] [--full] [--json]
  pinchcord download <message_id> [--channel ID] [--out DIR]
  pinchcord thread create <message_id> <name> [--channel ID]
  pinchcord thread send <thread_id> <text>
  pinchcord delete <message_id> [--channel ID]
  pinchcord whoami
  pinchcord doctor [--bot NAME]
  pinchcord setup
  pinchcord status
  pinchcord launch [bots...] [--mode wsl|wt|mac] [--detach]   (default: wsl; one tmux session + visible tab per bot)
  pinchcord stop <bot|--all> [--mode ...]
  pinchcord restart <bot> [--mode ...]
  pinchcord ps [--mode ...]
  pinchcord view <bot> [--mode wsl|mac] [--detach]           (codex bots: open a live codex TUI attached to the bot's thread)

Token:   --token | $DISCORD_BOT_TOKEN | bots.json[bot].token
Channel: --channel | $PINCHHUB_CHANNEL_ID | bots.json[bot].channelId
Bot:     --bot | $CLAUDE_SESSION_NAME (minus -discord)
Emoji:   unicode works directly; custom emoji need the name:id form`

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.command || parsed.command === 'help' || parsed.flags.help) {
    console.log(USAGE)
    process.exit(0)
  }
  // argv[0] is always parsed as the command, so a bare `--version` lands there.
  if (parsed.command === 'version' || parsed.command === '--version' || parsed.flags.version) {
    console.log(`pinchcord ${pkg.version}`)
    process.exit(0)
  }
  const env = process.env as Record<string, string | undefined>
  const bots = loadBots()
  const bot = (typeof parsed.flags.bot === 'string' ? parsed.flags.bot : undefined) ?? botNameFromEnv(env)
  const needs = NEEDS[parsed.command]
  if (!needs) {
    console.error(`unknown command: ${parsed.command}\n\n${USAGE}`)
    process.exit(2)
  }
  const token = needs.token ? resolveToken({ flags: parsed.flags, env, bots, bot }) : ''
  const rest = new REST({ version: '10' }).setToken(token || 'unset')
  const needsChannel = needs.channel && !(parsed.command === 'thread' && parsed.sub === 'send')
  const channelId = needsChannel ? resolveChannel({ flags: parsed.flags, env, bots, bot }) : ''
  const wantsStdin =
    (parsed.command === 'send' && !parsed.positionals[0]) ||
    (parsed.command === 'edit' && parsed.positionals.length === 1) ||
    (parsed.command === 'thread' && parsed.sub === 'send' && parsed.positionals.length === 1)
  const stdin = wantsStdin ? await readStdin() : ''

  const ctx = {
    rest,
    channelId,
    positionals: parsed.positionals,
    flags: parsed.flags,
    stdin,
    sub: parsed.sub,
    bots,
    bot,
  }

  let result: string
  switch (parsed.command) {
    case 'send':     result = await (await import('./commands/send')).run(ctx); break
    case 'react':    result = await (await import('./commands/react')).run(ctx); break
    case 'edit':     result = await (await import('./commands/edit')).run(ctx); break
    case 'fetch':    result = await (await import('./commands/fetch')).run(ctx); break
    case 'download': result = await (await import('./commands/download')).run(ctx); break
    case 'thread':   result = await (await import('./commands/thread')).run(ctx); break
    case 'delete':   result = await (await import('./commands/delete')).run(ctx); break
    case 'whoami':   result = await (await import('./commands/whoami')).run(ctx); break
    case 'doctor':   result = await (await import('./commands/doctor')).run(ctx); break
    case 'setup':    result = await (await import('./commands/setup')).run(ctx); break
    case 'status':   result = await (await import('./commands/status')).run(ctx); break
    case 'launch':   result = await (await import('./commands/launch')).run(ctx); break
    case 'ps':       result = await (await import('./commands/ps')).run(ctx); break
    case 'view':     result = await (await import('./commands/view')).run(ctx); break
    case 'stop':     result = await (await import('./commands/stop')).run(ctx); break
    case 'restart': {
      const stopped = await (await import('./commands/stop')).run(ctx)
      await Bun.sleep(1500)
      const launched = await (await import('./commands/launch')).run(ctx)
      result = `${stopped}\n${launched}`
      break
    }
    default:
      console.error(`unknown command: ${parsed.command}\n\n${USAGE}`)
      process.exit(2)
  }
  console.log(result)
}

main().catch(err => {
  console.error(`pinchcord: ${describeError(err)}`)
  process.exit(1)
})
