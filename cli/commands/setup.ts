import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { Ctx } from '../lib/ctx'
import { defaultAccess, ensureHubPolicy, type AccessShape } from '../lib/access'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')
const SERVER_PATH = join(import.meta.dir, '..', 'server.ts')
const fwd = (p: string) => p.replace(/\\/g, '/')

// The bun that ran setup IS the bun the artifacts should use. Run setup from
// Windows → bakes the Windows bun + C:/ paths (correct for --mode wt). Run it
// inside WSL under native bun → bakes ~/.bun/bin/bun + /mnt/c paths (correct for
// --mode wsl). This sidesteps PATH-shadowing where a Windows `bun` shim sits
// ahead of the native one in a WSL shell, which would otherwise break the
// MCP-server spawn and the CLI shim for the native-Linux fleet.
const BUN = fwd(process.execPath)

// Per-bot state dir: each bot gets its own gateway state, .env and inbox so
// six bots on one machine never collide on access.json or attachments.
export function stateDirFor(bot: string): string {
  return join(homedir(), '.claude', 'channels', `discord-${bot.toLowerCase()}`)
}

// wt mode (Windows claude) and wsl/mac mode (native claude) need different
// bun + server paths, and each mode's setup runs under its own bun — so each
// writes its own file. A single shared mcp-config.json meant a Windows setup
// silently broke the WSL fleet's next boot, and vice versa.
export function mcpConfigName(): string {
  return platform() === 'win32' ? 'mcp-config.json' : 'mcp-config.posix.json'
}

export async function run(ctx: Ctx): Promise<string> {
  const out: string[] = ['pinchcord setup']
  const bots = Object.entries(ctx.bots)
  if (bots.length === 0) {
    const p = join(process.cwd(), '.pinchme', 'cord', 'bots.json')
    mkdirSync(join(process.cwd(), '.pinchme', 'cord'), { recursive: true })
    if (!existsSync(p)) {
      writeFileSync(p, JSON.stringify({ MyBot: { token: 'PASTE_TOKEN', channelId: 'PASTE_HUB_CHANNEL_ID', workDir: process.cwd(), promptFile: '', effort: 'high' } }, null, 2), { mode: 0o600 })
      out.push(`  wrote template ${p} — fill in token/channelId, then re-run setup`)
    }
    return out.join('\n')
  }

  // 1. Per-bot state dir + .env + access.json
  for (const [name, entry] of bots) {
    const dir = stateDirFor(name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const envFile = join(dir, '.env')
    if (entry.token) {
      writeFileSync(envFile, `DISCORD_BOT_TOKEN=${entry.token}\nPINCHHUB_CHANNEL_ID=${entry.channelId ?? ''}\n`, { mode: 0o600 })
      try { chmodSync(envFile, 0o600) } catch {}
    }
    const accessFile = join(dir, 'access.json')
    if (entry.channelId) {
      if (!existsSync(accessFile)) {
        // Hub channel delivers everything (no mention gate); DMs allowlist-only.
        writeFileSync(accessFile, JSON.stringify(defaultAccess(entry.channelId), null, 2) + '\n', { mode: 0o600 })
      } else {
        // Repair the old mention-gated default in place; preserve customizations.
        try {
          const parsed = JSON.parse(readFileSync(accessFile, 'utf8')) as AccessShape
          const { access, changed } = ensureHubPolicy(parsed, entry.channelId)
          if (changed) {
            writeFileSync(accessFile, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
            out.push(`  ✓ ${name}: access.json hub policy migrated (requireMention → false)`)
          }
        } catch {
          out.push(`  ⚠ ${name}: access.json unreadable — left untouched`)
        }
      }
    }
    out.push(`  ✓ ${name}: state dir ${dir} (.env + access.json)`)
  }

  // 2. Strict MCP config (absolute forward-slash path — valid JSON on Windows too)
  const cordDir = join(process.cwd(), '.pinchme', 'cord')
  mkdirSync(cordDir, { recursive: true })
  const mcpCfg = join(cordDir, mcpConfigName())
  writeFileSync(mcpCfg, JSON.stringify({
    mcpServers: { 'pinchcord-slim': { command: BUN, args: [fwd(SERVER_PATH)] } },
  }, null, 2) + '\n')
  out.push(`  ✓ ${mcpConfigName()} → ${mcpCfg}`)

  // 3. PATH shim(s)
  const binDir = join(homedir(), '.local', 'bin')
  mkdirSync(binDir, { recursive: true })
  const shim = join(binDir, 'pinchcord')
  writeFileSync(shim, `#!/bin/sh\nexec "${BUN}" "${fwd(CLI_PATH)}" "$@"\n`, { mode: 0o755 })
  out.push(`  ✓ POSIX shim → ${shim}`)
  if (platform() === 'win32') {
    const cmdShim = join(binDir, 'pinchcord.cmd')
    writeFileSync(cmdShim, `@echo off\r\n"${process.execPath}" "${CLI_PATH}" %*\r\n`)
    out.push(`  ✓ cmd shim → ${cmdShim}`)
  }

  out.push('done — run: pinchcord doctor --bot <Name>')
  return out.join('\n')
}
