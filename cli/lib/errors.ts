// Discord JSON error codes → one-line actionable hints, so a failed CLI call
// costs the bot exactly one corrected retry.
const HINTS: Record<number, string> = {
  10003: 'channel not found — check the --channel id',
  10008: 'message not found — wrong --channel, or the message was deleted',
  50001: 'bot has no access to that channel',
  50013: 'bot lacks permission for this action in that channel',
  50035: 'invalid body — usually content over the 2000-char cap; split or use send (auto-chunks)',
  50083: 'thread is archived — thread send auto-unarchives; other commands cannot post there',
  160002: 'that message cannot be replied to — send without --reply-to',
}

export function describeError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  const raw = (err as { code?: number | string })?.code
  const code = typeof raw === 'string' ? Number(raw) : raw
  if (typeof code === 'number' && HINTS[code]) return `${base} — ${HINTS[code]}`
  return base
}
