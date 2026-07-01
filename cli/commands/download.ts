import { Routes } from 'discord.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Ctx } from '../lib/ctx'

interface ApiMessage {
  attachments: { id: string; filename: string; url: string; size: number }[]
}

export async function run(ctx: Ctx): Promise<string> {
  const [messageId] = ctx.positionals
  if (!messageId) throw new Error('download: usage: download <message_id>')
  const outDir = typeof ctx.flags.out === 'string' ? ctx.flags.out as string : join(process.cwd(), 'pinchcord-inbox')
  const msg = await ctx.rest.get(Routes.channelMessage(ctx.channelId, messageId)) as ApiMessage
  if (msg.attachments.length === 0) return 'message has no attachments'
  mkdirSync(outDir, { recursive: true })
  const saved: string[] = []
  for (const att of msg.attachments) {
    // Same Discord-CDN origin guard as modules/attachments.ts (SSRF protection)
    const parsed = new URL(att.url)
    if (parsed.protocol !== 'https:' || (!parsed.hostname.endsWith('.discord.com') && !parsed.hostname.endsWith('.discordapp.com') && !parsed.hostname.endsWith('.discordapp.net'))) {
      throw new Error(`download: attachment URL has unexpected origin: ${att.url}`)
    }
    const resp = await fetch(att.url)
    if (!resp.ok) throw new Error(`download failed for ${att.filename}: ${resp.status}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    const safe = att.filename.replace(/[\\/\r\n]/g, '_')
    const path = join(outDir, `${att.id}-${safe}`)
    writeFileSync(path, buf)
    saved.push(`  ${path}  (${(att.size / 1024).toFixed(0)}KB)`)
  }
  return `downloaded ${saved.length} attachment(s):\n${saved.join('\n')}`
}
