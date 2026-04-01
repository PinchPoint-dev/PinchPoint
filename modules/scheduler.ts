/**
 * scheduler.ts — File-based scheduled message queue for PinchCord.
 *
 * Bots can schedule messages for future delivery. Scheduled messages are
 * persisted as JSON files on disk, so they survive restarts. A 60-second
 * poll loop checks for due messages and sends them.
 *
 * If this file is absent, scheduled messaging is disabled.
 */

import type { Client, TextBasedChannel } from 'discord.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledMessage {
  /** Discord channel ID to send to. */
  channel: string
  /** Message text to send. */
  text: string
  /** ISO 8601 timestamp for when to send. */
  sendAt: string
  /** Bot name that created the schedule. */
  createdBy: string
  /** ISO 8601 timestamp of when it was scheduled. */
  createdAt: string
  /** Optional ID for cancellation. */
  id: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SCHEDULED_DIR = join(
  process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord'),
  'scheduled',
)

let discordClient: Client | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the scheduler with the Discord client and MCP server.
 * Starts the 60-second poll loop.
 */
export function init(client: Client, _mcp: Server): void {
  discordClient = client
  mkdirSync(SCHEDULED_DIR, { recursive: true })

  // Check immediately on startup for past-due messages
  checkScheduled().catch(err => {
    process.stderr.write(`pinchcord scheduler: startup check failed: ${err}\n`)
  })

  // Poll every 60 seconds
  pollInterval = setInterval(() => {
    checkScheduled().catch(err => {
      process.stderr.write(`pinchcord scheduler: poll failed: ${err}\n`)
    })
  }, 60_000)
  pollInterval.unref()
}

/**
 * Schedule a message for future delivery.
 * Returns the scheduled message ID for cancellation.
 */
export function schedule(
  channel: string,
  text: string,
  sendAt: Date | string,
  createdBy: string = 'unknown',
): string {
  mkdirSync(SCHEDULED_DIR, { recursive: true })
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const msg: ScheduledMessage = {
    channel,
    text,
    sendAt: typeof sendAt === 'string' ? sendAt : sendAt.toISOString(),
    createdBy,
    createdAt: new Date().toISOString(),
    id,
  }
  const filePath = join(SCHEDULED_DIR, `${id}.json`)
  writeFileSync(filePath, JSON.stringify(msg, null, 2))
  return id
}

/**
 * Cancel a scheduled message by ID.
 * Returns true if found and removed, false if not found.
 */
export function cancel(id: string): boolean {
  const filePath = join(SCHEDULED_DIR, `${id}.json`)
  try {
    rmSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * List all pending scheduled messages.
 */
export function listPending(): ScheduledMessage[] {
  try {
    const files = readdirSync(SCHEDULED_DIR).filter(f => f.endsWith('.json'))
    const messages: ScheduledMessage[] = []
    for (const file of files) {
      try {
        const raw = readFileSync(join(SCHEDULED_DIR, file), 'utf8')
        messages.push(JSON.parse(raw) as ScheduledMessage)
      } catch { /* skip corrupt files */ }
    }
    return messages.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())
  } catch {
    return []
  }
}

/**
 * Stop the poll loop. Call on shutdown.
 */
export function stop(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

let polling = false

async function checkScheduled(): Promise<void> {
  if (!discordClient || polling) return
  polling = true
  try {
    await checkScheduledInner()
  } finally {
    polling = false
  }
}

async function checkScheduledInner(): Promise<void> {
  let files: string[]
  try {
    files = readdirSync(SCHEDULED_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return
  }

  const now = Date.now()

  for (const file of files) {
    const filePath = join(SCHEDULED_DIR, file)
    let msg: ScheduledMessage
    try {
      const raw = readFileSync(filePath, 'utf8')
      msg = JSON.parse(raw) as ScheduledMessage
    } catch {
      // Corrupt file — remove it
      rmSync(filePath, { force: true })
      continue
    }

    const sendTime = new Date(msg.sendAt).getTime()
    if (isNaN(sendTime)) {
      // Invalid date — remove
      rmSync(filePath, { force: true })
      continue
    }

    if (sendTime <= now) {
      // Due — send it
      try {
        const ch = await discordClient.channels.fetch(msg.channel)
        if (ch && ch.isTextBased()) {
          await (ch as TextBasedChannel).send(msg.text)
        }
        rmSync(filePath, { force: true })
      } catch (err) {
        process.stderr.write(`pinchcord scheduler: failed to send scheduled message ${msg.id}: ${err}\n`)
        // Don't remove — will retry next poll
      }
    }
  }
}
