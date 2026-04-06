import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ───

const BOT_NAME = process.env.CODEX_BOT_NAME || 'Panda'
const BOT_NAME_LOWER = BOT_NAME.toLowerCase()
const CHANNEL_ID = process.env.PINCHHUB_CHANNEL_ID || '1488108052887633970'
const TOKEN = process.env.DISCORD_BOT_TOKEN
const WORK_DIR = process.env.CODEX_WORK_DIR || resolve(__dirname, '../../..')
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:3848'
const PROMPT_FILE = process.env.CODEX_PROMPT_FILE || resolve(__dirname, `../../../.pinchme/cord/prompts/${BOT_NAME_LOWER}.md`)
const SYSTEM_PROMPT = readFileSync(PROMPT_FILE, 'utf-8')
const MODEL = process.env.CODEX_MODEL || 'gpt-5.4'
const TURN_TIMEOUT = 180_000  // 3 minutes
const CONTEXT_MESSAGES = 40   // messages to inject on first turn
const RESET_PHRASES = [`${BOT_NAME_LOWER} reset`, `${BOT_NAME_LOWER} fresh start`, `${BOT_NAME_LOWER} new session`]
const RESET_MAX_LEN = 30

if (!TOKEN) {
  console.error(`[${BOT_NAME}] DISCORD_BOT_TOKEN is required`)
  process.exit(1)
}

// ─── Logging ───

function log(level, msg, data) {
  const ts = new Date().toISOString().slice(11, 19)
  const prefix = `[${ts}] [${BOT_NAME}] [${level}]`
  if (data) {
    console.log(`${prefix} ${msg}`, typeof data === 'string' ? data : JSON.stringify(data))
  } else {
    console.log(`${prefix} ${msg}`)
  }
}

// ─── Session Management ───
// Each Discord channel/thread gets its own Codex thread + queue

const sessions = new Map()  // discordChannelId → { codexThreadId, queue, processing, firstTurn }

function getSession(discordId) {
  if (!sessions.has(discordId)) {
    sessions.set(discordId, {
      codexThreadId: null,
      queue: [],
      processing: false,
      firstTurn: true,
    })
  }
  return sessions.get(discordId)
}

function resetSession(discordId) {
  const session = sessions.get(discordId)
  if (session) {
    session.codexThreadId = null
    session.firstTurn = true
  }
}

// ─── Per-Channel Queue ───

async function enqueue(discordId, fn) {
  const session = getSession(discordId)
  session.queue.push(fn)
  if (!session.processing) processQueue(discordId)
}

async function processQueue(discordId) {
  const session = getSession(discordId)
  session.processing = true
  while (session.queue.length > 0) {
    const task = session.queue.shift()
    try { await task() } catch (e) { log('ERROR', `Queue task error in ${discordId}:`, e.message) }
  }
  session.processing = false
}

// ─── Codex App-Server Connection ───

let ws = null
let rpcId = 0
const pendingRequests = new Map()  // rpcId → { resolve, reject, timeout }
let initialized = false
let reconnectDelay = 1000

function nextId() { return ++rpcId }

function connectToAppServer() {
  log('INFO', `Connecting to app-server at ${APP_SERVER_URL}...`)
  ws = new WebSocket(APP_SERVER_URL)

  ws.on('open', () => {
    log('INFO', 'WebSocket connected, sending initialize...')
    reconnectDelay = 1000
    sendRpc('initialize', {
      clientInfo: { name: `${BOT_NAME_LOWER}-adapter`, version: '1.0.0' },
    }).then(() => {
      sendNotification('initialized', {})
      initialized = true
      log('INFO', 'Handshake complete, app-server ready')
    }).catch(e => {
      log('ERROR', 'Initialize failed:', e.message)
    })
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      handleRpcMessage(msg)
    } catch (e) {
      log('ERROR', 'Failed to parse WS message:', e.message)
    }
  })

  ws.on('close', (code) => {
    log('WARN', `WebSocket closed (code ${code}), reconnecting in ${reconnectDelay}ms...`)
    initialized = false
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('WebSocket closed'))
      clearTimeout(pending.timeout)
    }
    pendingRequests.clear()
    setTimeout(connectToAppServer, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  })

  ws.on('error', (e) => {
    log('ERROR', 'WebSocket error:', e.message)
  })
}

function handleRpcMessage(msg) {
  // Response to a request we sent
  if (msg.id && pendingRequests.has(msg.id)) {
    const pending = pendingRequests.get(msg.id)
    pendingRequests.delete(msg.id)
    clearTimeout(pending.timeout)
    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
    } else {
      pending.resolve(msg.result)
    }
    return
  }

  // Server→client request (has id + method, but id not in our pending map)
  // These are approval/elicitation requests that need a response
  if (msg.id != null && msg.method) {
    handleServerRequest(msg)
    return
  }

  // Notification from server (streaming events)
  if (msg.method) {
    handleNotification(msg.method, msg.params)
  }
}

function handleServerRequest(msg) {
  const { id, method } = msg

  switch (method) {
    // MCP tool call approval — auto-accept all
    case 'mcpServer/elicitation/request':
      log('INFO', `Auto-approving MCP elicitation (id=${id})`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { action: 'accept' } }))
      break

    // Command execution approval — auto-accept for session
    case 'commandExecution/requestApproval':
      log('INFO', `Auto-approving command execution (id=${id})`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { decision: 'acceptForSession' } }))
      break

    // File change approval — auto-accept
    case 'applyPatch/approval':
    case 'fileChange/requestApproval':
      log('INFO', `Auto-approving file change (id=${id})`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { decision: 'accept' } }))
      break

    default:
      // Unknown server request — accept generically to avoid blocking
      log('WARN', `Unknown server request: ${method} (id=${id}), auto-accepting`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { action: 'accept', decision: 'accept' } }))
      break
  }
}

function handleNotification(method, params) {
  switch (method) {
    case 'item/agentMessage/delta':
      // Stream output to terminal for viewer
      if (params?.delta) process.stdout.write(params.delta)
      break
    case 'turn/completed':
      log('INFO', 'Turn completed')
      if (params?.turn?.id) {
        const key = `turn:${params.turn.id}`
        if (pendingRequests.has(key)) {
          const pending = pendingRequests.get(key)
          pendingRequests.delete(key)
          clearTimeout(pending.timeout)
          pending.resolve(params)
        }
      }
      break
    case 'thread/compacted':
      log('INFO', 'Context compacted by Codex')
      break
    case 'error':
      log('ERROR', 'Codex error:', params?.message || JSON.stringify(params))
      break
    case 'turn/started':
      log('INFO', 'Turn started')
      break
    default:
      break
  }
}

function sendRpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket not connected'))
    }
    const id = nextId()
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`RPC ${method} timed out`))
    }, TURN_TIMEOUT)
    pendingRequests.set(id, { resolve, reject, timeout })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

function sendNotification(method, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
}

// ─── Codex Thread Operations ───

async function startThread() {
  const result = await sendRpc('thread/start', {
    model: MODEL,
    cwd: WORK_DIR,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    baseInstructions: SYSTEM_PROMPT,
  })
  return result.thread.id
}

async function startTurn(threadId, text, addressed) {
  return new Promise((resolve, reject) => {
    const turnTimeout = setTimeout(() => {
      reject(new Error('Turn timed out after ' + (TURN_TIMEOUT / 1000) + 's'))
    }, TURN_TIMEOUT)

    sendRpc('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      // Panda's prompt controls when to speak — approval gate removed because
      // on-request blocks MCP tool calls (reply, react) with no one to approve
      approvalPolicy: 'never',
    }).then(result => {
      // Wait for TurnCompleted notification
      const turnId = result?.turn?.id
      if (turnId) {
        pendingRequests.set(`turn:${turnId}`, {
          resolve: (params) => {
            clearTimeout(turnTimeout)
            resolve(params)
          },
          reject: (err) => {
            clearTimeout(turnTimeout)
            reject(err)
          },
          timeout: turnTimeout,
        })
      } else {
        clearTimeout(turnTimeout)
        resolve(result)
      }
    }).catch(err => {
      clearTimeout(turnTimeout)
      reject(err)
    })
  })
}

// ─── Conversation Context ───

async function getRecentContext(channel, beforeMsg, limit = CONTEXT_MESSAGES) {
  try {
    const messages = await channel.messages.fetch({ limit, before: beforeMsg.id })
    if (!messages.size) return ''

    const lines = [...messages.values()]
      .reverse()
      .map(m => {
        const name = m.author.bot ? m.author.username : m.author.displayName || m.author.username
        const content = m.content.slice(0, 500)
        return `[${name}]: ${content}`
      })
      .join('\n')

    return `<recent_chat_history>\n${lines}\n</recent_chat_history>\n\n`
  } catch {
    return ''
  }
}

// ─── Message Envelope ───

function formatEnvelope(msg) {
  const attrs = [
    `source="discord"`,
    `chat_id="${msg.channel.isThread() ? msg.channel.id : msg.channelId}"`,
    `message_id="${msg.id}"`,
    `user="${msg.author.displayName || msg.author.username}"`,
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

function isAddressedToBot(msg) {
  const content = msg.content.toLowerCase().trim()
  if (content.startsWith(BOT_NAME_LOWER)) return true
  if (content.includes('@qa') || content.includes('@all')) return true
  if (msg.mentions.users.has(discordClient.user.id)) return true
  return false
}

// ─── Discord Client ───

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

discordClient.once('clientReady', () => {
  log('INFO', `Logged in as ${discordClient.user.tag}`)
  log('INFO', `Watching channel ${CHANNEL_ID}`)
  log('INFO', `Work dir: ${WORK_DIR}`)
})

discordClient.on('messageCreate', async (msg) => {
  // Ignore own messages
  if (msg.author.id === discordClient.user.id) return

  // Only respond in the configured channel (or its threads)
  const rootChannel = msg.channel.isThread() ? msg.channel.parentId : msg.channelId
  if (rootChannel !== CHANNEL_ID) return

  const contextId = msg.channel.isThread() ? msg.channel.id : msg.channelId
  const addressed = isAddressedToBot(msg)

  // Handle reset command
  if (addressed && msg.content.length <= RESET_MAX_LEN &&
      RESET_PHRASES.some(p => msg.content.toLowerCase().trim() === p)) {
    resetSession(contextId)
    log('INFO', `Session reset for ${contextId}`)
    // Can't reply via adapter — but we haven't started the turn yet
    // Bot will see the next message as a fresh start
    return
  }

  // Skip if not ready
  if (!initialized) {
    log('WARN', 'App-server not ready, skipping message')
    return
  }

  const envelope = formatEnvelope(msg)
  const sender = msg.author.displayName || msg.author.username

  log('INFO', `${addressed ? 'ADDRESSED' : 'ambient'} from ${sender}: ${msg.content.slice(0, 80)}`)

  // Queue the message for this channel
  enqueue(contextId, async () => {
    try {
      const session = getSession(contextId)

      // Create Codex thread if needed
      if (!session.codexThreadId) {
        log('INFO', `Starting new Codex thread for ${contextId}`)
        session.codexThreadId = await startThread()
        log('INFO', `Thread created: ${session.codexThreadId}`)
      }

      // Build the prompt
      let prompt = ''

      // First turn in this channel: inject recent Discord context
      if (session.firstTurn) {
        const context = await getRecentContext(msg.channel, msg)
        prompt = context + envelope
        session.firstTurn = false
      } else {
        prompt = envelope
      }

      // Show typing indicator if addressed
      if (addressed) {
        await msg.channel.sendTyping().catch(() => {})
      }

      // Start the turn
      log('INFO', `Starting turn (${addressed ? 'full-auto' : 'read-only'})...`)
      console.log('\n--- Turn start ---')
      await startTurn(session.codexThreadId, prompt, addressed)
      console.log('\n--- Turn end ---\n')

    } catch (e) {
      log('ERROR', `Turn failed: ${e.message}`)
      // If thread is corrupted, reset it
      if (e.message.includes('thread') || e.message.includes('not found')) {
        log('WARN', 'Resetting corrupted thread')
        resetSession(contextId)
      }
    }
  })
})

// ─── Start ───

log('INFO', `Starting ${BOT_NAME} adapter (persistent mode)...`)
connectToAppServer()
discordClient.login(TOKEN).catch((e) => {
  log('ERROR', `Failed to login: ${e.message}`)
  process.exit(1)
})
