/**
 * threads.ts — Thread creation, routing, and delivery for PinchCord.
 *
 * Enables bots to create Discord threads, route messages into existing threads
 * (auto-unarchiving if needed), and enriches inbound notifications with
 * thread_id and reply_to metadata.
 *
 * If this file is absent, PinchCord delivers messages without thread context.
 */

import type {
  Client,
  Message,
  TextChannel,
  NewsChannel,
  AnyThreadChannel,
} from 'discord.js'

// ---------------------------------------------------------------------------
// Client reference
// ---------------------------------------------------------------------------

let _client: Client | null = null

/**
 * Called by server.ts after the Discord gateway is ready.
 * Required before createThread or sendToThread can be used.
 */
export function init(client: Client): void {
  _client = client
}

function getClient(): Client {
  if (!_client) throw new Error('threads module not initialized — init(client) not called yet')
  return _client
}

// ---------------------------------------------------------------------------
// Thread creation
// ---------------------------------------------------------------------------

/**
 * Creates a public thread off an existing message in a text or announcement channel.
 *
 * @param channelId  - The channel ID containing the message to thread from.
 * @param messageId  - The message ID to create the thread off.
 * @param threadName - The display name for the new thread (max 100 chars).
 * @returns The thread_id (string) of the newly created thread.
 * @throws If the channel or message cannot be fetched, or thread creation fails.
 *
 * @example
 *   const thread_id = await createThread('1234', '5678', 'Sprint planning')
 */
export async function createThread(
  channelId: string,
  messageId: string,
  threadName: string,
): Promise<string> {
  const client = getClient()
  try {
    const ch = await client.channels.fetch(channelId)
    if (!ch || !(ch.isTextBased()) || ch.isDMBased() || ch.isThread()) {
      throw new Error(`channel ${channelId} must be a guild text or announcement channel`)
    }
    const textCh = ch as TextChannel | NewsChannel
    const msg = await textCh.messages.fetch(messageId)
    const thread = await msg.startThread({
      name: threadName.slice(0, 100),
      autoArchiveDuration: 1440, // 24 hours
    })
    return thread.id
  } catch (err) {
    process.stderr.write(`pinchcord threads: createThread failed: ${err}\n`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Thread routing (send to existing thread)
// ---------------------------------------------------------------------------

/**
 * Sends a message to an existing thread, auto-unarchiving it if necessary.
 *
 * @param threadId - The Discord thread channel ID.
 * @param text     - The message content to send.
 * @returns The message_id of the sent message.
 * @throws If the thread cannot be fetched or messaged.
 *
 * @example
 *   const msgId = await sendToThread('9999', 'Deployment complete.')
 */
export async function sendToThread(threadId: string, text: string): Promise<string> {
  const client = getClient()
  try {
    const ch = await client.channels.fetch(threadId)
    if (!ch || !ch.isThread()) {
      throw new Error(`channel ${threadId} is not a thread`)
    }
    const thread = ch as AnyThreadChannel

    // Auto-unarchive if the thread is archived (locked threads cannot be unarchived)
    if (thread.archived) {
      if (thread.locked) {
        throw new Error(`thread ${threadId} is locked and cannot be unarchived`)
      }
      await thread.setArchived(false)
    }

    const sent = await thread.send(text)
    return sent.id
  } catch (err) {
    process.stderr.write(`pinchcord threads: sendToThread failed: ${err}\n`)
    throw err
  }
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
