import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import type { Ctx } from '../lib/ctx'
import { buildClaudeCmd } from '../lib/fleet'
import { selectBots } from './launch'

// wt mode: one PowerShell tab per bot in a "PinchCord" window. Env comes from
// a generated per-bot ps1 (gitignored temp dir) so tokens stay off command lines.
export async function launchWt(ctx: Ctx): Promise<string> {
  const out: string[] = ['launching via Windows Terminal (wt)']
  const tmpDir = join(homedir(), '.pinchme', 'cord', 'wt-launch')
  mkdirSync(tmpDir, { recursive: true })
  const mcpConfig = join(process.cwd(), '.pinchme', 'cord', 'mcp-config.json').replace(/\\/g, '/')

  for (const [name, bot] of selectBots(ctx)) {
    if (bot.runtime === 'codex') throw new Error(`launch: codex bot "${name}" is not supported in wt mode — use --mode wsl (the Codex adapter targets a WSL/tmux fleet)`)
    const stateDir = join(homedir(), '.claude', 'channels', `discord-${name.toLowerCase()}`).replace(/\\/g, '/')
    const claude = buildClaudeCmd({ ...bot, workDir: bot.workDir, promptFile: bot.promptFile.replace(/\\/g, '/') }, { mcpConfig, stateDir })
    const ps1 = join(tmpDir, `${name}.ps1`)
    writeFileSync(ps1, [
      `Set-Location '${bot.workDir}'`,
      `$env:DISCORD_STATE_DIR = '${stateDir}'`,
      // .Trim() guards against CRLF .env files (stray \r in the token breaks auth)
      `Get-Content '${stateDir}/.env' | ForEach-Object { if ($_ -match '^(\\w+)=(.*)$') { Set-Item -Path ('env:' + $Matches[1]) -Value $Matches[2].Trim() } }`,
      `$env:CLAUDE_SESSION_NAME = '${name}'`,
      // claude command uses single quotes for sh; strip them for PowerShell by re-quoting:
      claude.replace(/'/g, '"'),
    ].join('\r\n'), { mode: 0o600 })

    const r = Bun.spawnSync(['wt.exe', '-w', 'PinchCord', 'new-tab', '--title', name, 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ps1])
    r.exitCode === 0 ? out.push(`  ✓ ${name} → wt tab`) : out.push(`  ✗ ${name}: wt exit ${r.exitCode}`)
  }

  // Auto-approve the dev-channels dialog. wt tab content is not readable
  // (unlike tmux panes), so this stays SendKeys-based — but made safe and
  // repeated: the dialog's default selection is "1. local development", so a
  // bare Enter ('~') confirms it, and Enter on an idle REPL is a no-op. The
  // old single {DOWN}~ at 9s selected "2. Exit" (killing claude) and missed
  // slow starts entirely. Each round tries to activate the window by any bot
  // tab's title, presses Enter, then Ctrl+Tab to cycle to the next tab.
  const names = selectBots(ctx).map(([name]) => name)
  const activate = names
    .flatMap(n => [n, `✳ ${n}`]) // claude retitles tabs via OSC, sometimes with a busy marker
    .map(t => `if ($ws.AppActivate('${t}')) { $hit = $true }`)
    .join(' else')
  const rounds = Math.max(4, names.length * 2)
  for (let i = 0; i < rounds; i++) {
    await Bun.sleep(6000)
    Bun.spawnSync(['powershell', '-NoProfile', '-Command',
      `$ws = New-Object -ComObject WScript.Shell; $hit = $false; ${activate}; if ($hit) { Start-Sleep -m 300; $ws.SendKeys('~'); Start-Sleep -m 200; $ws.SendKeys('^{TAB}') }`])
  }
  out.push(`auto-approved dev-channels dialogs (Enter, ${rounds} rounds across tabs) — verify each tab`)
  return out.join('\n')
}
