---
name: PinchCord Fleet Management
description: >-
  This skill should be used when the user asks to "launch a bot", "start Bee",
  "close a tab", "kill a bot", "approve a bot", "auto-approve",
  "manage the fleet", "restart a bot", or needs to perform fleet management
  operations for the PinchCord bot fleet. Also triggered by references to
  "tmux session", "wt focus-tab", "SendKeys", "PinchCord window/session",
  or bot tab/pane management.
version: 0.3.0
---

# PinchCord Fleet Management

Manage the PinchCord bot fleet. This covers launching bots, auto-approving dev channel prompts, stopping bots, and restarting bots.

## FIRST: Which launch system is this fleet on?

Two launch systems exist and their tmux models are **incompatible** — running
legacy commands against a lean-mode fleet (or vice versa) hits nothing, and
"fixing" that by improvising is how duplicate bots get launched. Check before
any operation:

```bash
tmux ls
```

- Sessions named **`Pinchcord-<Bot>`** (one per bot) → **lean mode**. Use the
  `pinchcord` CLI section below. Do NOT use `kill-window -t PinchCord:<Bot>`.
- A single session named **`PinchCord`** (bots as windows) → **legacy mode**.
  Use the legacy sections below. The `pinchcord stop` command won't find these.
- No tmux at all but WT tabs exist → could be either; check the tab titles
  (`<Bot>` = lean `--mode wt`, `<Bot>-discord` = legacy `launch.ps1`).

## Lean mode (pinchcord CLI)

If the repo ships the `pinchcord` CLI (`cli/` in this repo), prefer it — it
replaces the manual incantations below with verified lifecycle commands:

```bash
pinchcord launch <Bot>       # launch (default: WSL/tmux; --mode wt|mac)
pinchcord launch             # launch every bot in bots.json
pinchcord stop <Bot>         # stop one bot;  pinchcord stop --all
pinchcord restart <Bot>      # stop + relaunch
pinchcord ps                 # fleet status (DEAD = claude exited, pane kept)
pinchcord doctor --bot <Bot> # config / state-dir / MCP diagnosis
```

What's built in (no manual steps needed):
- **Auto-approve**: launch polls each pane and answers the dev-channels trust
  dialog when it actually renders — no SendKeys, no sleep-and-hope.
- **`--strict-mcp-config`** is baked in so ONLY the slim MCP loads (never both
  servers).
- **One tmux session per bot** (`Pinchcord-<Bot>`), each with its own terminal
  tab. Closing a tab never kills the bot.
- **No duplicates**: launching a running bot is a no-op with a `restart` hint.

Everything below this line documents the **legacy** full-tool-MCP launchers,
which remain the default until a fleet opts into lean mode.

## Prerequisites

- Bot config at `.pinchme/cord/bots.json` (tokens, workDir, promptFile, model, effort)
- **Mac/Linux:** tmux installed (`brew install tmux`)
- **Windows:** Windows Terminal (`wt` CLI) available in PATH
- Bots run in a named session/window called `PinchCord`

## Core Operations

### 1. Launch a Bot

#### Mac / Linux (tmux)

The fleet launcher creates a tmux session and opens each bot as a named window:

```bash
# Launch all bots
./.pinchpoint/cord/claude/launch.sh

# Launch specific bots
./.pinchpoint/cord/claude/launch.sh Engineer Reviewer
```

Under the hood, each bot gets a tmux window that runs:

```bash
export DISCORD_BOT_TOKEN="<token from bots.json>"
export PINCHHUB_CHANNEL_ID="<channelId from bots.json>"
export PINCHCORD_HEARTBEAT=true
cd '<workDir from bots.json>'
claude --dangerously-load-development-channels server:pinchcord \
  --append-system-prompt-file '<promptFile>' \
  --model '<model>' --effort <effort> --name <BotName>-discord
```

The launcher auto-approves the dev channels prompt by sending Enter to each tmux window after a delay.

#### Windows (Windows Terminal)

```powershell
# Launch all bots
.\.pinchpoint\cord\claude\launch.ps1

# Launch specific bots
.\.pinchpoint\cord\claude\launch.ps1 Engineer Reviewer
```

Creates a temporary PowerShell script per bot, opens each as a new WT tab, then auto-approves via `SendKeys`.

#### Both platforms

**MCP config:** Bots whose `workDir` is the project repo do NOT need `--mcp-config` — the project root `.mcp.json` is auto-discovered by Claude Code. Only bots with a `workDir` outside the project need `--mcp-config` pointing to the PinchCord MCP config. Both launchers handle this automatically.

For unattended operation with auto-restart, backoff, and watchdog, see `cord/claude/launch-resilient.sh` (Mac/Linux) or `cord/claude/launch-resilient.ps1` (Windows).

### 2. Auto-Approve Dev Channel Prompt

After launching, Claude shows a dev channels approval prompt. The fleet launchers handle this automatically.

**Mac/Linux:** `tmux send-keys -t PinchCord:<BotName> Enter`

**Windows:**
```powershell
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell
wt -w PinchCord focus-tab -t $tabIndex
Start-Sleep -Milliseconds 400
$wshell.AppActivate("PinchCord") | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
```

### 3. Close / Stop a Bot

**Mac/Linux:**
```bash
# Kill a specific bot's tmux window
tmux kill-window -t PinchCord:<BotName>

# Or find and kill the claude process
pkill -f "claude.*--name <BotName>-discord"
```

**Windows:**
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'claude' -and $_.CommandLine -match '<botname>' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 4. Restart a Bot

Kill the bot, then launch a new one:

**Mac/Linux:**
```bash
tmux kill-window -t PinchCord:<BotName>
sleep 2
# Re-run launch.sh for that bot
./.pinchpoint/cord/claude/launch.sh <BotName>
```

**Windows:**
```powershell
# Kill the bot process, then:
Start-Sleep -Seconds 2
.\.pinchpoint\cord\claude\launch.ps1 <BotName>
```

### 5. View / Attach to Bots

**Mac/Linux:**
```bash
tmux attach -t PinchCord                    # View all bots
tmux select-window -t PinchCord:<BotName>   # Switch to a specific bot
tmux kill-session -t PinchCord              # Stop all bots
```

**Windows:** Switch tabs in the PinchCord Windows Terminal window.

## Critical Rules

1. **Bot Launch Permission:** Only launch a bot when the operator explicitly names a specific bot to do it. "Launch Crow" with no name addressed = no bot acts. "Owl launch Crow" = only Owl acts.
2. **Never kill your own process.** Exclude your own PID when killing processes by pattern.
3. **Ask the operator to confirm** after close/launch operations — visual verification is the only reliable feedback.

## Platform-Specific Gotchas

**Mac/Linux (tmux):**
- tmux windows have stable names — no index fragility issues
- If tmux is not running, `launch.sh` creates the session automatically
- Detaching (`Ctrl+B, D`) leaves bots running in the background

**Windows (Windows Terminal):**
- `wt focus-tab` silently ignores out-of-range indices — no way to programmatically count tabs
- SendKeys requires the window to be focused — can misfire if another window steals focus
- See `references/gotchas.md` for detailed incident history

## Fleet Scripts

- **`cord/claude/launch.sh`** — Fleet launcher for Mac/Linux (tmux)
- **`cord/claude/launch.ps1`** — Fleet launcher for Windows (Windows Terminal)
- **`cord/claude/launch-resilient.sh`** — Resilient launcher with restart loop, backoff, circuit breaker, watchdog (Mac/Linux)
- **`cord/claude/launch-resilient.ps1`** — Resilient launcher with restart loop, backoff, circuit breaker, watchdog (Windows)
