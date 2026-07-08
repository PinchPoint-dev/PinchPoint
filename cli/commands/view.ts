import { platform } from 'os'
import type { Ctx } from '../lib/ctx'
import { buildAttachCmd } from '../lib/fleet'
import { resolveMode, sh, selectBots } from './launch'

// `pinchcord view <Bot>` — open a literal codex TUI attached to the thread the
// bot's adapter is driving on its home channel, so a founder can watch it work
// (and type into it). The adapter publishes the live channel→thread map to
// <stateDir>/threads.json (0600); this reads the home-channel thread and runs
// `codex resume <thread> --remote <appServerUrl>` in a tmux tab.
//
// The viewer runs a re-attach loop: if the thread resets (app-server restart,
// `<bot> reset`), codex exits and the loop re-reads the file and re-attaches to
// the new thread — no manual re-run.

export const VIEW_SESSION_PREFIX = 'Codex-View-'
export const viewSessionFor = (bot: string) => `${VIEW_SESSION_PREFIX}${bot}`

function insideWsl(): boolean {
  return platform() === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
}

// The shell that runs inside the viewer's tmux window. Reads everything (app
// server url, home channel id, current thread, optional auth-token env name)
// from the adapter's threads.json each iteration, so it always attaches to the
// current thread and survives resets. `env -u OPENAI_API_KEY` keeps codex on
// the ChatGPT subscription (same as the bots).
export function buildViewerShell(bot: string, threadsFile: string): string {
  // Single-quoted heredoc-free bash; $VARS are expanded at run time inside the
  // viewer, not here. threadsFile is validated quote-free by selectBots-style
  // name rules upstream (bot name) + a fixed path, so interpolation is safe.
  return [
    `F='${threadsFile}'`,
    `echo "pinchcord view: ${bot} — watching $F"`,
    'while true; do',
    '  if [ ! -f "$F" ]; then echo "waiting for ' + bot + ' to start (no threads.json yet)…"; sleep 3; continue; fi',
    '  URL=$(jq -r ".appServerUrl // empty" "$F" 2>/dev/null)',
    '  CH=$(jq -r ".homeChannelId // empty" "$F" 2>/dev/null)',
    '  TID=$(jq -r --arg c "$CH" ".threads[$c] // empty" "$F" 2>/dev/null)',
    '  AENV=$(jq -r ".authTokenEnv // empty" "$F" 2>/dev/null)',
    '  if [ -z "$TID" ] || [ -z "$URL" ]; then echo "waiting for ' + bot + ' home-channel thread…"; sleep 3; continue; fi',
    '  echo "attaching to ' + bot + ' thread $TID on $URL…"',
    '  if [ -n "$AENV" ]; then',
    '    env -u OPENAI_API_KEY codex resume "$TID" --remote "$URL" --remote-auth-token-env "$AENV"',
    '  else',
    '    env -u OPENAI_API_KEY codex resume "$TID" --remote "$URL"',
    '  fi',
    '  echo "viewer detached (thread ended/reset) — re-checking in 2s…"; sleep 2',
    'done',
  ].join('\n')
}

export async function run(ctx: Ctx): Promise<string> {
  const mode = resolveMode(ctx.flags) // wsl | wt | mac; wt falls back to wsl behaviour for attach
  const viaWsl = mode === 'wsl' && platform() === 'win32'

  const bots = selectBots(ctx)
  if (bots.length !== 1) throw new Error('view: name exactly one bot, e.g. `pinchcord view Genna`')
  const [name, bot] = bots[0]
  if (bot.runtime !== 'codex') throw new Error(`view: "${name}" is a ${bot.runtime} bot — the codex TUI viewer only applies to codex bots`)

  // Resolve the bot's state dir the same way launch does, then its threads.json.
  const homeRes = await sh(['bash', '-lc', 'echo $HOME'], viaWsl)
  const home = homeRes.stdout.trim()
  const stateDir = `${home}/.claude/channels/discord-${name.toLowerCase()}`
  const threadsFile = `${stateDir}/threads.json`

  const session = viewSessionFor(name)

  // If a viewer session is already live, just (re)open its tab rather than
  // stacking a second codex TUI on the same thread.
  const has = await sh(['tmux', 'has-session', '-t', `=${session}`], viaWsl)
  if (has.code !== 0) {
    const shell = buildViewerShell(name, threadsFile)
    const r = await sh(['tmux', 'new-session', '-d', '-s', session, '-n', `view-${name}`, `bash -lc "${shell.replace(/"/g, '\\"')}"`], viaWsl)
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
