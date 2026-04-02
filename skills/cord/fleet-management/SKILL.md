---
name: PinchCord Fleet Management
description: >-
  This skill should be used when the user asks to "launch a bot", "start Bee",
  "close a tab", "kill a bot tab", "approve a bot", "auto-approve",
  "manage the fleet", "restart a bot", or needs to perform any Windows Terminal
  tab operations for the PinchCord bot fleet. Also triggered by references to
  "wt focus-tab", "SendKeys", "PinchCord window", or bot tab management.
version: 0.1.0
---

# PinchCord Fleet Management

Manage the PinchCord bot fleet running as Windows Terminal tabs. This covers launching bots, auto-approving dev channel prompts, closing tabs, and restarting bots.

## Prerequisites

- Bot config at `.pinchme/cord/bots.json` (tokens, workDir, promptFile, model, effort)
- Windows Terminal (`wt` CLI) available in PATH
- Bots run in a named WT window called `PinchCord`

## Core Operations

### 1. Launch a Bot

Create a temporary PowerShell script, open it as a new WT tab, wait for Claude to boot, then auto-approve.

```powershell
# Step 1: Create temp launch script
$script = @'
$env:DISCORD_BOT_TOKEN = "<token from bots.json>"
$env:PINCHHUB_CHANNEL_ID = "<channelId from bots.json>"
$env:PINCHCORD_HEARTBEAT = "true"
Set-Location "<workDir from bots.json>"
Write-Host "=== <BotName> on PinchCord ===" -ForegroundColor Green
claude --dangerously-load-development-channels server:pinchcord --append-system-prompt-file "<promptFile>" --model "<model>" --effort <effort> --name <BotName>-discord
'@
$scriptPath = "$env:TEMP\pinchcord-<botname>.ps1"
Set-Content -Path $scriptPath -Value $script

# Step 2: Open as new tab in PinchCord window
wt -w PinchCord new-tab --title <BotName> powershell -NoExit -ExecutionPolicy Bypass -File $scriptPath

# Step 3: Wait for Claude to boot (~12 seconds)
Start-Sleep -Seconds 12

# Step 4: Auto-approve (see next section)
```

**MCP config:** Bots whose `workDir` is the project repo do NOT need `--mcp-config` — the project root `.mcp.json` is auto-discovered by Claude Code. Only bots with a `workDir` outside the project (e.g., Fox, Badger in a separate scrape repo) need `--mcp-config` pointing to the PinchCord MCP config.

For a production launcher with backoff, circuit breaker, and watchdog, see `fleet/launch-bot.ps1`. For a simpler multi-bot launcher, see `fleet/launch-fleet.ps1`.

### 2. Auto-Approve Dev Channel Prompt

After launching, Claude shows a dev channels approval prompt. Send Enter to the correct tab:

```powershell
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell

wt -w PinchCord focus-tab -t $tabIndex
Start-Sleep -Milliseconds 400
$wshell.AppActivate("PinchCord") | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
```

When the exact tab index is unknown, loop through several indices. Sending Enter to an already-running bot is harmless:

```powershell
foreach ($i in 7,6,5,4,3,2,1) {
    wt -w PinchCord focus-tab -t $i
    Start-Sleep -Milliseconds 400
    $wshell.AppActivate("PinchCord") | Out-Null
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 300
}
```

**Note:** The approve loop will also send Enter to your own tab if it falls within the index range. This is usually harmless, but be aware if your session has a pending confirmation dialog.

### 3. Close a Tab

**This is the ONLY method that reliably closes Windows Terminal tabs.** Do not use process-kill — it does not close the tab.

```powershell
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell

wt -w PinchCord focus-tab -t $tabIndex
Start-Sleep -Milliseconds 400
$wshell.AppActivate("PinchCord") | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^+w")   # Ctrl+Shift+W = WT close tab
```

**When closing multiple tabs**, go from highest index to lowest. Indices shift down when a tab closes — closing tab 3 makes tab 4 become tab 3.

For a reusable close script, see `fleet/close-tab.ps1`.

### 4. Restart a Bot

Restart = close the tab + launch a new one. Always close first, then launch:

```powershell
# Step 1: Close the existing tab (identify the index first)
# Use the close-tab method from section 3

# Step 2: Wait for tab to close
Start-Sleep -Seconds 2

# Step 3: Launch fresh (follow section 1)
```

**Important:** After closing a tab, all tab indices shift. Account for this when launching the replacement.

## Critical Rules

1. **Bot Launch Permission:** Only launch a bot when Sam explicitly names a specific bot to do it. "Launch Crow" with no name addressed = no bot acts. "Owl launch Crow" = only Owl acts.
2. **Process-kill does NOT close tabs.** The `-NoExit` flag keeps the PowerShell host alive even after Claude exits. The tab lingers as a dead shell.
3. **`wt focus-tab` silently ignores out-of-range indices.** There is no way to programmatically count tabs.
4. **Never close your own tab.** Identify which tab index belongs to your own session and skip it.
5. **Ask Sam to confirm** after close/launch operations — visual verification is the only reliable feedback.

## Troubleshooting

For detailed gotchas, failed approaches, and incident history, consult `references/gotchas.md`.

## Fleet Scripts

- **`fleet/launch-bot.ps1`** — Production bot launcher with restart loop, exponential backoff, circuit breaker, hung-session watchdog, and session quarantine
- **`fleet/launch-fleet.ps1`** — Multi-bot launcher: reads bots.json, opens each bot as a WT tab, auto-approves
- **`fleet/close-tab.ps1`** — Closes tab(s) by index using Ctrl+Shift+W (auto-sorts highest-first)
