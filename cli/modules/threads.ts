/**
 * threads.ts — Thread metadata for PinchCord.
 *
 * Enriches inbound notifications with thread_id and reply_to metadata.
 * Thread creation and posting are handled by the `pinchcord` CLI.
 *
 * If this file is absent, PinchCord delivers messages without thread context.
 */

import type { Client, Message } from 'discord.js'

// ---------------------------------------------------------------------------
// Client reference
// ---------------------------------------------------------------------------

let _client: Client | null = null

/**
 * Called by server.ts after the Discord gateway is ready.
 */
export function init(client: Client): void {
  _client = client
}

// ---------------------------------------------------------------------------
// Notification metadata
// ---------------------------------------------------------------------------

/**
 * Extracts thread and reply metadata from an inbound Discord message.
 * Called by server.ts when building the notification meta block.
 *
 * Adds:
 *   - thread_id  — present if the message was posted inside a thread
 *   - reply_to   — present if the message is a Discord reply (quoted message id)
 *
 * @param msg - The inbound Discord message.
 * @returns A partial metadata record with thread_id and/or reply_to fields.
 *
 * @example
 *   const meta = { ...getThreadMeta(msg) }
 */
export function getThreadMeta(msg: Message): Record<string, string> {
  const meta: Record<string, string> = {}

  // Thread context — include the thread's own channel ID as thread_id
  if (msg.channel.isThread()) {
    meta.thread_id = msg.channelId
    if (msg.channel.parentId) {
      meta.parent_channel_id = msg.channel.parentId
    }
  }

  // Reply context — the message_id this message is quoting
  if (msg.reference?.messageId) {
    meta.reply_to = msg.reference.messageId
  }

  return meta
}
