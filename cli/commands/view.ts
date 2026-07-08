import { platform } from 'os'
import { join } from 'path'
import type { Ctx } from '../lib/ctx'
import { buildAttachCmd, winToWsl } from '../lib/fleet'
import { resolveMode, sh, selectBots } from './launch'

// `pinchcord view <Bot>` — open a literal codex TUI attached to the thread the
// bot's adapter is driving on its home channel, so a founder can watch it work
// (and type into it). The adapter publishes the live channel→thread map to
// <stateDir>/threads.json (0600); the viewer loop (codex/view-loop.sh) reads
// the home-channel thread and runs `codex resume <thread> --remote <url>`,
// re-attaching if the thread resets (app-server restart, `<bot> reset`).
//
// The loop lives in a committed script, NOT an inline string: passing a
// multi-line shell through tmux -> sh -c -> bash -lc let the outer shell blank
// out every $-expansion before bash ran it. A script invoked as
// `bash '<script>' '<threadsFile>'` (both quote-free paths) sidesteps that.

export const VIEW_SESSION_PREFIX = 'Codex-View-'
export const viewSessionFor = (bot: string) => `${VIEW_SESSION_PREFIX}${bot}`

const VIEW_LOOP_REL = ['..', 'codex', 'view-loop.sh'] as const

function insideWsl(): boolean {
  return platform() === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
}

export async function run(ctx: Ctx): Promise<string> {
  const mode = resolveMode(ctx.flags) // wsl | wt | mac
  const viaWsl = mode === 'wsl' && platform() === 'win32'
  const tr = mode === 'wsl' ? winToWsl : (p: string) => p

  const bots = selectBots(ctx)
  if (bots.length !== 1) throw new Error('view: name exactly one bot, e.g. `pinchcord view Genna`')
  const [name, bot] = bots[0]
  if (bot.runtime !== 'codex') throw new Error(`view: "${name}" is a ${bot.runtime} bot — the codex TUI viewer only applies to codex bots`)

  // Resolve the bot's state dir the same way launch does, then its threads.json.
  const homeRes = await sh(['bash', '-lc', 'echo $HOME'], viaWsl)
  const home = homeRes.stdout.trim()
  if (!home) throw new Error('view: could not resolve $HOME in the target environment')
  const threadsFile = `${home}/.claude/channels/discord-${name.toLowerCase()}/threads.json`
  const scriptPath = tr(join(import.meta.dir, ...VIEW_LOOP_REL))

  const session = viewSessionFor(name)

  // If a viewer session is already live, just (re)open its tab rather than
  // stacking a second codex TUI on the same thread.
  const has = await sh(['tmux', 'has-session', '-t', `=${session}`], viaWsl)
  if (has.code !== 0) {
    // Both args are quote-free paths (bot name is validated A-Za-z0-9_-;
    // state/script paths contain no quotes), so single-quoting is safe and the
    // loop's own $-expansions survive.
    const r = await sh(['tmux', 'new-session', '-d', '-s', session, '-n', `view-${name}`,
      `bash '${scriptPath}' '${threadsFile}'`], viaWsl)
    if (r.code !== 0) throw new Error(`view: failed to start viewer session: ${r.stderr.trim()}`)
    await sh(['tmux', 'set-option', '-w', '-t', `=${session}:`, 'remain-on-exit', 'on'], viaWsl)
  }

  // Pop a visible terminal tab attached to the viewer session (unless detached
  // or already visible), mirroring launch's behaviour.
  const popMode = viaWsl || insideWsl() ? 'wsl' as const : mode === 'mac' ? 'mac' as const : null
  if (ctx.flags.detach || !popMode) {
    return `viewer running — attach with: ${viaWsl ? 'wsl ' : ''}tmux attach -t ${session}`
  }
  const clients = await sh(['tmux', 'list-clients', '-t', `=${session}`, '-F', 'x'], viaWsl)
  if (!clients.stdout.trim()) {
    const argv = buildAttachCmd(popMode, session, `view-${name}`)
    if (insideWsl()) argv[0] = '/mnt/c/Windows/System32/cmd.exe'
    Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
    return `opened codex viewer tab for ${name} (attached to its live thread; re-attaches on reset)`
  }
  return `${name} viewer already visible in an attached terminal`
}
