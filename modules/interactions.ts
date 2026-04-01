/**
 * interactions.ts — Presence, reactions, and pins for PinchCord.
 *
 * Provides helpers for:
 *   - Setting/clearing the bot's Discord activity status
 *   - Reacting to messages (acknowledge / complete)
 *   - Pinning messages in a channel
 *
 * If this file is absent, presence/reaction/pin features are silently disabled.
 */

import { ActivityType, type Client, type Message } from 'discord.js'

// ---------------------------------------------------------------------------
// Client reference
// ---------------------------------------------------------------------------

let _client: Client | null = null

/**
 * Store the Discord client so all helpers in this module can use it.
 * Called automatically by server.ts on the `ready` event.
 */
export function init(client: Client): void {
  _client = client
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * Set the bot's Discord activity/status text.
 *
 * @example
 *   setPresence("Working on Sprint 4")
 *   // → "Playing Working on Sprint 4"
 */
export function setPresence(activity: string): void {
  if (!_client?.user) {
    process.stderr.write('pinchcord interactions: setPresence called before client ready\n')
    return
  }
  try {
    _client.user.setActivity(activity, { type: ActivityType.Playing })
  } catch (err) {
    process.stderr.write(`pinchcord interactions: setPresence error: ${err}\n`)
  }
}

/**
 * Clear the bot's current activity/presence.
 */
export function clearPresence(): void {
  if (!_client?.user) {
    process.stderr.write('pinchcord interactions: clearPresence called before client ready\n')
    return
  }
  try {
    _client.user.setPresence({ activities: [] })
  } catch (err) {
    process.stderr.write(`pinchcord interactions: clearPresence error: ${err}\n`)
  }
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * React to a message with a checkmark (✅) to acknowledge receipt.
 * Safe to call and forget — errors are logged, not thrown.
 */
export async function acknowledge(msg: Message): Promise<void> {
  try {
    await msg.react('✅')
  } catch (err) {
    process.stderr.write(`pinchcord interactions: acknowledge reaction failed: ${err}\n`)
  }
}

/**
 * React to a message with a green circle (🟢) to indicate completion.
 * Safe to call and forget — errors are logged, not thrown.
 */
export async function complete(msg: Message): Promise<void> {
  try {
    await msg.react('🟢')
  } catch (err) {
    process.stderr.write(`pinchcord interactions: complete reaction failed: ${err}\n`)
  }
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

/**
 * Pin a message in a channel.
 *
 * @param channelId  The Discord channel ID.
 * @param messageId  The message ID to pin.
 */
export async function pinMessage(channelId: string, messageId: string): Promise<void> {
  if (!_client) {
    process.stderr.write('pinchcord interactions: pinMessage called before init\n')
    return
  }
  try {
    const channel = await _client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      process.stderr.write(`pinchcord interactions: pinMessage — channel ${channelId} not found or not text-based\n`)
      return
    }
    const msg = await channel.messages.fetch(messageId)
    await msg.pin()
  } catch (err) {
    process.stderr.write(`pinchcord interactions: pinMessage error: ${err}\n`)
  }
}
