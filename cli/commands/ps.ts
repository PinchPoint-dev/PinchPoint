import { platform } from 'os'
import type { Ctx } from '../lib/ctx'
import { sh, SESSION_PREFIX, LEGACY_SESSION, resolveMode } from './launch'

// Bot name in a process command line: quote may be absent (PowerShell strips
// quotes from spaceless args), single (sh), or double (launch-wt ps1).
// \x27/\x22 keep the pattern embeddable in any quoting context. The name
// capture stops at any non-letter, so both 'Bee' and legacy 'Bee-discord'
// session names yield the bot name. The pinchcord-slim filter keeps random
// `--name` flags on unrelated processes out of the listing.
export const WT_NAME_PATTERN = '--name [\\x27\\x22]?([A-Za-z]+)'

export async function run(ctx: Ctx): Promise<string> {
  const mode = resolveMode(ctx.flags)
  if (mode === 'wt') {
    const r = Bun.spawnSync(['powershell', '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='bun.exe'" | Where-Object { $_.CommandLine -match 'pinchcord-slim' -and $_.CommandLine -match '${WT_NAME_PATTERN}' } | ForEach-Object { '{0}  pid={1}' -f (($_.CommandLine | Select-String -Pattern '${WT_NAME_PATTERN}').Matches[0].Groups[1].Value), $_.ProcessId }`])
    const txt = new TextDecoder().decode(r.stdout).trim()
    return txt || '(no wt-mode bot processes found)'
  }
  const viaWsl = mode === 'wsl' && platform() === 'win32'
  const r = await sh(['tmux', 'list-panes', '-a', '-F',
    '#{session_name}\t#{window_name}\t#{?pane_dead,DEAD — claude exited,pane pid #{pane_pid}}'], viaWsl)
  if (r.code !== 0) return '(no tmux server running)'
  const lines: string[] = []
  for (const line of r.stdout.trim().split('\n')) {
    const [session, window, state] = line.split('\t')
    if (!session) continue
    if (session.startsWith(SESSION_PREFIX)) {
      lines.push(`${session.slice(SESSION_PREFIX.length)}  (${state})`)
    } else if (session === LEGACY_SESSION && window !== 'launcher') {
      lines.push(`${window}  (${state}, legacy combined session)`)
    }
  }
  return lines.length ? lines.join('\n') : '(no bots running)'
}
