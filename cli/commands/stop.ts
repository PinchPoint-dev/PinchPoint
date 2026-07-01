import { platform } from 'os'
import type { Ctx } from '../lib/ctx'
import { sh, SESSION_PREFIX, LEGACY_SESSION, sessionFor, resolveMode } from './launch'

// All fleet sessions: per-bot "Pinchcord-<Bot>" plus the legacy combined
// "Pinchcord" session from before the one-session-per-bot split.
async function fleetSessions(viaWsl: boolean): Promise<string[]> {
  const r = await sh(['tmux', 'list-sessions', '-F', '#{session_name}'], viaWsl)
  if (r.code !== 0) return []
  return r.stdout.trim().split('\n').filter(s => s.startsWith(SESSION_PREFIX) || s === LEGACY_SESSION)
}

export async function run(ctx: Ctx): Promise<string> {
  const mode = resolveMode(ctx.flags)
  if (mode === 'wt') throw new Error('stop: wt mode — close the tab, or kill the claude process for that bot (see pinchcord ps --mode wt)')
  const viaWsl = mode === 'wsl' && platform() === 'win32'

  if (ctx.flags.all) {
    const sessions = await fleetSessions(viaWsl)
    if (sessions.length === 0) return 'nothing to stop (no fleet tmux sessions)'
    for (const s of sessions) await sh(['tmux', 'kill-session', '-t', `=${s}`], viaWsl)
    return `killed: ${sessions.join(', ')}`
  }

  const [bot] = ctx.positionals
  if (!bot) throw new Error('stop: usage: stop <bot> | stop --all')
  const sessions = await fleetSessions(viaWsl)
  if (sessions.includes(sessionFor(bot))) {
    const r = await sh(['tmux', 'kill-session', '-t', `=${sessionFor(bot)}`], viaWsl)
    return r.code === 0 ? `stopped ${bot}` : `stop failed: ${r.stderr.trim()}`
  }
  if (sessions.includes(LEGACY_SESSION)) {
    const r = await sh(['tmux', 'kill-window', '-t', `=${LEGACY_SESSION}:${bot}`], viaWsl)
    if (r.code === 0) return `stopped ${bot} (legacy combined session)`
  }
  return `nothing to stop: ${bot} is not running`
}
