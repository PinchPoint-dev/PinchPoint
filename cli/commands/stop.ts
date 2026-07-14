import { platform } from 'os'
import type { Ctx } from '../lib/ctx'
import { sh, SESSION_PREFIX, LEGACY_SESSION, sessionFor, appServerSessionFor, resolveMode } from './launch'
import { VIEW_SESSION_PREFIX, viewSessionFor } from './view'

// A running codex bot is up to three tmux sessions: the adapter
// (Pinchcord-<Bot>), its supervised app-server (Codex-<Bot>-Server), and the
// TUI viewer (Codex-View-<Bot>). Stop takes down all of them — killing only
// the adapter left the app-server and viewer running headless forever.
export const codexSessionsFor = (bot: string) => [appServerSessionFor(bot), viewSessionFor(bot)]

export const APP_SERVER_SESSION_RX = /^Codex-.+-Server$/

export function isFleetSession(s: string): boolean {
  return s.startsWith(SESSION_PREFIX) || s === LEGACY_SESSION
    || s.startsWith(VIEW_SESSION_PREFIX) || APP_SERVER_SESSION_RX.test(s)
}

// All fleet sessions: per-bot "Pinchcord-<Bot>" (plus the legacy combined
// "Pinchcord" session from before the one-session-per-bot split) and the codex
// app-server/viewer sessions.
async function fleetSessions(viaWsl: boolean): Promise<string[]> {
  const r = await sh(['tmux', 'list-sessions', '-F', '#{session_name}'], viaWsl)
  if (r.code !== 0) return []
  return r.stdout.trim().split('\n').filter(isFleetSession)
}

// Killing an app-server's tmux session HUPs the supervisor shell but the codex
// child can detach and keep the port (observed: node app-server processes
// outliving their session). app-server.sh now traps and kills its child, but
// clear the port here too so stop also cleans up after pre-trap servers.
async function clearAppServerPort(ctx: Ctx, bot: string, viaWsl: boolean): Promise<void> {
  const e = ctx.bots[bot] as Record<string, string> | undefined
  if (e?.runtime !== 'codex') return
  const port = ((e.appServerUrl || '').match(/:(\d+)(?:\/|$)/) || [])[1] || '3848'
  await sh(['bash', '-lc', `fuser -k ${port}/tcp >/dev/null 2>&1 || true`], viaWsl)
}

export async function run(ctx: Ctx): Promise<string> {
  const mode = resolveMode(ctx.flags)
  if (mode === 'wt') throw new Error('stop: wt mode — close the tab, or kill the claude process for that bot (see pinchcord ps --mode wt)')
  const viaWsl = mode === 'wsl' && platform() === 'win32'

  if (ctx.flags.all) {
    const sessions = await fleetSessions(viaWsl)
    if (sessions.length === 0) return 'nothing to stop (no fleet tmux sessions)'
    for (const s of sessions) await sh(['tmux', 'kill-session', '-t', `=${s}`], viaWsl)
    for (const bot of Object.keys(ctx.bots)) await clearAppServerPort(ctx, bot, viaWsl)
    return `killed: ${sessions.join(', ')}`
  }

  const [bot] = ctx.positionals
  if (!bot) throw new Error('stop: usage: stop <bot> | stop --all')
  const sessions = await fleetSessions(viaWsl)
  const targets = [sessionFor(bot), ...codexSessionsFor(bot)].filter(s => sessions.includes(s))
  if (targets.length) {
    const failed: string[] = []
    for (const s of targets) {
      const r = await sh(['tmux', 'kill-session', '-t', `=${s}`], viaWsl)
      if (r.code !== 0) failed.push(`${s}: ${r.stderr.trim()}`)
    }
    await clearAppServerPort(ctx, bot, viaWsl)
    if (failed.length) return `stop failed: ${failed.join('; ')}`
    return targets.length > 1 ? `stopped ${bot} (${targets.join(', ')})` : `stopped ${bot}`
  }
  if (sessions.includes(LEGACY_SESSION)) {
    const r = await sh(['tmux', 'kill-window', '-t', `=${LEGACY_SESSION}:${bot}`], viaWsl)
    if (r.code === 0) return `stopped ${bot} (legacy combined session)`
  }
  // No sessions, but a pre-trap app-server's processes may still hold the port.
  await clearAppServerPort(ctx, bot, viaWsl)
  return `nothing to stop: ${bot} is not running`
}
