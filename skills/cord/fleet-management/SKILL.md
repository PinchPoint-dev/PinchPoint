---
name: PinchCord Fleet Management
description: >-
  This skill should be used when the user asks to "launch a bot", "start Bee",
  "close a tab", "kill a bot", "approve a bot", "auto-approve",
  "manage the fleet", "restart a bot", or needs to perform fleet management
  operations for the PinchCord bot fleet. Also triggered by references to
  "tmux session", "wt focus-tab", "SendKeys", "PinchCord window/session",
  or bot tab/pane management.
version: 0.2.0
---

# PinchCord Fleet Management

Manage the PinchCord bot fleet. This covers launching bots, auto-approving dev channel prompts, stopping bots, and restarting bots.

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

1. **Bot Launch Permission:** Only launch a bot when Sam explicitly names a specific bot to do it. "Launch Crow" with no name addressed = no bot acts. "Owl launch Crow" = only Owl acts.
2. **Never kill your own process.** Exclude your own PID when killing processes by pattern.
3. **Ask Sam to confirm** after close/launch operations — visual verification is the only reliable feedback.

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
