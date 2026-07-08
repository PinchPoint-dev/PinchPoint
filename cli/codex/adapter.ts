#!/usr/bin/env bun
// Codex runtime adapter for the pinchcord fleet.
//
// A Claude bot's Discord connection is the slim MCP gateway (server.ts). A
// Codex bot has no such gateway: this adapter IS its Discord connection — its
// own discord.js client bridged to a local Codex app-server over JSON-RPC on a
// WebSocket. `pinchcord launch` builds the tmux window around this file when a
// bots.json entry sets `runtime: "codex"`.
//
// Inbound: Discord message → access.json filter (same group/requireMention
// semantics as the gateway) → injected as a Codex turn. Outbound: the Codex
// agent replies by calling the `pinchcord` CLI itself (like Claude bots do) —
// this adapter never posts message content, only the typing indicator.
//
// Env (exported by `pinchcord launch` from the per-bot state dir + bots.json):
//   DISCORD_BOT_TOKEN        (from state-dir .env)   — required
//   PINCHHUB_CHANNEL_ID      (from state-dir .env)   — hub/home channel
//   DISCORD_STATE_DIR        — dir holding access.json (re-read every message)
//   CODEX_BOT_NAME           — display name / session name
//   CODEX_WORK_DIR           — cwd for the Codex thread
//   CODEX_PROMPT_FILE        — system prompt (baseInstructions)
//   CODEX_MODEL              — Codex model id (default gpt-5.5)
//   CODEX_REASONING_EFFORT   — reasoning effort per turn (default high)
//   CODEX_APP_SERVER_URL     — app-server ws url (default ws://127.0.0.1:3848)
import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'
import { readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { groupDelivers, fallbackAccess, type GatewayAccess } from '../lib/gateway-access'

// ─── Config ───

const BOT_NAME = process.env.CODEX_BOT_NAME || 'Codex'
const BOT_NAME_LOWER = BOT_NAME.toLowerCase()
const HUB_CHANNEL_ID = process.env.PINCHHUB_CHANNEL_ID || ''
const TOKEN = process.env.DISCORD_BOT_TOKEN
const STATE_DIR = process.env.DISCORD_STATE_DIR || ''
const WORK_DIR = process.env.CODEX_WORK_DIR || process.cwd()
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:3848'
const PROMPT_FILE = process.env.CODEX_PROMPT_FILE || ''
const MODEL = process.env.CODEX_MODEL || 'gpt-5.5'
// Reasoning effort, passed per turn (turn/start `effort`). Defaults high so the
// bots think hard by default without depending on ~/.codex/config.toml, which a
// codex login switch can wipe. Override per-bot via bots.json `effort`.
const EFFORT = process.env.CODEX_REASONING_EFFORT || 'high'
// RPC acks (initialize, thread/start, the turn/start acknowledgement) come back
// in seconds — a short ceiling still catches a dead app-server fast.
const RPC_TIMEOUT = Number(process.env.CODEX_RPC_TIMEOUT_MS) || 120_000 // 2 min
// A TURN runs until the bot finishes its whole task. Image-generation rounds
// legitimately run 15-30 min (~1m42s per image), so the old 3-min ceiling
// declared real work "timed out" and orphaned the still-running turn, spamming
// errors and colliding with the next queued turn. Size it to the real workload;
// terminal codex errors (below) release the turn early so a genuine hang does
// not wait this out. Override with CODEX_TURN_TIMEOUT_MS.
const TURN_TIMEOUT = Number(process.env.CODEX_TURN_TIMEOUT_MS) || 1_800_000 // 30 min
const CONTEXT_MESSAGES = 40 // messages to inject on the first turn per channel
const RESET_PHRASES = [`${BOT_NAME_LOWER} reset`, `${BOT_NAME_LOWER} fresh start`, `${BOT_NAME_LOWER} new session`]
const RESET_MAX_LEN = 30

if (!TOKEN) {
  console.error(`[${BOT_NAME}] DISCORD_BOT_TOKEN is required`)
  process.exit(1)
}

const SYSTEM_PROMPT = PROMPT_FILE ? readFileSync(PROMPT_FILE, 'utf-8') : ''
const ACCESS_FILE = STATE_DIR ? join(STATE_DIR, 'access.json') : ''
// Live channel→thread map, published so `pinchcord view <bot>` can attach a
// codex TUI to the same thread the adapter drives. 0600 — attaching to a thread
// lets a client drive the bot, so the file is treated as a capability.
const THREADS_FILE = STATE_DIR ? join(STATE_DIR, 'threads.json') : ''

// ─── Logging ───

function log(level: string, msg: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(11, 19)
  const prefix = `[${ts}] [${BOT_NAME}] [${level}]`
  if (data !== undefined) {
    console.log(`${prefix} ${msg}`, typeof data === 'string' ? data : JSON.stringify(data))
  } else {
    console.log(`${prefix} ${msg}`)
  }
}

// Windows Terminal per-tab progress glyph (OSC 9;4) — restores the little
// "busy" indicator on this bot's tab while a turn is running, cleared when it
// finishes. Under tmux the OSC must be wrapped in DCS passthrough to reach the
// outer terminal (requires `allow-passthrough on` on the tmux server).
function setTabProgress(active: boolean): void {
  if (!process.stdout.isTTY && !process.env.TMUX) return
  const seq = active ? '\x1b]9;4;3;0\x07' : '\x1b]9;4;0;0\x07' // 3=indeterminate, 0=clear
  process.stdout.write(
    process.env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : seq,
  )
}

// ─── Access filtering (re-read every message; no restart needed) ───

// Read access.json fresh each call so `pinchcord` access edits take effect
// live — matching the gateway, which re-reads on every message. Falls back to
// "hub channel, no mention gate" when the file is missing or unreadable.
function loadAccess(): GatewayAccess {
  if (ACCESS_FILE) {
    try {
      return JSON.parse(readFileSync(ACCESS_FILE, 'utf-8')) as GatewayAccess
    } catch {
      // missing/corrupt — fall through to the single-hub fallback
    }
  }
  return fallbackAccess(HUB_CHANNEL_ID)
}

function rootChannelId(msg: Message): string {
  return msg.channel.isThread() ? (msg.channel.parentId ?? msg.channelId) : msg.channelId
}

// discord.js `mentions.has(user)` returns true for a direct @, and (with no
// options) for @everyone/@here too — exactly what the gateway relies on.
function isMentioned(msg: Message): boolean {
  const me = discordClient.user
  return me ? msg.mentions.has(me) : false
}

// ─── Session management (one Codex thread + queue per Discord channel) ───

interface Session {
  codexThreadId: string | null
  queue: Array<() => Promise<void>>
  processing: boolean
  firstTurn: boolean
}

const sessions = new Map<string, Session>()

function getSession(discordId: string): Session {
  let s = sessions.get(discordId)
  if (!s) {
    s = { codexThreadId: null, queue: [], processing: false, firstTurn: true }
    sessions.set(discordId, s)
  }
  return s
}

function resetSession(discordId: string): void {
  const s = sessions.get(discordId)
  if (s) {
    s.codexThreadId = null
    s.firstTurn = true
  }
  publishThreads()
}

// Write the live channel→thread map to THREADS_FILE (0600) so a viewer can
// `codex resume <thread> --remote <appServerUrl>` onto the exact thread this
// adapter drives. Called whenever a thread is created or reset.
function publishThreads(): void {
  if (!THREADS_FILE) return
  const threads: Record<string, string> = {}
  for (const [ctx, s] of sessions) if (s.codexThreadId) threads[ctx] = s.codexThreadId
  try {
    writeFileSync(
      THREADS_FILE,
      JSON.stringify({ bot: BOT_NAME, appServerUrl: APP_SERVER_URL, homeChannelId: HUB_CHANNEL_ID, threads }, null, 2),
      { mode: 0o600 },
    )
    chmodSync(THREADS_FILE, 0o600) // enforce 0600 even if the file pre-existed
  } catch (e) {
    log('WARN', `publishThreads failed: ${(e as Error).message}`)
  }
}

function enqueue(discordId: string, fn: () => Promise<void>): void {
  const s = getSession(discordId)
  s.queue.push(fn)
  if (!s.processing) void processQueue(discordId)
}

async function processQueue(discordId: string): Promise<void> {
  const s = getSession(discordId)
  s.processing = true
  while (s.queue.length > 0) {
    const task = s.queue.shift()!
    try {
      await task()
    } catch (e) {
      log('ERROR', `Queue task error in ${discordId}:`, (e as Error).message)
    }
  }
  s.processing = false
}

// ─── Codex app-server connection (JSON-RPC over WebSocket) ───

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let ws: WebSocket | null = null
let rpcId = 0
const pendingRequests = new Map<number | string, Pending>()
let initialized = false
let reconnectDelay = 1000

function nextId(): number {
  return ++rpcId
}

function connectToAppServer(): void {
  log('INFO', `Connecting to app-server at ${APP_SERVER_URL}...`)
  ws = new WebSocket(APP_SERVER_URL)

  ws.addEventListener('open', () => {
    log('INFO', 'WebSocket connected, sending initialize...')
    reconnectDelay = 1000
    sendRpc('initialize', { clientInfo: { name: `${BOT_NAME_LOWER}-adapter`, version: '1.0.0' } })
      .then(() => {
        sendNotification('initialized', {})
        initialized = true
        log('INFO', 'Handshake complete, app-server ready')
      })
      .catch(e => log('ERROR', 'Initialize failed:', (e as Error).message))
  })

  ws.addEventListener('message', ev => {
    try {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
      handleRpcMessage(JSON.parse(raw))
    } catch (e) {
      log('ERROR', 'Failed to parse WS message:', (e as Error).message)
    }
  })

  ws.addEventListener('close', ev => {
    log('WARN', `WebSocket closed (code ${ev.code}), reconnecting in ${reconnectDelay}ms...`)
    initialized = false
    for (const [, pending] of pendingRequests) {
      pending.reject(new Error('WebSocket closed'))
      clearTimeout(pending.timeout)
    }
    pendingRequests.clear()
    setTimeout(connectToAppServer, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  })

  ws.addEventListener('error', () => {
    // The 'close' handler drives reconnection; error events carry no detail in
    // the WHATWG API, so just note it.
    log('ERROR', 'WebSocket error')
  })
}

interface RpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

function handleRpcMessage(msg: RpcMessage): void {
  // Response to a request we sent.
  if (msg.id != null && pendingRequests.has(msg.id)) {
    const pending = pendingRequests.get(msg.id)!
    pendingRequests.delete(msg.id)
    clearTimeout(pending.timeout)
    if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
    else pending.resolve(msg.result)
    return
  }
  // Server→client request (approval/elicitation): id + method, not ours.
  if (msg.id != null && msg.method) {
    handleServerRequest(msg)
    return
  }
  // Notification (streaming events).
  if (msg.method) handleNotification(msg.method, msg.params)
}

function handleServerRequest(msg: RpcMessage): void {
  const { id, method } = msg
  switch (method) {
    case 'mcpServer/elicitation/request':
      log('INFO', `Auto-approving MCP elicitation (id=${id})`)
      ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result: { action: 'accept' } }))
      break
    case 'commandExecution/requestApproval':
      log('INFO', `Auto-approving command execution (id=${id})`)
      ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result: { decision: 'acceptForSession' } }))
      break
    case 'applyPatch/approval':
    case 'fileChange/requestApproval':
      log('INFO', `Auto-approving file change (id=${id})`)
      ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result: { decision: 'accept' } }))
      break
    default:
      log('WARN', `Unknown server request: ${method} (id=${id}), auto-accepting`)
      ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result: { action: 'accept', decision: 'accept' } }))
      break
  }
}

function handleNotification(method: string, params?: Record<string, unknown>): void {
  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = params?.delta
      if (typeof delta === 'string') process.stdout.write(delta)
      break
    }
    case 'turn/completed': {
      log('INFO', 'Turn completed')
      setTabProgress(false)
      const turn = params?.turn as { id?: string } | undefined
      if (turn?.id) {
        const key = `turn:${turn.id}`
        const pending = pendingRequests.get(key)
        if (pending) {
          pendingRequests.delete(key)
          clearTimeout(pending.timeout)
          pending.resolve(params)
        }
      }
      break
    }
    case 'thread/compacted':
      log('INFO', 'Context compacted by Codex')
      break
    case 'turn/started':
      log('INFO', 'Turn started')
      setTabProgress(true)
      break
    case 'error': {
      // Shape: { error: { message, willRetry, turnId, ... } } (older builds put
      // fields at top level). Log it, and if it's terminal (no further retry),
      // reject the pending turn so the queue advances instead of waiting out the
      // full turn timeout on a turn Codex has already given up on.
      const err = (params?.error ?? params) as { message?: string; willRetry?: boolean; turnId?: string }
      log('ERROR', 'Codex error:', err?.message ?? JSON.stringify(params))
      setTabProgress(false)
      if (err?.willRetry === false && err?.turnId) {
        const key = `turn:${err.turnId}`
        const pending = pendingRequests.get(key)
        if (pending) {
          pendingRequests.delete(key)
          clearTimeout(pending.timeout)
          pending.reject(new Error(err.message || 'Codex terminal error'))
        }
      }
      break
    }
    default:
      break
  }
}

function sendRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WebSocket not connected'))
    const id = nextId()
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`RPC ${method} timed out`))
    }, RPC_TIMEOUT)
    pendingRequests.set(id, { resolve, reject, timeout })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
}

// ─── Codex thread operations ───

async function startThread(): Promise<string> {
  const result = (await sendRpc('thread/start', {
    model: MODEL,
    cwd: WORK_DIR,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    baseInstructions: SYSTEM_PROMPT,
  })) as { thread: { id: string } }
  return result.thread.id
}

function startTurn(threadId: string, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const turnTimeout = setTimeout(() => reject(new Error(`Turn timed out after ${TURN_TIMEOUT / 1000}s`)), TURN_TIMEOUT)
    sendRpc('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      // Pin model + reasoning effort on every turn — applies to this and
      // subsequent turns, so existing threads pick up gpt-5.5/high without a
      // thread restart, and it never silently falls back to a wiped config.toml.
      model: MODEL,
      effort: EFFORT,
      // The bot's prompt governs when it speaks; a per-request approval gate
      // would block its own reply/react tool calls (nothing to approve them).
      approvalPolicy: 'never',
    })
      .then(result => {
        const turnId = (result as { turn?: { id?: string } })?.turn?.id
        if (turnId) {
          pendingRequests.set(`turn:${turnId}`, {
            resolve: v => {
              clearTimeout(turnTimeout)
              resolve(v)
            },
            reject: err => {
              clearTimeout(turnTimeout)
              reject(err)
            },
            timeout: turnTimeout,
          })
        } else {
          clearTimeout(turnTimeout)
          resolve(result)
        }
      })
      .catch(err => {
        clearTimeout(turnTimeout)
        reject(err)
      })
  })
}

// ─── Conversation context ───

async function getRecentContext(msg: Message, limit = CONTEXT_MESSAGES): Promise<string> {
  try {
    if (!msg.channel.isTextBased()) return ''
    const messages = await msg.channel.messages.fetch({ limit, before: msg.id })
    if (!messages.size) return ''
    const lines = [...messages.values()]
      .reverse()
      .map(m => {
        const name = m.author.bot ? m.author.username : m.member?.displayName || m.author.username
        return `[${name}]: ${m.content.slice(0, 500)}`
      })
      .join('\n')
    return `<recent_chat_history>\n${lines}\n</recent_chat_history>\n\n`
  } catch {
    return ''
  }
}

function formatEnvelope(msg: Message): string {
  const attrs = [
    `source="discord"`,
    `chat_id="${rootChannelId(msg)}"`,
    `message_id="${msg.id}"`,
    `user="${msg.member?.displayName || msg.author.username}"`,
    `user_id="${msg.author.id}"`,
    `ts="${msg.createdAt.toISOString()}"`,
    msg.author.bot ? `bot="true"` : '',
  ]
  if (msg.channel.isThread()) {
    attrs.push(`thread_id="${msg.channel.id}"`)
    attrs.push(`parent_channel_id="${msg.channel.parentId}"`)
  }
  return `<channel ${attrs.filter(Boolean).join(' ')}>\n${msg.content}\n</channel>`
}

// ─── Discord client ───

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
})

discordClient.once('clientReady', () => {
  // Greppable readiness marker — `pinchcord launch` polls for this to report
  // "✓ ready" for a codex bot (there is no channels-trust dialog to approve).
  log('INFO', `pinchcord codex adapter ready — logged in as ${discordClient.user?.tag}`)
  log('INFO', `work dir: ${WORK_DIR} · app-server: ${APP_SERVER_URL}`)
})

discordClient.on('messageCreate', async msg => {
  if (msg.author.id === discordClient.user?.id) return // ignore own messages

  // Same delivery gate as the gateway: channel must be a group, sender must
  // pass allowFrom, and requireMention (default true) must be satisfied.
  const mentioned = isMentioned(msg)
  const allowed = groupDelivers(loadAccess(), {
    channelId: rootChannelId(msg),
    senderId: msg.author.id,
    mentioned,
  })
  if (!allowed) return

  const contextId = msg.channel.isThread() ? msg.channel.id : msg.channelId

  // Reset command (only when addressed, kept short to avoid false positives).
  if (mentioned && msg.content.length <= RESET_MAX_LEN && RESET_PHRASES.some(p => msg.content.toLowerCase().trim() === p)) {
    resetSession(contextId)
    log('INFO', `Session reset for ${contextId}`)
    return
  }

  if (!initialized) {
    log('WARN', 'App-server not ready, skipping message')
    return
  }

  const sender = msg.member?.displayName || msg.author.username
  log('INFO', `${mentioned ? 'ADDRESSED' : 'ambient'} from ${sender}: ${msg.content.slice(0, 80)}`)

  enqueue(contextId, async () => {
    try {
      const session = getSession(contextId)
      if (!session.codexThreadId) {
        log('INFO', `Starting new Codex thread for ${contextId}`)
        session.codexThreadId = await startThread()
        log('INFO', `Thread created: ${session.codexThreadId}`)
        publishThreads()
      }

      let prompt: string
      if (session.firstTurn) {
        prompt = (await getRecentContext(msg)) + formatEnvelope(msg)
        session.firstTurn = false
      } else {
        prompt = formatEnvelope(msg)
      }

      if (mentioned && msg.channel.isTextBased()) {
        await msg.channel.sendTyping().catch(() => {})
      }

      log('INFO', 'Starting turn...')
      console.log('\n--- Turn start ---')
      await startTurn(session.codexThreadId, prompt)
      console.log('\n--- Turn end ---\n')
    } catch (e) {
      const message = (e as Error).message
      log('ERROR', `Turn failed: ${message}`)
      if (message.includes('thread') || message.includes('not found')) {
        log('WARN', 'Resetting corrupted thread')
        resetSession(contextId)
      }
    }
  })
})

// ─── Start ───

log('INFO', `Starting ${BOT_NAME} adapter (persistent mode)...`)
if (!PROMPT_FILE) log('WARN', 'no CODEX_PROMPT_FILE set — starting with an empty system prompt')
connectToAppServer()
discordClient.login(TOKEN).catch((e: Error) => {
  log('ERROR', `Failed to login: ${e.message}`)
  process.exit(1)
})
