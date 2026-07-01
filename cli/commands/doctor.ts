import { REST, Routes } from 'discord.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Ctx } from '../lib/ctx'
import { resolveToken, resolveChannel } from '../lib/config'
import { mcpConfigName } from './setup'

// Each check prints ✓/✗ and never throws — doctor's job is to explain broken
// config, so it must survive it. Exit code 1 if anything failed.
export async function run(ctx: Ctx): Promise<string> {
  const out: string[] = ['pinchcord doctor']
  let failed = 0
  const ok = (s: string) => out.push(`  ✓ ${s}`)
  const bad = (s: string) => { failed++; out.push(`  ✗ ${s}`) }
  const env = process.env as Record<string, string | undefined>

  // 1. bots.json
  const botNames = Object.keys(ctx.bots)
  botNames.length > 0
    ? ok(`bots.json loaded (${botNames.length} bots: ${botNames.join(', ')})`)
    : bad('no bots.json found (PINCHCORD_BOTS_JSON, ./.pinchme/cord/bots.json, ~/.pinchme/cord/bots.json) and no env fallback for fleet commands')

  // 2. token + identity (uses normal resolution; --bot selects which entry)
  let token = ''
  try {
    token = resolveToken({ flags: ctx.flags, env, bots: ctx.bots, bot: ctx.bot })
    const rest = new REST({ version: '10' }).setToken(token)
    const me = await rest.get(Routes.user('@me')) as { username: string; id: string }
    ok(`token valid — authenticated as ${me.username} (id: ${me.id})`)

    // 3. channel reachable + readable
    try {
      const channelId = resolveChannel({ flags: ctx.flags, env, bots: ctx.bots, bot: ctx.bot })
      const ch = await rest.get(Routes.channel(channelId)) as { name?: string; id: string }
      ok(`channel reachable — #${ch.name ?? ch.id}`)
      await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '1' }) })
      ok('channel history readable')
    } catch (err) {
      bad(`channel check failed: ${err instanceof Error ? err.message : err}`)
    }
  } catch (err) {
    bad(`token check failed: ${err instanceof Error ? err.message : err}`)
  }

  // 4. dual-MCP hazard
  if (existsSync(join(process.cwd(), '.pinchpoint', 'server.ts'))) {
    ok('production PinchCord plugin present in workspace — REMINDER: launch must use --strict-mcp-config (pinchcord launch does)')
  }
  const cfgName = mcpConfigName()
  const mcpCfg = join(process.cwd(), '.pinchme', 'cord', cfgName)
  if (existsSync(mcpCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpCfg, 'utf8')) as { mcpServers?: Record<string, { args?: string[] }> }
      const names = Object.keys(cfg.mcpServers ?? {})
      if (names.length === 1 && names[0] === 'pinchcord-slim') {
        const serverPath = cfg.mcpServers!['pinchcord-slim'].args?.find(a => a.endsWith('server.ts'))
        serverPath && existsSync(serverPath)
          ? ok(`${cfgName} valid (server: ${serverPath})`)
          : bad(`${cfgName} points at missing server file: ${serverPath}`)
      } else {
        bad(`${cfgName} must register exactly [pinchcord-slim], found [${names.join(', ')}]`)
      }
    } catch (err) {
      bad(`${cfgName} unreadable: ${err instanceof Error ? err.message : err}`)
    }
  } else {
    bad(`no ${cfgName} at ${mcpCfg} — run: pinchcord setup`)
  }

  // 5. PATH
  Bun.which('pinchcord')
    ? ok(`pinchcord on PATH (${Bun.which('pinchcord')})`)
    : bad('pinchcord not on PATH — bots cannot call it; run: pinchcord setup')

  out.push(failed === 0 ? 'all checks passed' : `${failed} check(s) FAILED`)
  if (failed > 0) process.exitCode = 1
  return out.join('\n')
}
