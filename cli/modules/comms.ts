/**
 * comms.ts — Bot-to-bot communication module for PinchCord.
 *
 * Enables bot messages to be delivered in a designated hub channel while
 * keeping them filtered everywhere else. Also enriches inbound notifications
 * with bot="true" when the sender is a bot.
 *
 * If this file is absent, PinchCord behaves identically to the official plugin
 * (all bot messages dropped).
 */

import type { Message, Client, TextBasedChannel } from 'discord.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CommsConfig {
  /** The channel ID where bot-to-bot messages are allowed. */
  hubChannelId: string
}

// Config — hub channel comes from the session env.
const config: CommsConfig = {
  hubChannelId: process.env.PINCHHUB_CHANNEL_ID ?? '',
}

// ---------------------------------------------------------------------------
// Bot message pre-authorization
// ---------------------------------------------------------------------------

/**
 * True when a bot message is in the hub channel (or a hub thread) and is
 * therefore PRE-AUTHORIZED: same-fleet bots talk freely in their hub, so the
 * gateway delivers these without running the access gate. Bot messages in any
 * OTHER channel are not dropped by this returning false — they fall through
 * to the access gate and follow the channel's groups/requireMention policy,
 * exactly like a human message (and like the codex adapter).
 * Non-bot messages are not handled here — the caller should only invoke
 * this for messages where msg.author.bot is true.
 */
export function shouldDeliverBotMessage(msg: Message): boolean {
  if (!config.hubChannelId) return false
  // Deliver in hub channel. For threads whose parent is the hub, also deliver.
  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId
  return channelId === config.hubChannelId
}

/**
 * Returns true if the message author is a bot (but not ourselves).
 * Use this to set the bot="true" attribute on inbound notifications.
 */
export function isBotMessage(msg: Message, selfId: string | undefined): boolean {
  return msg.author.bot && msg.author.id !== selfId
}

/**
 * True for a top-level message in the hub channel (not a thread, not a DM).
 * The delivery watermark applies only to these — thread/DM snowflakes are not
 * ordered against the hub catch-up window.
 */
export function isHubMainMessage(msg: Message): boolean {
  return !msg.channel.isThread() && msg.channelId === config.hubChannelId
}

// ---------------------------------------------------------------------------
// Delivery watermark — the id of the newest hub message already handled.
// Persisted in the state dir so a restart resumes where the last run left off
// instead of re-delivering the whole 20-message catch-up window every boot.
// ---------------------------------------------------------------------------

/** Snowflake comparison: is `id` newer than `lastSeen`? Null watermark = everything is new. */
export function isNewerSnowflake(id: string, lastSeen: string | null): boolean {
  if (!lastSeen) return true
  try { return BigInt(id) > BigInt(lastSeen) } catch { return true }
}

export function loadLastSeen(stateDir: string): string | null {
  try {
    const v = readFileSync(join(stateDir, 'last-seen'), 'utf8').trim()
    return v || null
  } catch { return null }
}

export function saveLastSeen(stateDir: string, id: string): void {
  try {
    writeFileSync(join(stateDir, 'last-seen'), id + '\n', { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`pinchcord comms: failed to persist last-seen: ${err}\n`)
  }
}

// ---------------------------------------------------------------------------
// Startup catch-up
// ---------------------------------------------------------------------------

/**
 * Pulls the last N messages from the hub channel on startup.
 * Returns them oldest-first for sequential processing.
 */
export async function fetchStartupMessages(
  client: Client,
  limit: number = 20,
): Promise<Message[]> {
  if (!config.hubChannelId) return []
  try {
    const ch = await client.channels.fetch(config.hubChannelId)
    if (!ch || !ch.isTextBased()) return []
    const msgs = await (ch as TextBasedChannel).messages.fetch({ limit })
    return [...msgs.values()].reverse() // oldest first
  } catch (err) {
    process.stderr.write(`pinchcord comms: startup catch-up failed: ${err}\n`)
    return []
  }
}

// ---------------------------------------------------------------------------
// Realtime queue
// ---------------------------------------------------------------------------

// Result is ignored here — handleInbound returns a handled/failed boolean for
// the startup catch-up loop, but queued realtime messages have no watermark
// batch to hold back, so drain just logs failures via the handler itself.
type QueuedHandler = (msg: Message) => Promise<unknown>

let queue: Message[] = []
let draining = false
let catchUpComplete = false

/**
 * Mark catch-up as complete and drain any queued realtime messages.
 */
export async function finishCatchUp(handler: QueuedHandler): Promise<void> {
  catchUpComplete = true
  if (queue.length === 0) return
  draining = true
  try {
    // Loop until no new messages arrived during processing.
    // Messages arriving while draining=true get pushed to queue by
    // enqueueIfNeeded(), so we must drain until empty.
    // Bounded to 5 iterations to prevent infinite spin if messages arrive
    // faster than they're processed; leftovers are handed off below.
    let iterations = 0
    while (queue.length > 0 && iterations < 5) {
      iterations++
      const pending = queue.splice(0)
      for (const msg of pending) {
        try {
          await handler(msg)
        } catch (err) {
          process.stderr.write(`pinchcord comms: queued message failed: ${err}\n`)
        }
      }
    }
  } finally {
    draining = false
  }
  // Iteration cap hit with messages still queued: hand off the leftovers
  // instead of stranding them (nothing ever read the queue again). With
  // draining=false and catchUpComplete=true, new arrivals now bypass the
  // queue, so this splice is the final word.
  const leftovers = queue.splice(0)
  if (leftovers.length > 0) {
    process.stderr.write(`pinchcord comms: drain hit iteration cap — delivering ${leftovers.length} leftover message(s) directly\n`)
    for (const msg of leftovers) {
      try {
        await handler(msg)
      } catch (err) {
        process.stderr.write(`pinchcord comms: queued message failed: ${err}\n`)
      }
    }
  }
}

/**
 * Either processes the message immediately (if catch-up is done) or queues it.
 * Returns true if the message was queued, false if it should be processed now.
 */
export function enqueueIfNeeded(msg: Message): boolean {
  if (catchUpComplete && !draining) return false
  // Unbounded on purpose: the old 100-cap silently DROPPED overflow (returned
  // true without pushing), and processing overflow immediately instead would
  // advance the delivery watermark past still-queued older messages, turning
  // them into "duplicates". The queue only lives for the catch-up window
  // (seconds), so growth is bounded by inbound rate in practice — warn if it
  // ever looks pathological.
  queue.push(msg)
  if (queue.length % 1000 === 0) {
    process.stderr.write(`pinchcord comms: realtime queue at ${queue.length} — catch-up may be stuck\n`)
  }
  return true
}

// ---------------------------------------------------------------------------
// Notification metadata helpers
// ---------------------------------------------------------------------------

/**
 * Returns extra metadata fields for bot messages.
 */
export function botMeta(msg: Message, selfId: string | undefined): Record<string, string> {
  const meta: Record<string, string> = {}
  if (isBotMessage(msg, selfId)) {
    meta.bot = 'true'
  }
  return meta
}
