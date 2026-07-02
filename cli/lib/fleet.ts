export type BotRuntime = 'claude' | 'codex'

export interface FleetBot {
  name: string
  token: string
  channelId: string
  workDir: string      // absolute; already translated for the target platform
  promptFile: string   // absolute; already translated
  effort?: string
  model?: string
  extraArgs?: string   // raw extra claude flags from bots.json (e.g. --add-dir "...")
  runtime?: BotRuntime // default 'claude'; 'codex' runs the app-server adapter
  appServerUrl?: string // codex only: Codex app-server ws url (default ws://127.0.0.1:3848)
}

export interface LaunchOpts {
  mcpConfig: string    // absolute path, target-platform form (claude runtime)
  stateDir: string     // per-bot state dir, target-platform form
  adapterPath?: string // absolute path to codex/adapter.ts, target-platform form (codex runtime)
}

export function winToWsl(p: string): string {
  const m = p.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!m) return p.replace(/\\/g, '/')
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

// Translate Windows paths embedded in a raw extraArgs string — both
// double-quoted ("C:\x y") and bare (C:\x) forms — using the given path
// translator, re-quoting for sh. bots.json holds Windows paths (e.g. Owl's
// --add-dir), but wsl/mac bots need them in target form.
export function translateExtraArgs(s: string, tr: (p: string) => string): string {
  return s
    .replace(/"([A-Za-z]:[\\/][^"]*)"/g, (_, p: string) => `'${tr(p)}'`)
    .replace(/(^|\s)([A-Za-z]:[\\/][^\s"']+)/g, (_, pre: string, p: string) => `${pre}'${tr(p)}'`)
}

export function buildClaudeCmd(bot: FleetBot, opts: LaunchOpts): string {
  return [
    'claude',
    '--dangerously-load-development-channels server:pinchcord-slim',
    `--mcp-config '${opts.mcpConfig}'`,
    '--strict-mcp-config',
    bot.promptFile ? `--append-system-prompt-file '${bot.promptFile}'` : '',
    bot.effort ? `--effort ${bot.effort}` : '',
    bot.model ? `--model ${bot.model}` : '',
    bot.extraArgs ?? '',
    `--name '${bot.name}'`,
    '--dangerously-skip-permissions',
  ].filter(Boolean).join(' ')
}

// The run command for a codex bot: export the CODEX_* env the adapter reads
// (token + hub channel already come from the sourced state-dir .env), then run
// the adapter on the native bun that buildWindowShell put ahead on PATH. Like
// buildClaudeCmd, the token never appears here. Single-quoted values are safe:
// selectBots rejects quotes in name/workDir/promptFile/appServerUrl.
export function buildCodexCmd(bot: FleetBot, opts: LaunchOpts): string {
  if (!opts.adapterPath) throw new Error(`launch: codex bot "${bot.name}" has no adapter path`)
  return [
    `export CODEX_BOT_NAME='${bot.name}'`,
    `export CODEX_WORK_DIR='${bot.workDir}'`,
    bot.promptFile ? `export CODEX_PROMPT_FILE='${bot.promptFile}'` : '',
    bot.model ? `export CODEX_MODEL='${bot.model}'` : '',
    bot.appServerUrl ? `export CODEX_APP_SERVER_URL='${bot.appServerUrl}'` : '',
    `bun '${opts.adapterPath}'`,
  ].filter(Boolean).join(' && ')
}

// argv that opens a VISIBLE terminal attached to a tmux session, so a
// wsl/mac launch shows up on the desktop instead of living only in a detached
// background server. With one session per bot, each bot gets its own tab in
// the shared "pinchcord" Windows Terminal window. tmux still owns the bots —
// closing a tab leaves its bot running; relaunch reopens it.
//   - 'wsl' (Windows host): Windows Terminal tab running `wsl … tmux attach`.
//   - 'mac': Terminal.app window running `tmux attach`.
export function buildAttachCmd(mode: 'wsl' | 'mac', session: string, title = session): string[] {
  if (mode === 'mac') {
    return ['osascript', '-e', `tell application "Terminal" to do script "tmux attach -t ${session}"`]
  }
  return ['cmd.exe', '/c', 'start', 'wt.exe', '-w', 'pinchcord', 'new-tab', '--title', title, 'wsl.exe', '-e', 'tmux', 'attach', '-t', session]
}

// The shell line run inside a tmux window (wsl/mac). Token comes from the
// state-dir .env (mode 600, written by setup) — never from the command line.
// The PATH prepend puts the NATIVE bun (~/.bun/bin) and the native pinchcord
// shim (~/.local/bin) ahead of any Windows `bun`/`pinchcord` shim that WSL
// inherits from the Windows PATH — without it, claude's MCP-server spawn and
// the bot's own `pinchcord` calls would run Windows bun against /mnt/c paths
// and break. Inherited by every Bash subshell claude spawns, so the bot's
// outbound CLI resolves natively too.
export function buildWindowShell(bot: FleetBot, opts: LaunchOpts): string {
  const runCmd = bot.runtime === 'codex' ? buildCodexCmd(bot, opts) : buildClaudeCmd(bot, opts)
  return [
    `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"`,
    `cd '${bot.workDir}'`,
    `export DISCORD_STATE_DIR='${opts.stateDir}'`,
    `set -a && . '${opts.stateDir}/.env' && set +a`,
    `export CLAUDE_SESSION_NAME='${bot.name}'`,
    runCmd,
  ].join(' && ')
}
