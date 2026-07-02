#!/usr/bin/env bun
/**
 * PinchCord — Enhanced Discord channel for Claude Code bot fleets.
 *
 * Forked from the official Discord plugin (claude-plugins-official v0.0.4).
 * Adds modular enhancements for bot-to-bot communication, threads, and
 * attachments. Each module is optional — if a file is absent, that feature is
 * simply disabled and the plugin behaves like the official one.
 *
 * Modules:
 *   comms.ts        — Bot-to-bot delivery in hub channel + startup catch-up
 *   threads.ts      — Thread creation, routing, delivery
 *   attachments.ts  — Immediate download, image_path, cleanup
 *   diagnostics.ts  — Persistent log file
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type Attachment,
} from 'discord.js'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { INSTRUCTIONS } from './lib/instructions'
import { groupDelivers } from './lib/gateway-access'

// ---------------------------------------------------------------------------
// Optional module imports — each silently disabled if absent
// ---------------------------------------------------------------------------

type CommsModule = typeof import('./modules/comms')
type ThreadsModule = typeof import('./modules/threads')
type AttachmentsModule = typeof import('./modules/attachments')
type DiagnosticsModule = typeof import('./modules/diagnostics')

let comms: CommsModule | null = null
let threads: ThreadsModule | null = null
let attachmentsMod: AttachmentsModule | null = null
let diagnostics: DiagnosticsModule | null = null

async function loadModules(): Promise<void> {
  const failed: string[] = []
  const tryLoad = async <T>(name: string): Promise<T | null> => {
    try { return await import(`./modules/${name}`) as T }
    catch (err) {
      failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  comms = await tryLoad<CommsModule>('comms')
  threads = await tryLoad<ThreadsModule>('threads')
  attachmentsMod = await tryLoad<AttachmentsModule>('attachments')
  diagnostics = await tryLoad<DiagnosticsModule>('diagnostics')

  const loaded = [
    comms && 'comms', threads && 'threads',
    attachmentsMod && 'attachments', diagnostics && 'diagnostics',
  ].filter(Boolean)
  log(`pinchcord: modules loaded: ${loaded.length ? loaded.join(', ') : '(none — running as official)'}`)
  if (failed.length) {
    process.stderr.write(`pinchcord: modules FAILED to load:\n${failed.map(f => `  - ${f}`).join('\n')}\n`)
  }
}

// ---------------------------------------------------------------------------
// Logging — routes through diagnostics module if available
// ---------------------------------------------------------------------------

function log(msg: string): void {
  if (diagnostics?.log) {
    diagnostics.log(msg)
  } else {
    process.stderr.write(msg + '\n')
  }
}

// ---------------------------------------------------------------------------
// State & config (unchanged from official)
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      // CRLF files leave a \r on the value; hand-edited files may quote it.
      // Either one silently corrupts the token and auth fails downstream.
      let v = m[2].trim()
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1)
      process.env[m[1]] = v
    }
  }
} catch (err) {
  process.stderr.write(`pinchcord: .env load failed: ${err}\n`)
}

const TOKEN = process.env.DISCORD_BOT_TOKEN
const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write(
    `pinchcord: DISCORD_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: DISCORD_BOT_TOKEN=MTIz...\n`,
  )
  process.exit(1)
}

process.on('unhandledRejection', err => { log(`pinchcord: unhandled rejection: ${err}`) })
process.on('uncaughtException', err => { log(`pinchcord: uncaught exception: ${err}`) })

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// ---------------------------------------------------------------------------
// Access control (unchanged from official)
// ---------------------------------------------------------------------------

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch (renameErr) {
      process.stderr.write(`pinchcord: failed to rename corrupt access.json: ${renameErr}\n`)
    }
    log('pinchcord: access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        log('pinchcord: static mode — dmPolicy "pairing" downgraded to "allowlist"')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

async function gate(msg: Message): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  // isMentioned can hit the network (fetchReference) — only pay for it when
  // the policy actually gates on mentions.
  const mentioned = (policy.requireMention ?? true)
    ? await isMentioned(msg, access.mentionPatterns)
    : true
  // Shared decision lib — the same groups/requireMention/allowFrom semantics
  // the codex adapter applies (lib/gateway-access.ts, unit-tested).
  if (!groupDelivers(access, { channelId, senderId, mentioned })) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  const refId = msg.reference?.messageId
  if (refId) {
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch (err) {
      process.stderr.write(`pinchcord: fetchReference failed: ${err}\n`)
    }
  }

  const text = msg.content
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch (err) {
      process.stderr.write(`pinchcord: invalid mentionPattern "${pat}": ${err}\n`)
    }
  }
  return false
}

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try { dmChannelId = readFileSync(file, 'utf8').trim() }
    catch { rmSync(file, { force: true }); continue }
    if (!dmChannelId) { rmSync(file, { force: true }); continue }

    void (async () => {
      try {
        const ch = await fetchTextChannel(dmChannelId)
        if ('send' in ch) await ch.send("Paired! Say hi to Claude.")
        rmSync(file, { force: true })
      } catch (err) {
        log(`pinchcord: failed to send approval confirm: ${err}`)
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ---------------------------------------------------------------------------
// Message chunking (unchanged from official)
// ---------------------------------------------------------------------------

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) throw new Error(`channel ${id} not found or not text-based`)
  return ch
}

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'pinchcord', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: INSTRUCTIONS,
  },
)

// ---------------------------------------------------------------------------
// Tool definitions — NONE. Outbound actions (send/react/edit/fetch/download/
// thread) are handled by the `pinchcord` CLI. This MCP exists only to deliver
// inbound Discord messages to the bot via the claude/channel capability.
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))

// ---------------------------------------------------------------------------
// Module load — before mcp.connect() so inbound handling is fully wired when
// the first messages arrive. (No tools are registered; outbound is the CLI.)
// ---------------------------------------------------------------------------

await loadModules()

// ---------------------------------------------------------------------------
// MCP connect
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// Shutdown (unchanged from official)
// ---------------------------------------------------------------------------

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('pinchcord: shutting down')
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.on('error', err => { log(`pinchcord: client error: ${err}`) })

// ---------------------------------------------------------------------------
// Inbound message handler (MODIFIED for PinchCord)
// ---------------------------------------------------------------------------

client.on('messageCreate', msg => {
  // Self-echo suppression
  if (msg.author.id === client.user?.id) return

  // Bot-authored DMs are dropped outright — the DM branch of the gate could
  // only ever answer them with pairing-code spam. Guild bot messages fall
  // through: the hub is pre-authorized in handleInbound (comms), and any other
  // channel is judged by the access gate exactly like a human message — the
  // same groups/requireMention semantics the codex adapter already applies.
  // A mention-gated shared channel is the loop protection: a bot only hears
  // another bot there when explicitly addressed.
  if (msg.author.bot && msg.channel.type === ChannelType.DM) return

  // Realtime queue — if catch-up is still running, queue the message
  if (comms?.enqueueIfNeeded(msg)) return

  handleInbound(msg).catch(e => log(`pinchcord: handleInbound failed: ${e}`))
})

// Newest hub message already delivered (or reviewed at catch-up). Guards
// against double-delivery when a message lands both in the catch-up fetch and
// the realtime queue, and against re-delivering old messages after a restart.
let watermark: string | null = null

// Newest hub message PERSISTED to disk. The in-memory watermark advances
// before delivery (dedup); disk advances only once a message is fully handled
// — delivered to Claude, or deliberately gated/paired. Persisting earlier
// loses the message forever if the process dies before the notification
// lands: the restart catch-up would see the watermark already past it.
let persisted: string | null = null

function persistWatermark(id: string): void {
  // Monotonic — concurrent handlers finishing out of order must never move
  // the on-disk watermark backwards.
  if (!comms || !comms.isNewerSnowflake(id, persisted)) return
  persisted = id
  comms.saveLastSeen(STATE_DIR, id)
}

// Returns true when the message was fully handled (delivered, or deliberately
// dropped/paired) — false when delivery to Claude failed, so callers can
// avoid advancing the on-disk watermark past a lost message.
async function handleInbound(msg: Message): Promise<boolean> {
  // Watermark applies to hub top-level messages only — thread/DM snowflakes
  // are not ordered against the hub catch-up window.
  const isHubMain = comms?.isHubMainMessage(msg) ?? false
  if (isHubMain) {
    if (!comms!.isNewerSnowflake(msg.id, watermark)) return true // duplicate — already handled
    watermark = msg.id
  }

  // Bot messages in the hub channel skip the gate — they're pre-authorized by comms.ts
  const isBotInHub = msg.author.bot && comms?.shouldDeliverBotMessage(msg)
  let accessResult: Access | undefined

  if (!isBotInHub) {
    const result = await gate(msg)
    if (result.action === 'drop') {
      if (isHubMain) persistWatermark(msg.id) // deliberately dropped = handled
      return true
    }

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      try {
        await msg.reply(`${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`)
      } catch (err) { log(`pinchcord: failed to send pairing code: ${err}`) }
      if (isHubMain) persistWatermark(msg.id)
      return true
    }
    accessResult = result.access
  }

  const chat_id = msg.channelId

  // Typing indicator (only for human messages)
  if (!msg.author.bot && 'sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {}) // intentionally silent — typing indicator is cosmetic
  }

  // Ack reaction
  if (accessResult?.ackReaction) {
    void msg.react(accessResult.ackReaction).catch(err => process.stderr.write(`pinchcord: ack react failed: ${err}\n`))
  }

  // PinchCord: download attachments immediately if module is loaded
  const downloads = attachmentsMod ? await attachmentsMod.downloadOnReceipt(msg) : []

  // Attachments — build summary strings for notification
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  // Build notification metadata
  const meta: Record<string, string> = {
    chat_id,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    // PinchCord: bot attribute from comms module
    ...(comms?.botMeta(msg, client.user?.id) ?? {}),
    // PinchCord: thread_id and reply_to from threads module
    ...(threads?.getThreadMeta(msg) ?? {}),
    // PinchCord: downloaded attachment paths and image_path from attachments module
    ...(attachmentsMod ? attachmentsMod.getAttachmentMeta(downloads) : {}),
  }

  // Awaited: the on-disk watermark must not advance past a message Claude
  // never received. On failure the message is redelivered by the next
  // startup catch-up (at-most-once within a session, recovered on restart).
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    })
  } catch (err) {
    log(`pinchcord: failed to deliver inbound to Claude: ${err}`)
    return false
  }
  if (isHubMain) persistWatermark(msg.id)
  return true
}

// ---------------------------------------------------------------------------
// Gateway ready + startup catch-up
// ---------------------------------------------------------------------------

client.once('ready', async c => {
  log(`pinchcord: gateway connected as ${c.user.tag}`)

  // Startup catch-up: deliver hub messages newer than the persisted watermark.
  // First run (no watermark) skips the backlog entirely — a brand-new bot
  // should not replay 20 messages of stale history — and just records the
  // newest id so the next restart resumes from here.
  if (comms) {
    const lastSeen = comms.loadLastSeen(STATE_DIR)
    const reviewed = await comms.fetchStartupMessages(client, 20)
    const newest = reviewed[reviewed.length - 1]
    let delivered = 0
    let failures = 0
    if (lastSeen !== null) {
      watermark = lastSeen
      persisted = lastSeen
      for (const msg of reviewed) {
        if (!comms.isNewerSnowflake(msg.id, lastSeen)) continue
        if (msg.author.id === client.user?.id) continue
        if (msg.author.bot && !comms.shouldDeliverBotMessage(msg)) continue
        delivered++
        const ok = await handleInbound(msg).catch(e => { log(`pinchcord: catch-up message failed: ${e}`); return false })
        if (!ok) failures++
      }
    }
    // Advance past everything reviewed — a re-review after restart would
    // gate/skip them identically, so replaying is pure noise. But only when
    // every delivery landed: a failed one must stay behind the watermark so
    // the next restart retries it (handleInbound persists per-message, so a
    // failure holds the disk watermark just before the lost message).
    if (newest && comms.isNewerSnowflake(newest.id, watermark)) {
      watermark = newest.id
      if (failures === 0) persistWatermark(newest.id)
    }
    await comms.finishCatchUp(handleInbound)
    log(`pinchcord: catch-up complete (${reviewed.length} reviewed, ${delivered} delivered${failures ? `, ${failures} FAILED — held back for retry` : ''}${lastSeen === null ? ', first run — backlog skipped' : ''})`)
  }

  // Initialize other modules that need the client
  if (threads?.init) threads.init(client)
  // PinchCord: start attachment cleanup timer (removes files older than 1 hour every 15 min)
  if (attachmentsMod?.startCleanup) attachmentsMod.startCleanup()
})

client.login(TOKEN).catch(err => {
  log(`pinchcord: login failed: ${err}`)
  process.exit(1)
})
