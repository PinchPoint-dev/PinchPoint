import { homedir, platform } from 'os'
import { join } from 'path'
import type { Ctx } from '../lib/ctx'
import { winToWsl, buildWindowShell, buildAttachCmd, translateExtraArgs, type FleetBot } from '../lib/fleet'
import { ensureViewerSession } from './view'

const CODEX_ADAPTER_REL = ['..', 'codex', 'adapter.ts'] as const
const CODEX_APPSERVER_REL = ['..', 'codex', 'app-server.sh'] as const

export const appServerSessionFor = (bot: string) => `Codex-${bot}-Server`

// Ensure a codex bot's supervised app-server is up before its adapter starts.
// Previously the app-server was a manual step that stayed dead after any
// crash/port-conflict, stranding the adapter (WebSocket 1006) and the viewer.
// Now `pinchcord launch` brings up app-server.sh (auto-restart + port-clear) in
// a Codex-<Bot>-Server session and waits for /readyz.
async function ensureCodexAppServer(bot: FleetBot, scriptPath: string, viaWsl: boolean): Promise<string> {
  const url = bot.appServerUrl || 'ws://127.0.0.1:3848'
  const port = (url.match(/:(\d+)(?:\/|$)/) || [])[1] || '3848'
  const session = appServerSessionFor(bot.name)
  const rdz = `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/readyz`
  const has = await sh(['tmux', 'has-session', '-t', `=${session}`], viaWsl)
  if (has.code === 0) {
    const ready = await sh(['bash', '-lc', rdz], viaWsl)
    if (ready.stdout.trim() === '200') return `  · ${bot.name}: app-server already up (:${port})`
    await sh(['tmux', 'kill-session', '-t', `=${session}`], viaWsl) // dead/stuck → recreate
  }
  const r = await sh(['tmux', 'new-session', '-d', '-s', session, '-n', `${bot.name}-server`, `bash '${scriptPath}' '${port}'`], viaWsl)
  if (r.code !== 0) return `  ✗ ${bot.name}: app-server start failed: ${r.stderr.trim()}`
  await sh(['tmux', 'set-option', '-w', '-t', `=${session}:`, 'remain-on-exit', 'on'], viaWsl)
  for (let i = 0; i < 20; i++) {
    const ready = await sh(['bash', '-lc', rdz], viaWsl)
    if (ready.stdout.trim() === '200') return `  · ${bot.name}: app-server up (:${port}, supervised)`
    await Bun.sleep(1000)
  }
  return `  ⚠ ${bot.name}: app-server not ready after 20s (:${port}) — check tmux ${session}`
}

// One tmux session per bot ("Pinchcord-Bee", "Pinchcord-Owl", …): every bot
// gets its own attached terminal tab, all bots visible at once. A single
// shared session only ever showed its active window — bots were running but
// invisible without tmux keybindings.
export const SESSION_PREFIX = 'Pinchcord-'
export const sessionFor = (bot: string) => `${SESSION_PREFIX}${bot}`
// The pre-split combined session; stop/ps still recognize it for cleanup.
export const LEGACY_SESSION = 'Pinchcord'

// The dev-channels trust dialog defaults to "1. I am using this for local
// development" — a bare Enter confirms it. (Down+Enter would select "2. Exit".)
export const TRUST_DIALOG_RX = /Loading development channels|local development/i
// Rendered by claude once channels are live — the definitive "bot is up" marker.
export const READY_RX = /Channels \(experimental\)/i
// Printed by the codex adapter (codex/adapter.ts) once its Discord client is
// live. A codex bot has no channels-trust dialog, so this is its only marker.
export const CODEX_READY_RX = /codex adapter ready/i

// Run a command; in wsl mode from Windows, wrap through wsl.exe.
export async function sh(argv: string[], viaWsl: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = viaWsl ? ['wsl.exe', '-e', ...argv] : argv
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

export function resolveMode(flags: Record<string, unknown>): 'wsl' | 'wt' | 'mac' {
  const m = typeof flags.mode === 'string' ? flags.mode : 'wsl'
  if (m !== 'wsl' && m !== 'wt' && m !== 'mac') throw new Error(`launch: unknown --mode ${m} (wsl | wt | mac)`)
  return m
}

// Running INSIDE WSL (e.g. a bot launching a colleague): tmux runs directly,
// but the visible terminal must still open on the Windows desktop via interop.
function insideWsl(): boolean {
  return platform() === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
}

// bots.json fields are interpolated into shell (bash -lc) and PowerShell
// lines. Rather than escaping for two shells, reject the characters that
// would break quoting: names stay conservative (they also become tmux session
// names, tab titles, and state-dir names), paths just can't contain quotes.
const NAME_RX = /^[A-Za-z0-9_-]+$/
const WORD_RX = /^[A-Za-z0-9._-]+$/ // effort / model — interpolated unquoted
function rejectQuotes(name: string, field: string, v: string): void {
  if (v.includes("'") || v.includes('"')) {
    throw new Error(`launch: bot "${name}" ${field} contains a quote character — not supported in launch paths: ${v}`)
  }
}

export function selectBots(ctx: Ctx): [string, FleetBot][] {
  const names = ctx.positionals.length ? ctx.positionals : Object.keys(ctx.bots)
  return names.map(name => {
    if (!NAME_RX.test(name)) throw new Error(`launch: bot name "${name}" must match A-Za-z0-9_- (it becomes shell commands, tmux session names, and tab titles)`)
    const e = ctx.bots[name] as Record<string, string> | undefined
    if (!e?.token) throw new Error(`launch: bot "${name}" not in bots.json (or missing token)`)
    if (!e.workDir || !e.promptFile) throw new Error(`launch: bot "${name}" needs workDir and promptFile in bots.json`)
    rejectQuotes(name, 'workDir', e.workDir)
    rejectQuotes(name, 'promptFile', e.promptFile)
    if (e.effort && !WORD_RX.test(e.effort)) throw new Error(`launch: bot "${name}" effort "${e.effort}" contains unsupported characters`)
    if (e.model && !WORD_RX.test(e.model)) throw new Error(`launch: bot "${name}" model "${e.model}" contains unsupported characters`)
    if (e.runtime && e.runtime !== 'claude' && e.runtime !== 'codex') throw new Error(`launch: bot "${name}" runtime "${e.runtime}" must be "claude" or "codex"`)
    if (e.appServerUrl) rejectQuotes(name, 'appServerUrl', e.appServerUrl)
    const runtime: FleetBot['runtime'] = e.runtime === 'codex' ? 'codex' : 'claude'
    return [name, {
      name, token: e.token, channelId: e.channelId ?? '',
      workDir: e.workDir, promptFile: e.promptFile, effort: e.effort, model: e.model,
      extraArgs: e.extraArgs, runtime, appServerUrl: e.appServerUrl,
    }]
  })
}

async function wslHome(viaWsl: boolean): Promise<string> {
  if (!viaWsl) return homedir()
  const r = await sh(['bash', '-lc', 'echo $HOME'], true)
  return r.stdout.trim()
}

// Resolve a NATIVE bun in the target env — one whose path is not under /mnt/*
// (a Windows bun shim reachable via WSL interop). Native-Linux claude must spawn
// the MCP stdio server with a native bun; the Windows shim resolves homedir() to
// the Windows profile and pipes stdio unreliably across the interop boundary.
async function resolveTargetBun(viaWsl: boolean): Promise<string> {
  const r = await sh(['bash', '-lc',
    'for b in "$HOME/.bun/bin/bun" $(command -v bun 2>/dev/null); do case "$b" in /mnt/*) ;; *) if [ -x "$b" ]; then echo "$b"; exit 0; fi;; esac; done; exit 1'], viaWsl)
  const bun = r.stdout.trim().split('\n')[0]
  if (r.code !== 0 || !bun) {
    throw new Error('launch: no native bun found in the target environment. Install it there (curl -fsSL https://bun.sh/install | bash) — a Windows bun shim cannot host the MCP server for native-Linux claude.')
  }
  return bun
}

// Wait for a bot session to reach the live REPL, approving the dev-channels
// trust dialog when (and only when) it actually renders. Replaces the old
// blind 8-second Down+Enter, which missed slow starts (bot stuck at the
// dialog forever) and pressed keys into nothing on fast ones.
async function waitForReady(bot: FleetBot, viaWsl: boolean): Promise<string> {
  const name = bot.name
  const isCodex = bot.runtime === 'codex'
  // Codex bots print CODEX_READY_RX and have no channels-trust dialog; claude
  // bots render READY_RX after approving TRUST_DIALOG_RX.
  const readyRx = isCodex ? CODEX_READY_RX : READY_RX
  const runtimeLabel = isCodex ? 'codex' : 'claude'
  // "=name:" — exact session match, and the trailing colon makes it a valid
  // pane target. Pane-target commands (display-message, capture-pane,
  // send-keys) silently no-op on a bare "=name".
  const target = `=${sessionFor(name)}:`
  const deadline = Date.now() + 75_000
  let approved = false
  while (Date.now() < deadline) {
    const dead = await sh(['tmux', 'display-message', '-p', '-t', target, '#{pane_dead}'], viaWsl)
    if (dead.code !== 0) return `  ✗ ${name}: tmux session vanished during startup`
    const cap = await sh(['tmux', 'capture-pane', '-p', '-t', target], viaWsl)
    const text = cap.stdout
    if (dead.stdout.trim() === '1') {
      const tail = text.split('\n').filter(l => l.trim()).slice(-6).map(l => `      ${l}`).join('\n')
      return `  ✗ ${name}: ${runtimeLabel} exited during startup — session kept for inspection:\n${tail}`
    }
    if (!isCodex && !approved && TRUST_DIALOG_RX.test(text)) {
      await sh(['tmux', 'send-keys', '-t', target, 'Enter'], viaWsl)
      approved = true
    }
    if (readyRx.test(text)) return `  ✓ ${name}: ready (${isCodex ? 'codex adapter live' : 'channels live'})`
    await Bun.sleep(1500)
  }
  return `  ⚠ ${name}: not ready after 75s — inspect: ${viaWsl ? 'wsl ' : ''}tmux attach -t ${sessionFor(name)}`
}

export async function run(ctx: Ctx): Promise<string> {
  const mode = resolveMode(ctx.flags)
  if (mode === 'wt') return (await import('./launch-wt')).launchWt(ctx)

  // wsl + mac share the tmux path; wsl from Windows additionally wraps via wsl.exe.
  const viaWsl = mode === 'wsl' && platform() === 'win32'
  const tr = mode === 'wsl' ? winToWsl : (p: string) => p
  const mcpConfig = tr(join(process.cwd(), '.pinchme', 'cord', 'mcp-config.posix.json'))
  const adapterPath = tr(join(import.meta.dir, ...CODEX_ADAPTER_REL))
  const appServerScript = tr(join(import.meta.dir, ...CODEX_APPSERVER_REL))

  const bots = selectBots(ctx)
  const needsClaude = bots.some(([, b]) => b.runtime !== 'codex')

  // Preflight: things setup cannot provide. (bun is resolved natively below;
  // the pinchcord shim is created by the in-target setup that follows it.)
  // claude is only required when a claude-runtime bot is in the launch set — a
  // pure codex fleet runs on bun + the adapter alone.
  const preCmd = needsClaude ? 'command -v tmux && command -v claude' : 'command -v tmux'
  const pre = await sh(['bash', '-lc', preCmd], viaWsl)
  if (pre.code !== 0) throw new Error(`launch: target is missing tmux${needsClaude ? '/claude' : ''} on PATH:\n${pre.stdout}${pre.stderr}`)

  // Auto-provision target-native artifacts (mcp-config.posix.json with native
  // bun + target paths, the POSIX pinchcord shim, per-bot state dirs with .env
  // and access.json) by running setup with the TARGET's own bun. This is what
  // makes launch zero-touch: a bot can launch a colleague with no prior manual
  // setup in that environment. (wt mode is a separate native-Windows path
  // handled above and is unaffected.)
  const targetBun = await resolveTargetBun(viaWsl)
  const wslCli = tr(join(import.meta.dir, '..', 'cli.ts'))
  const wslRepo = tr(process.cwd())
  const setupRes = await sh(['bash', '-lc', `cd '${wslRepo}' && '${targetBun}' '${wslCli}' setup`], viaWsl)
  if (setupRes.code !== 0) throw new Error(`launch: in-target setup failed:\n${setupRes.stdout}${setupRes.stderr}`)

  const home = await wslHome(viaWsl)
  const out: string[] = [`launching one tmux session per bot (${mode})`]
  const started: FleetBot[] = []
  for (const [name, bot] of bots) {
    const session = sessionFor(name)
    // A live bot is skipped (relaunching would create a second claude on the
    // same token + state dir); a dead one is cleared and relaunched.
    const has = await sh(['tmux', 'has-session', '-t', `=${session}`], viaWsl)
    if (has.code === 0) {
      // Pane target needs the trailing colon (see waitForReady). Kill only on
      // a POSITIVE dead signal — a failed display-message must not take down
      // a live session, so "can't tell" is treated as running.
      const dead = await sh(['tmux', 'display-message', '-p', '-t', `=${session}:`, '#{pane_dead}'], viaWsl)
      if (dead.code !== 0 || dead.stdout.trim() !== '1') {
        out.push(`  ↻ ${name}: already running — use \`pinchcord restart ${name}\` to relaunch`)
        continue
      }
      await sh(['tmux', 'kill-session', '-t', `=${session}`], viaWsl)
    }
    const stateDir = `${home}/.claude/channels/discord-${name.toLowerCase()}`
    const launchBot: FleetBot = {
      ...bot,
      workDir: tr(bot.workDir),
      promptFile: tr(bot.promptFile),
      extraArgs: bot.extraArgs ? translateExtraArgs(bot.extraArgs, tr) : undefined,
    }
    // Codex bots need their supervised app-server up first; the adapter would
    // otherwise loop on WebSocket 1006 against a dead backend.
    if (bot.runtime === 'codex') {
      out.push(await ensureCodexAppServer(launchBot, appServerScript, viaWsl))
    }
    const shell = buildWindowShell(launchBot, { mcpConfig, stateDir, adapterPath })
    const r = await sh(['tmux', 'new-session', '-d', '-s', session, '-n', name, `bash -lc "${shell.replace(/"/g, '\\"')}"`], viaWsl)
    if (r.code !== 0) { out.push(`  ✗ ${name}: ${r.stderr.trim()}`); continue }
    // Keep the pane (and the bot's last output) around if it dies, so a failed
    // start is inspectable instead of silently vanishing.
    await sh(['tmux', 'set-option', '-w', '-t', `=${session}:`, 'remain-on-exit', 'on'], viaWsl)
    started.push(launchBot)
  }

  // All started bots approve + boot concurrently; report each one's outcome.
  const results = await Promise.all(started.map(bot => waitForReady(bot, viaWsl)))
  out.push(...results)

  // Pop one visible terminal tab per bot (grouped in a single "pinchcord"
  // Windows Terminal window) so the whole fleet shows up on the desktop —
  // the default, including when a bot inside WSL launches a colleague
  // (interop). Bots already showing in an attached terminal are skipped.
  // --detach keeps the headless behaviour. Spawns are best-effort: a failure
  // (no wt.exe / headless) never fails the launch — tmux holds the bots.
  const popMode = viaWsl || insideWsl() ? 'wsl' as const : mode === 'mac' ? 'mac' as const : null
  if (ctx.flags.detach) {
    out.push(`detached — attach with: ${viaWsl ? 'wsl ' : ''}tmux attach -t ${SESSION_PREFIX}<Bot>`)
  } else if (popMode) {
    let opened = 0
    for (const [name, bot] of bots) {
      let session = sessionFor(name)
      const has = await sh(['tmux', 'has-session', '-t', `=${session}`], viaWsl)
      if (has.code !== 0) continue
      // A codex bot's visible surface is the typeable codex-TUI viewer
      // (Codex-View-<Bot>), never the raw adapter log — the adapter session
      // stays headless. Viewer failure is best-effort, like the tab spawns.
      if (bot.runtime === 'codex') {
        try {
          session = await ensureViewerSession(name, bot, viaWsl, tr)
        } catch (e) {
          out.push(`  ⚠ ${name}: viewer failed to start (${e instanceof Error ? e.message : e}) — adapter log: ${viaWsl ? 'wsl ' : ''}tmux attach -t ${sessionFor(name)}`)
          continue
        }
      }
      const clients = await sh(['tmux', 'list-clients', '-t', `=${session}`, '-F', 'x'], viaWsl)
      if (clients.stdout.trim()) continue // already visible in some terminal
      const argv = buildAttachCmd(popMode, session, name)
      // From inside WSL, reach the Windows shell via the interop mount.
      if (insideWsl()) argv[0] = '/mnt/c/Windows/System32/cmd.exe'
      Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
      opened++
      // Serialize tab creation: parallel `wt -w pinchcord` racers can spawn
      // two separate windows instead of grouping into one.
      await Bun.sleep(900)
    }
    out.push(opened
      ? `opened ${opened} terminal tab(s) — one per bot (close freely; bots keep running)`
      : 'all bot sessions already visible in attached terminals')
  } else {
    out.push(`attach with: tmux attach -t ${SESSION_PREFIX}<Bot>`)
  }
  return out.join('\n')
}
