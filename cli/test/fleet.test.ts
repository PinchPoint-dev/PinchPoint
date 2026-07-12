import { test, expect } from 'bun:test'
import { winToWsl, buildClaudeCmd, buildCodexCmd, buildWindowShell, buildAttachCmd, tabColorFor, translateExtraArgs } from '../lib/fleet'

test('winToWsl translates drive paths', () => {
  expect(winToWsl('C:\\Users\\me\\repo')).toBe('/mnt/c/Users/me/repo')
  expect(winToWsl('D:/data/x')).toBe('/mnt/d/data/x')
  expect(winToWsl('/already/posix')).toBe('/already/posix')
})

const bot = { name: 'Beaver', token: 'TOKEN-MUST-NOT-LEAK', channelId: 'C', workDir: '/mnt/c/repo', promptFile: '/mnt/c/p.md', effort: 'high' }
const opts = { mcpConfig: '/mnt/c/repo/.pinchme/cord/mcp-config.posix.json', stateDir: '/home/u/.claude/channels/discord-beaver' }

test('buildClaudeCmd bakes the slim MCP + strict config', () => {
  const cmd = buildClaudeCmd(bot, opts)
  expect(cmd).toContain('--dangerously-load-development-channels server:pinchcord-slim')
  expect(cmd).toContain(`--mcp-config '${opts.mcpConfig}'`)
  expect(cmd).toContain('--strict-mcp-config')
  expect(cmd).toContain("--append-system-prompt-file '/mnt/c/p.md'")
  expect(cmd).toContain('--effort high')
  expect(cmd).toContain("--name 'Beaver'")
  expect(cmd).not.toContain('Beaver-discord') // tab/session title is the bare bot name
  expect(cmd).toContain('--dangerously-skip-permissions')
  expect(cmd).not.toContain('TOKEN-MUST-NOT-LEAK') // token never in the command
})

test('buildClaudeCmd includes extraArgs from bots.json', () => {
  const cmd = buildClaudeCmd({ ...bot, extraArgs: `--add-dir '/mnt/c/Other'` }, opts)
  expect(cmd).toContain(`--add-dir '/mnt/c/Other'`)
})

test('translateExtraArgs converts embedded Windows paths for the target', () => {
  expect(translateExtraArgs('--add-dir "C:\\Users\\me\\Projects\\Other Repo"', winToWsl))
    .toBe(`--add-dir '/mnt/c/Users/me/Projects/Other Repo'`)
  expect(translateExtraArgs('--add-dir D:/data/x', winToWsl))
    .toBe(`--add-dir '/mnt/d/data/x'`)
  expect(translateExtraArgs('--verbose', winToWsl)).toBe('--verbose') // no paths → untouched
})

test('buildWindowShell sources env, never inlines the token', () => {
  const sh = buildWindowShell(bot, opts)
  expect(sh).toContain(`cd '/mnt/c/repo'`)
  expect(sh).toContain(`export DISCORD_STATE_DIR='${opts.stateDir}'`)
  expect(sh).toContain(`. '${opts.stateDir}/.env'`)
  expect(sh).toContain("export CLAUDE_SESSION_NAME='Beaver'")
  expect(sh).not.toContain('TOKEN-MUST-NOT-LEAK') // raw token absent
})

test('buildWindowShell prepends native bun + shim dirs ahead of any Windows shim', () => {
  const sh = buildWindowShell(bot, opts)
  // native bun and the native pinchcord shim must win over the WSL-inherited
  // Windows PATH, else the MCP spawn and the bot's CLI run the wrong bun.
  expect(sh).toContain('export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"')
  expect(sh.indexOf('export PATH=')).toBeLessThan(sh.indexOf('claude '))
})

const codexOpts = { ...opts, adapterPath: '/mnt/c/repo/cli/codex/adapter.ts' }

test('buildCodexCmd runs the adapter on bun and exports CODEX_* env, never the token', () => {
  const cmd = buildCodexCmd({ ...bot, runtime: 'codex', model: 'gpt-5.4', appServerUrl: 'ws://127.0.0.1:3848' }, codexOpts)
  expect(cmd).toContain("export CODEX_BOT_NAME='Beaver'")
  expect(cmd).toContain("export CODEX_WORK_DIR='/mnt/c/repo'")
  expect(cmd).toContain("export CODEX_PROMPT_FILE='/mnt/c/p.md'")
  expect(cmd).toContain("export CODEX_MODEL='gpt-5.4'")
  expect(cmd).toContain("export CODEX_APP_SERVER_URL='ws://127.0.0.1:3848'")
  expect(cmd).toContain("bun '/mnt/c/repo/cli/codex/adapter.ts'")
  expect(cmd).not.toContain('--dangerously-load-development-channels') // not a claude launch
  expect(cmd).not.toContain('TOKEN-MUST-NOT-LEAK')
})

test('buildCodexCmd omits optional exports and requires an adapter path', () => {
  const cmd = buildCodexCmd({ ...bot, runtime: 'codex' }, codexOpts)
  expect(cmd).not.toContain('CODEX_MODEL')
  expect(cmd).not.toContain('CODEX_APP_SERVER_URL')
  expect(() => buildCodexCmd({ ...bot, runtime: 'codex' }, opts)).toThrow(/adapter path/)
})

test('buildWindowShell dispatches to the codex adapter for runtime codex', () => {
  const sh = buildWindowShell({ ...bot, runtime: 'codex' }, codexOpts)
  expect(sh).toContain("bun '/mnt/c/repo/cli/codex/adapter.ts'")
  expect(sh).not.toContain('claude ') // no claude command for a codex bot
  expect(sh).toContain(`. '${opts.stateDir}/.env'`) // still sources token/channel from .env
  expect(sh).not.toContain('TOKEN-MUST-NOT-LEAK')
})

test('buildAttachCmd opens a visible terminal attached to the per-bot session', () => {
  const wsl = buildAttachCmd('wsl', 'Pinchcord-Bee', 'Bee')
  expect(wsl).toContain('wt.exe')
  expect(wsl.join(' ')).toContain('tmux attach -t Pinchcord-Bee')
  const title = wsl[wsl.indexOf('--title') + 1]
  expect(title).toBe('Bee') // tab is titled with the bot name, not the session
  expect(wsl).not.toContain('--tabColor') // no colour unless one is passed
  const mac = buildAttachCmd('mac', 'Pinchcord-Bee')
  expect(mac[0]).toBe('osascript')
  expect(mac.join(' ')).toContain('tmux attach -t Pinchcord-Bee')
})

// Tab colours tell the two fleets apart at a glance: codex dodger blue,
// claude dark orange (Sam, 2026-07-12). The colour must precede the wsl.exe
// command — everything after it is the tab's command line, not wt options.
test('buildAttachCmd colours the tab per runtime', () => {
  expect(tabColorFor('codex')).toBe('#1E90FF')
  expect(tabColorFor('claude')).toBe('#FF8C00')
  expect(tabColorFor(undefined)).toBe('#FF8C00') // runtime defaults to claude
  const wsl = buildAttachCmd('wsl', 'Codex-View-Genna', 'Genna', tabColorFor('codex'))
  expect(wsl[wsl.indexOf('--tabColor') + 1]).toBe('#1E90FF')
  expect(wsl.indexOf('--tabColor')).toBeLessThan(wsl.indexOf('wsl.exe'))
  const mac = buildAttachCmd('mac', 'Codex-View-Genna', 'Genna', tabColorFor('codex'))
  expect(mac.join(' ')).not.toContain('#1E90FF') // Terminal.app: no tab colour support
})
