import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { spawn } from 'child_process'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractCodexResult, parseCodexJsonLines } from './codex-output.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ───

const BOT_NAME = process.env.CODEX_BOT_NAME || 'Viper'
const BOT_NAME_LOWER = BOT_NAME.toLowerCase()
const CHANNEL_ID = process.env.PINCHHUB_CHANNEL_ID || ''
const TOKEN = process.env.DISCORD_BOT_TOKEN
const WORK_DIR = process.env.CODEX_WORK_DIR || resolve(__dirname, '../../..')
const CODEX_BIN = process.env.CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex')
const CODEX_TIMEOUT = 180_000  // 3 minutes
const PROMPT_FILE = process.env.CODEX_PROMPT_FILE || resolve(__dirname, `../../../.pinchme/cord/prompts/${BOT_NAME_LOWER}.md`)
const SYSTEM_PROMPT = readFileSync(PROMPT_FILE, 'utf-8')
const MAX_MSG_LEN = 2000
const RESET_PHRASES = [`${BOT_NAME_LOWER} reset`, `${BOT_NAME_LOWER} fresh start`, `${BOT_NAME_LOWER} new session`]
const RESET_MAX_LEN = 30

if (!TOKEN) {
  console.error(`[${BOT_NAME}] DISCORD_BOT_TOKEN is required`)
  process.exit(1)
}

// ─── Message Queue ───

const queue = []
let processing = false

async function enqueue(fn) {
  queue.push(fn)
  if (!processing) processQueue()
}

async function processQueue() {
  processing = true
  while (queue.length > 0) {
    const task = queue.shift()
    try { await task() } catch (e) { console.error('Queue task error:', e) }
  }
  processing = false
}

// ─── Session Management ───
// Each thread/channel gets its own session to avoid context bleeding

// Track active sessions — null means no session yet (start fresh)
const sessions = new Map()  // channelOrThreadId → threadId | null

function getSessionId(channelOrThreadId) {
  if (!sessions.has(channelOrThreadId)) return null
  return sessions.get(channelOrThreadId)
}

function setSessionId(channelOrThreadId, threadId) {
  sessions.set(channelOrThreadId, threadId)
}

function resetSession(channelOrThreadId) {
  sessions.delete(channelOrThreadId)
}

// ─── Codex Execution ───

function runCodex(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const tempDir = mkdtempSync(join(tmpdir(), `${BOT_NAME_LOWER}-codex-`))
    const lastMessagePath = join(tempDir, 'last-message.txt')
    const args = ['exec']

    // Resume prior session if one exists, otherwise start fresh
    if (sessionId) {
      args.push('resume', sessionId)
    }

    args.push('--json', '--full-auto', '--output-last-message', lastMessagePath, '-')  // read prompt from stdin

    const proc = spawn(CODEX_BIN, args, {
      cwd: WORK_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env },
    })

    // Pipe the prompt via stdin to avoid shell quoting issues
    proc.stdin.write(prompt)
    proc.stdin.end()

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      rmSync(tempDir, { recursive: true, force: true })
      reject(new Error('Codex timed out after ' + (CODEX_TIMEOUT / 1000) + 's'))
    }, CODEX_TIMEOUT)

    proc.on('close', (code) => {
      clearTimeout(timeout)

      try {
        if (code !== 0) {
          if (stderr.includes('auth') || stderr.includes('token') || stderr.includes('401')) {
            reject(new Error('AUTH_EXPIRED'))
          } else {
            reject(new Error(`Codex exited with code ${code}: ${stderr.slice(0, 500)}`))
          }
          return
        }

        const lines = parseCodexJsonLines(stdout)
        resolve(extractCodexResult(lines, lastMessagePath))
      } catch (e) {
        reject(new Error('Failed to parse Codex output: ' + e.message))
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    proc.on('error', (e) => {
      clearTimeout(timeout)
      rmSync(tempDir, { recursive: true, force: true })
      reject(e)
    })
  })
}

// ─── Message Splitting ───

function splitMessage(text) {
  if (text.length <= MAX_MSG_LEN) return [text]

  const parts = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LEN) {
      parts.push(remaining)
      break
    }

    // Try to split on paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_MSG_LEN)
    if (splitIdx < MAX_MSG_LEN * 0.3) {
      // Paragraph boundary too early — try single newline
      splitIdx = remaining.lastIndexOf('\n', MAX_MSG_LEN)
    }
    if (splitIdx < MAX_MSG_LEN * 0.3) {
      // No good boundary — hard split
      splitIdx = MAX_MSG_LEN
    }

    let chunk = remaining.slice(0, splitIdx)
    remaining = remaining.slice(splitIdx).trimStart()

    // Handle split code fences — if chunk has an unclosed fence, close and reopen
    const fenceMatches = chunk.match(/```/g)
    if (fenceMatches && fenceMatches.length % 2 !== 0) {
      // Find the language tag of the last opening fence
      const lastOpen = chunk.lastIndexOf('```')
      const afterFence = chunk.slice(lastOpen + 3)
      const lang = afterFence.match(/^(\w*)/)?.[1] || ''
      chunk += '\n```'
      remaining = '```' + lang + '\n' + remaining
    }

    parts.push(chunk)
  }

  return parts
}

// ─── Conversation Context ───

async function getRecentContext(channel, beforeMsg, limit = 15) {
  try {
    const messages = await channel.messages.fetch({ limit, before: beforeMsg.id })
    if (!messages.size) return ''

    const lines = [...messages.values()]
      .reverse()  // oldest first
      .map(m => {
        const name = m.author.bot ? m.author.username : m.author.displayName || m.author.username
        const content = m.content.slice(0, 500)  // truncate long messages
        return `[${name}]: ${content}`
      })
      .join('\n')

    return `<recent_chat_history>\n${lines}\n</recent_chat_history>\n\n`
  } catch {
    return ''
  }
}

// ─── Message Handling ───

const NO_RESPONSE = '[NO_RESPONSE]'

function isAddressedToBot(msg) {
  const content = msg.content.toLowerCase().trim()
  if (content.startsWith(BOT_NAME_LOWER)) return true
  if (content.includes('@qa') || content.includes('@all')) return true
  if (msg.mentions.users.has(client.user.id)) return true
  return false
}

// ─── Discord Client ───

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

client.once('clientReady', () => {
  console.log(`[${BOT_NAME}] Logged in as ${client.user.tag}`)
  console.log(`[${BOT_NAME}] Watching channel ${CHANNEL_ID}`)
  console.log(`[${BOT_NAME}] Work dir: ${WORK_DIR}`)
})

client.on('messageCreate', async (msg) => {
  // Ignore own messages
  if (msg.author.id === client.user.id) return

  // Only respond in the configured channel (or its threads)
  const rootChannel = msg.channel.isThread() ? msg.channel.parentId : msg.channelId
  if (rootChannel !== CHANNEL_ID) return

  // Only respond if addressed to this bot
  if (!isAddressedToBot(msg)) return

  const contextId = msg.channel.isThread() ? msg.channel.id : msg.channelId

  // Handle reset command
  if (msg.content.length <= RESET_MAX_LEN && RESET_PHRASES.some(p => msg.content.toLowerCase().trim() === p)) {
    resetSession(contextId)
    await msg.reply('Session cleared. Starting fresh.')
    return
  }

  // Queue the message for processing
  enqueue(async () => {
    // Show typing indicator
    await msg.channel.sendTyping().catch(() => {})

    const sessionId = getSessionId(contextId)

    try {
      // Fetch recent chat context
      const context = await getRecentContext(msg.channel, msg)
      const sender = msg.author.displayName || msg.author.username
      const fullPrompt = `<system>\n${SYSTEM_PROMPT}\n</system>\n\n${context}[${sender}]: ${msg.content}`
      const result = await runCodex(fullPrompt, sessionId)

      // Store the Codex thread ID for future resumes
      if (result.threadId) {
        setSessionId(contextId, result.threadId)
      }

      // Check if bot decided not to respond
      if (result.text.trim() === NO_RESPONSE || result.text.trim().startsWith(NO_RESPONSE)) {
        return  // Stay silent
      }

      // Send response, split if needed
      const parts = splitMessage(result.text)
      for (const part of parts) {
        await msg.channel.send(part)
      }
    } catch (e) {
      if (e.message === 'AUTH_EXPIRED') {
        await msg.channel.send(
          `**${BOT_NAME} is down** — OAuth token expired. The operator needs to run \`codex login\` to re-authenticate.`
        )
      } else {
        console.error(`[${BOT_NAME}] Error:`, e.message)
        await msg.channel.send(
          `**${BOT_NAME} error:** ${e.message.slice(0, 200)}`
        )
      }
    }
  })
})

// ─── Start ───

console.log(`[${BOT_NAME}] Starting adapter (exec mode)...`)
client.login(TOKEN).catch((e) => {
  console.error(`[${BOT_NAME}] Failed to login:`, e.message)
  process.exit(1)
})
