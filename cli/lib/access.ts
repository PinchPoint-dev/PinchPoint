// Hub-channel access policy for per-bot access.json files.
//
// The hub is the fleet's broadcast channel: every message there (human or bot)
// must reach every bot, so the hub group policy is requireMention: false.
// An earlier version of setup baked requireMention: true, which silently
// dropped any human message that didn't @mention the bot — migrateHubPolicy
// repairs exactly that shape and nothing else.

export interface GroupPolicy {
  requireMention?: boolean
  allowFrom?: string[]
}

export interface AccessShape {
  dmPolicy?: string
  allowFrom?: string[]
  pending?: Record<string, unknown>
  groups?: Record<string, GroupPolicy>
  [key: string]: unknown
}

export function defaultAccess(channelId: string): AccessShape {
  return {
    dmPolicy: 'allowlist',
    allowFrom: [],
    pending: {},
    groups: { [channelId]: { requireMention: false, allowFrom: [] } },
  }
}

/**
 * Ensure the hub channel group exists and delivers un-mentioned messages.
 * Migrates only the old broken default (requireMention: true + empty
 * allowFrom); any other combination is human customization and is preserved.
 */
export function ensureHubPolicy(access: AccessShape, channelId: string): { access: AccessShape; changed: boolean } {
  const groups = access.groups ?? {}
  const policy = groups[channelId]
  if (!policy) {
    return {
      access: { ...access, groups: { ...groups, [channelId]: { requireMention: false, allowFrom: [] } } },
      changed: true,
    }
  }
  const isOldDefault = policy.requireMention === true && (policy.allowFrom ?? []).length === 0
  if (isOldDefault) {
    return {
      access: { ...access, groups: { ...groups, [channelId]: { ...policy, requireMention: false } } },
      changed: true,
    }
  }
  return { access, changed: false }
}
