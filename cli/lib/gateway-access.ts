// Inbound group-message delivery decision, shared by any bot runtime whose
// Discord connection is NOT the slim MCP gateway (today: the Codex adapter).
//
// The Claude fleet gets this filtering for free from server.ts's gateway. A
// Codex bot owns its own discord.js client, so it must reproduce the SAME
// group/requireMention semantics — otherwise it would hear channels it should
// not (the crossed-wires bug WP1 fixes) or miss mention-gated #main.
//
// This mirrors server.ts's group branch (the `access.groups[channelId]` block):
//   - a channel not present in `groups` is dropped;
//   - a group `allowFrom` (when non-empty) restricts senders;
//   - `requireMention` defaults TRUE, and is satisfied by a mention.
// `@everyone`/`@here` count as a mention because discord.js `mentions.has`
// counts them — the caller computes `mentioned` and passes it in, keeping this
// function pure and unit-testable.

export interface GroupPolicy {
  requireMention?: boolean
  allowFrom?: string[]
}

export interface GatewayAccess {
  groups?: Record<string, GroupPolicy>
}

export interface DeliveryInput {
  /** Root channel id: for a thread, its parent channel; otherwise the channel. */
  channelId: string
  /** Author id of the inbound message. */
  senderId: string
  /** Whether the message mentions this bot (direct @, @everyone/@here, etc.). */
  mentioned: boolean
}

/** True when the gateway would deliver this group message to the bot. */
export function groupDelivers(access: GatewayAccess, input: DeliveryInput): boolean {
  const policy = access.groups?.[input.channelId]
  if (!policy) return false // channel not in groups → never delivered
  const allowFrom = policy.allowFrom ?? []
  if (allowFrom.length > 0 && !allowFrom.includes(input.senderId)) return false
  const requireMention = policy.requireMention ?? true // default-true, as the gateway
  if (requireMention && !input.mentioned) return false
  return true
}

/**
 * Access used when a bot has no access.json (or an unreadable one): fall back
 * to the pre-access-file behaviour — deliver everything in the single hub
 * channel, no mention gate.
 */
export function fallbackAccess(hubChannelId: string): GatewayAccess {
  return { groups: { [hubChannelId]: { requireMention: false, allowFrom: [] } } }
}
