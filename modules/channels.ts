/**
 * channels.ts — Channel creation, private channels, and message forwarding for PinchCord.
 *
 * Provides guild channel management tools: create/archive text channels,
 * create private channels visible only to specified users, and forward
 * messages between channels (copying content and attachment references).
 *
 * If this file is absent, PinchCord does not expose channel management tools.
 */

import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildTextChannelType,
  type TextChannel,
  type Message,
} from 'discord.js'

// ---------------------------------------------------------------------------
// Client reference
// ---------------------------------------------------------------------------

let _client: Client | null = null

/**
 * Called by server.ts after the Discord gateway is ready.
 * Required before any channel management function can be used.
 */
export function init(client: Client): void {
  _client = client
}

function getClient(): Client {
  if (!_client) throw new Error('channels module not initialized — init(client) not called yet')
  return _client
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchGuild(guildId: string): Promise<Guild> {
  const guild = await getClient().guilds.fetch(guildId)
  if (!guild) throw new Error(`guild ${guildId} not found`)
  return guild
}

// ---------------------------------------------------------------------------
// Channel creation
// ---------------------------------------------------------------------------

/**
 * Creates a new public text channel in a guild.
 *
 * @param guildId    - The guild (server) to create the channel in.
 * @param name       - The channel name (Discord lowercases and slugifies it).
 * @param categoryId - Optional category channel ID to nest this channel under.
 * @param topic      - Optional channel topic/description string.
 * @returns The channel_id of the newly created channel.
 * @throws If guild fetch or channel creation fails.
 *
 * @example
 *   const channelId = await createChannel('guild123', 'sprint-4', 'cat456', 'Sprint 4 work')
 */
export async function createChannel(
  guildId: string,
  name: string,
  categoryId?: string,
  topic?: string,
): Promise<string> {
  try {
    const guild = await fetchGuild(guildId)
    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText as GuildTextChannelType,
      ...(categoryId ? { parent: categoryId } : {}),
      ...(topic ? { topic } : {}),
    })
    return ch.id
  } catch (err) {
    process.stderr.write(`pinchcord channels: createChannel failed: ${err}\n`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Channel archive / deletion
// ---------------------------------------------------------------------------

/**
 * Deletes (permanently removes) a guild channel.
 * Discord does not support archiving text channels directly — deletion is the
 * closest equivalent. To preserve history, use a category or rename first.
 *
 * @param channelId - The channel ID to delete.
 * @param reason    - Optional audit-log reason string.
 * @throws If the channel cannot be fetched or deleted.
 *
 * @example
 *   await archiveChannel('9876', 'Sprint complete — archiving')
 */
export async function archiveChannel(channelId: string, reason?: string): Promise<void> {
  try {
    const client = getClient()
    const ch = await client.channels.fetch(channelId)
    if (!ch || ch.isDMBased()) {
      throw new Error(`channel ${channelId} not found or is a DM channel`)
    }
    if (!ch.isTextBased() && ch.type !== ChannelType.GuildCategory) {
      throw new Error(`channel ${channelId} is not a deletable guild channel`)
    }
    await ch.delete(reason)
  } catch (err) {
    process.stderr.write(`pinchcord channels: archiveChannel failed: ${err}\n`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Private channel creation
// ---------------------------------------------------------------------------

/**
 * Creates a text channel visible only to specified bot user IDs and the
 * server owner. All other members (including @everyone) are denied view access.
 *
 * @param guildId    - The guild to create the channel in.
 * @param name       - The channel name.
 * @param userIds    - Array of Discord user IDs that should have access (bots or humans).
 * @param categoryId - Optional category to place the channel under.
 * @param topic      - Optional channel topic.
 * @returns The channel_id of the created private channel.
 * @throws If guild fetch or channel creation fails.
 *
 * @example
 *   const id = await createPrivateChannel('guild123', 'bot-ops', ['bee-id', 'beaver-id'])
 */
export async function createPrivateChannel(
  guildId: string,
  name: string,
  userIds: string[],
  categoryId?: string,
  topic?: string,
): Promise<string> {
  try {
    const guild = await fetchGuild(guildId)

    // Build permission overwrites: deny @everyone, allow each specified user
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      ...userIds.map(userId => ({
        id: userId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      })),
    ]

    // Also allow the server owner
    if (guild.ownerId && !userIds.includes(guild.ownerId)) {
      overwrites.push({
        id: guild.ownerId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      })
    }

    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText as GuildTextChannelType,
      permissionOverwrites: overwrites,
      ...(categoryId ? { parent: categoryId } : {}),
      ...(topic ? { topic } : {}),
    })
    return ch.id
  } catch (err) {
    process.stderr.write(`pinchcord channels: createPrivateChannel failed: ${err}\n`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Message forwarding
// ---------------------------------------------------------------------------

/**
 * Forwards a message from one channel to another by copying its text content
 * and including a reference line with the original message URL.
 * Attachment URLs are listed inline (Discord bots cannot re-upload from URLs
 * without downloading; this avoids that overhead while preserving references).
 *
 * @param sourceMessageId  - The message ID to forward.
 * @param sourceChannelId  - The channel the source message lives in.
 * @param targetChannelId  - The channel to forward into.
 * @returns The message_id of the forwarded message in the target channel.
 * @throws If either channel or the source message cannot be fetched.
 *
 * @example
 *   const fwdId = await forwardMessage('msg123', 'ch-src', 'ch-dst')
 */
export async function forwardMessage(
  sourceMessageId: string,
  sourceChannelId: string,
  targetChannelId: string,
): Promise<string> {
  const client = getClient()
  try {
    // Fetch source channel and message
    const srcCh = await client.channels.fetch(sourceChannelId)
    if (!srcCh || !srcCh.isTextBased()) {
      throw new Error(`source channel ${sourceChannelId} not found or not text-based`)
    }
    const srcMsg: Message = await srcCh.messages.fetch(sourceMessageId)

    // Fetch target channel
    const dstCh = await client.channels.fetch(targetChannelId)
    if (!dstCh || !dstCh.isTextBased() || !('send' in dstCh)) {
      throw new Error(`target channel ${targetChannelId} not found or not sendable`)
    }

    // Build forwarded content
    const originUrl = srcMsg.url
    const authorName = srcMsg.author.username
    const lines: string[] = []

    lines.push(`**[Forwarded from ${authorName}](<${originUrl}>)**`)
    if (srcMsg.content) {
      lines.push(srcMsg.content)
    }

    // List attachment references
    if (srcMsg.attachments.size > 0) {
      lines.push('')
      for (const att of srcMsg.attachments.values()) {
        const label = att.name ?? att.id
        lines.push(`📎 [${label}](${att.url})`)
      }
    }

    const sent = await (dstCh as TextChannel).send(lines.join('\n'))
    return sent.id
  } catch (err) {
    process.stderr.write(`pinchcord channels: forwardMessage failed: ${err}\n`)
    throw err
  }
}
