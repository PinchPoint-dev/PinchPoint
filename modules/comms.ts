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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CommsConfig {
  /** The channel ID where bot-to-bot messages are allowed. */
  hubChannelId: string
  /** Optional map of bot names to embed colors (hex). */
  botColors?: Record<string, number>
}

// Default config — override by calling configure().
let config: CommsConfig = {
  hubChannelId: process.env.PINCHHUB_CHANNEL_ID ?? '',
}

export function configure(c: Partial<CommsConfig>): void {
  config = { ...config, ...c }
}

export function getConfig(): CommsConfig {
  return config
}

// ---------------------------------------------------------------------------
// Bot message filter
// ---------------------------------------------------------------------------

/**
 * Determines whether a bot message should be delivered.
 * Returns true if the message is in the hub channel, false otherwise.
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

type QueuedHandler = (msg: Message) => Promise<void>

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
    // faster than they're processed (queue is also capped at 100 in enqueueIfNeeded).
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
    if (queue.length > 0) {
      process.stderr.write(`pinchcord comms: drain loop hit iteration cap with ${queue.length} messages remaining\n`)
    }
  } finally {
    draining = false
  }
}

/**
 * Either processes the message immediately (if catch-up is done) or queues it.
 * Returns true if the message was queued, false if it should be processed now.
 */
export function enqueueIfNeeded(msg: Message): boolean {
  if (catchUpComplete && !draining) return false
  if (queue.length < 100) {
    queue.push(msg)
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
