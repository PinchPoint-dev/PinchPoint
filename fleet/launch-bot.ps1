# launch-bot.ps1 — resilient launcher for PinchBridge bots (Discord + Telegram + PinchCord)
# Usage: & "path\to\launch-bot.ps1" -BotName Beaver -Token "..." -WorkDir "..." -PromptFile "..." -ProjectSlug "..." [-Channel discord|telegram|pinchcord]
#
# Features:
#   - Triple-channel support: -Channel pinchcord (custom MCP server, preferred), discord (official plugin), or telegram (official plugin)
#   - Exponential backoff with jitter (3s → 60s cap) to prevent EBUSY death loops
#   - Circuit breaker (10 rapid crashes → 5 min pause)
#   - Hung-session watchdog: detects API stream failures (stop_reason=null) and auto-restarts
#   - Session quarantine: renames hung .jsonl → .hung to prevent poisoned resume
#
# RESTORED 2026-04-01: Restart loop, backoff, circuit breaker, watchdog, and
# quarantine were accidentally stripped out, leaving a fire-and-forget launcher.
# Bots hit EBUSY on .claude.json and crash-looped without any backoff or recovery.
# All 5 protection layers restored from the last committed version.

param(
    [Parameter(Mandatory)][string]$BotName,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$WorkDir,
    [Parameter(Mandatory)][string]$PromptFile,
    [Parameter(Mandatory)][string]$ProjectSlug,
    [string]$Model = "claude-sonnet-4-6",
    [string]$Effort = "high",
    [string]$ExtraArgs = "",
    [string]$Channel = "discord"
)

# Validate -Channel parameter
if ($Channel -ne "discord" -and $Channel -ne "telegram" -and $Channel -ne "pinchcord") {
    Write-Host "ERROR: -Channel must be 'discord', 'telegram', or 'pinchcord' (got '$Channel')" -ForegroundColor Red
    exit 1
}

# Pinchcord logs go to the discord log dir (it's Discord under the hood)
$logSubdir = if ($Channel -eq "pinchcord") { "discord" } else { $Channel }

$PinchLogs = Join-Path $PSScriptRoot "..\..\..\.pinchme\cord\logs\$logSubdir"
if ($env:PINCHCORD_LOG_DIR) { $PinchLogs = "$env:PINCHCORD_LOG_DIR\$logSubdir" }
New-Item -ItemType Directory -Force -Path $PinchLogs | Out-Null

# ── Auto-relaunch in a real console if stdin is detached ──────────────
# When spawned by the relay (bot-launcher.mjs with stdio:'ignore'), stdin is
# not a real terminal. Claude Code requires process.stdin.isTTY === true for
# channel mode — without it, it waits 3s and exits thinking it's in --print mode.
# Detect this and re-launch in a new minimized window which has a real console.
if ([System.Console]::IsInputRedirected -and $env:PINCHBRIDGE_RELAUNCHED -ne "1") {
    $env:PINCHBRIDGE_RELAUNCHED = "1"
    $relaunchArgs = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-BotName", "`"$BotName`"",
        "-Token", "`"$Token`"",
        "-WorkDir", "`"$WorkDir`"",
        "-PromptFile", "`"$PromptFile`"",
        "-ProjectSlug", "`"$ProjectSlug`"",
        "-Model", "`"$Model`"",
        "-Effort", "`"$Effort`"",
        "-Channel", "`"$Channel`""
    )
    if ($ExtraArgs) { $relaunchArgs += @("-ExtraArgs", "`"$ExtraArgs`"") }

    $p = Start-Process -FilePath powershell.exe -PassThru -WindowStyle Normal `
        -ArgumentList ($relaunchArgs -join " ")

    # Write the real PID for relay tracking
    Set-Content "$PinchLogs\$BotName-launcher.pid" $p.Id

    # Wait so the relay-spawned parent stays alive for PID tracking
    Wait-Process -Id $p.Id -ErrorAction SilentlyContinue
    exit $LASTEXITCODE
}

function Stop-ProcessTree([int]$RootPid) {
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootPid" -EA SilentlyContinue)
    foreach ($k in $kids) { Stop-ProcessTree $k.ProcessId }
    Stop-Process -Id $RootPid -Force -EA SilentlyContinue
}

# Clear any API key env vars — bots use Max subscription auth, not API keys.
# A stale ANTHROPIC_API_KEY causes "Invalid API key" and prevents connection.
Remove-Item Env:\ANTHROPIC_API_KEY -EA SilentlyContinue
Remove-Item Env:\CLAUDE_API_KEY -EA SilentlyContinue

# Set channel-specific environment variables
if ($Channel -eq "pinchcord") {
    # Pinchcord: custom MCP server, env vars passed directly to claude process
    $env:DISCORD_BOT_TOKEN = $Token
    $env:PINCHHUB_CHANNEL_ID = "1488108052887633970"

    # Clear stale env from other channels
    Remove-Item Env:\DISCORD_BOT_NAME -EA SilentlyContinue
    Remove-Item Env:\DISCORD_LOG_LABEL -EA SilentlyContinue
    Remove-Item Env:\DISCORD_STATE_DIR -EA SilentlyContinue
    Remove-Item Env:\TELEGRAM_BOT_TOKEN -EA SilentlyContinue
    Remove-Item Env:\TELEGRAM_LOG_LABEL -EA SilentlyContinue
} elseif ($Channel -eq "discord") {
    $env:DISCORD_BOT_TOKEN = $Token
    $env:DISCORD_BOT_NAME = $BotName
    $env:DISCORD_LOG_LABEL = $BotName
    $env:PINCHHUB_CHANNEL_ID = "1488108052887633970"

    # Per-bot state dir — the official discord plugin doesn't inherit the parent
    # process env block, so DISCORD_BOT_TOKEN must be in a .env file.
    # Point each bot at its own state dir so they don't overwrite each other's tokens.
    $botStateDir = "$env:USERPROFILE\.claude\channels\discord-$($BotName.ToLower())"
    New-Item -ItemType Directory -Force -Path $botStateDir | Out-Null
    $envFile = "$botStateDir\.env"
    # Always write — token may have rotated, and each bot has its own dir anyway
    Set-Content $envFile "DISCORD_BOT_TOKEN=$Token`nPINCHHUB_CHANNEL_ID=1488108052887633970"
    # Copy shared access.json into the per-bot dir (plugin needs it there)
    $sharedAccess = "$env:USERPROFILE\.claude\channels\discord\access.json"
    $botAccess = "$botStateDir\access.json"
    if ((Test-Path $sharedAccess) -and (-not (Test-Path $botAccess))) {
        Copy-Item $sharedAccess $botAccess
    }
    $env:DISCORD_STATE_DIR = $botStateDir

    # Clear Telegram env to prevent stale leaks
    Remove-Item Env:\TELEGRAM_BOT_TOKEN -EA SilentlyContinue
    Remove-Item Env:\TELEGRAM_LOG_LABEL -EA SilentlyContinue
} else {
    $env:TELEGRAM_BOT_TOKEN = $Token
    $env:TELEGRAM_LOG_LABEL = $BotName
    # Clear Discord env to prevent stale leaks
    Remove-Item Env:\DISCORD_BOT_TOKEN -EA SilentlyContinue
    Remove-Item Env:\DISCORD_BOT_NAME -EA SilentlyContinue
    Remove-Item Env:\DISCORD_LOG_LABEL -EA SilentlyContinue
}

# Pinchcord is Discord under the hood — session name stays *-discord for consistency
$sessionSuffix = if ($Channel -eq "pinchcord") { "discord" } else { $Channel }
$sessionName = "$BotName-$sessionSuffix"

Set-Location $WorkDir

# ── Singleton guard ───────────────────────────────────────────────────
# Prevent two launcher loops running simultaneously for the same bot.
# Logs show parallel instances occurring when the relay and a manual launch
# overlap — they fight over the session file and double API usage.
$pidFile = "$PinchLogs\$BotName-launcher.pid"
if (Test-Path $pidFile) {
    $existingPid = [int](Get-Content $pidFile -Raw -EA SilentlyContinue).Trim()
    $existingProc = Get-Process -Id $existingPid -EA SilentlyContinue
    if ($existingProc -and $existingProc.ProcessName -match 'powershell|pwsh' -and $existingPid -ne $PID) {
        $ts = Get-Date -Format o
        Write-Host "[$ts] $BotName launcher already running as PID $existingPid - exiting" -ForegroundColor Red
        Add-Content "$PinchLogs\$BotName-events.log" "[$ts] duplicate launch detected (PID $existingPid active) - exiting"
        exit 0
    }
}
Set-Content $pidFile $PID

$crashes = 0
$backoff = 3

while ($true) {
    $ts = Get-Date -Format o
    Write-Host "[$ts] $BotName starting" -ForegroundColor DarkGray
    Add-Content "$PinchLogs\$BotName-events.log" "[$ts] starting"
    $started = Get-Date

    # Build channel flag based on -Channel parameter
    if ($Channel -eq "pinchcord") {
        $channelFlag = "--dangerously-load-development-channels server:pinchcord"
        # Bots outside the project repo need --mcp-config to locate the pinchcord MCP server
        $projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
        if ((Resolve-Path $WorkDir).Path -ne $projectDir) {
            $mcpConfig = Join-Path $projectDir ".mcp.json"
            $channelFlag += " --mcp-config `"$mcpConfig`""
        }
    } elseif ($Channel -eq "discord") {
        $channelFlag = "--channels plugin:discord@claude-plugins-official"
    } else {
        $channelFlag = "--channels plugin:telegram@claude-plugins-official"
    }

    $cliArgs = "$channelFlag --append-system-prompt-file `"$PromptFile`" --model $Model --effort $Effort --name $sessionName"
    if ($ExtraArgs) { $cliArgs += " $ExtraArgs" }

    # Claude Code requires process.stdin.isTTY === true for channel mode.
    # System.Diagnostics.Process with UseShellExecute=false inherits the parent's
    # console (including TTY) without detaching stdin like Start-Process does.
    # Stderr is redirected separately (async) — redirecting fd2 does NOT affect
    # process.stdin.isTTY, so channel mode still works.
    $stderrLog = "$PinchLogs\$BotName-stderr.log"
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "claude"
    $psi.Arguments = $cliArgs
    $psi.UseShellExecute = $false
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = $WorkDir
    $p = [System.Diagnostics.Process]::Start($psi)

    # Async stderr reader — does not block the event loop or detach stdin
    $p.BeginErrorReadLine()
    Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action {
        if ($Event.SourceEventArgs.Data) {
            Add-Content $using:stderrLog $Event.SourceEventArgs.Data
        }
    } | Out-Null

    # ── Hung-session watchdog ──────────────────────────────────────────
    # Runs as a background job. Every 5 min, reads the bot's conversation
    # JSONL. If the last assistant message has stop_reason=null AND the
    # file hasn't been modified in 5+ min, the API stream died mid-turn
    # and Claude Code is stuck — kill it so the launcher can restart.
    $sessionDir = "$env:USERPROFILE\.claude\projects\$ProjectSlug"
    $watchdog = Start-Job -ScriptBlock {
        param($ClaudePid, $SessDir, $Name, $LogPath)
        Start-Sleep 120  # let session initialize before first check

        while (Get-Process -Id $ClaudePid -EA SilentlyContinue) {
            Start-Sleep 300  # check every 5 min

            # Find this bot's session file (most recent JSONL with matching customTitle)
            # Uses $sessionName (e.g. "Bee-discord") to avoid collisions with parallel channel sessions
            $candidates = Get-ChildItem "$SessDir\*.jsonl" -EA SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 10
            $sessFile = $null
            foreach ($f in $candidates) {
                $head = Get-Content $f.FullName -TotalCount 1 -EA SilentlyContinue
                if ($head -match "`"customTitle`"\s*:\s*`"$Name`"") {
                    $sessFile = $f; break
                }
            }
            if (-not $sessFile) { continue }

            # Skip if recently modified — session is actively working
            $staleMins = ((Get-Date) - $sessFile.LastWriteTime).TotalMinutes
            if ($staleMins -lt 5) { continue }

            # Read last 5 lines, find the last assistant message
            $tail = Get-Content $sessFile.FullName -Tail 5 -EA SilentlyContinue
            $hung = $false
            for ($i = $tail.Count - 1; $i -ge 0; $i--) {
                try {
                    $obj = $tail[$i] | ConvertFrom-Json -EA Stop
                    if ($obj.type -eq 'assistant') {
                        if ($null -eq $obj.message.stop_reason) { $hung = $true }
                        break  # only check the LAST assistant message
                    }
                } catch {}
            }

            if ($hung) {
                $now = Get-Date -Format o
                Add-Content $LogPath "[$now] WATCHDOG: hung session detected (stop_reason=null, stale $([math]::Round($staleMins))m), killing PID $ClaudePid"
                Stop-Process -Id $ClaudePid -Force -EA SilentlyContinue
                return
            }
        }
    } -ArgumentList $p.Id, $sessionDir, $sessionName, "$PinchLogs\$BotName-events.log"

    # ── Wait for claude to exit (normal, crash, or watchdog kill) ──────
    Wait-Process -Id $p.Id
    $alive = ((Get-Date) - $started).TotalSeconds

    # Clean up watchdog job and stderr event subscription
    Stop-Job $watchdog -EA SilentlyContinue
    Remove-Job $watchdog -Force -EA SilentlyContinue
    Get-EventSubscriber | Where-Object { $_.SourceObject -eq $p } | Unregister-Event -Force -EA SilentlyContinue

    $ts2 = Get-Date -Format o
    Write-Host "[$ts2] $BotName exited ($($p.ExitCode)) after $([math]::Round($alive))s" -ForegroundColor DarkGray
    Add-Content "$PinchLogs\$BotName-events.log" "[$ts2] exited ($($p.ExitCode)) alive=$([math]::Round($alive))s"
    Stop-ProcessTree $p.Id

    # ── Quarantine hung sessions ──────────────────────────────────────
    # If the most recent session for this bot ended with stop_reason=null,
    # rename it so Claude Code won't resume the poisoned session on restart.
    # Uses $sessionName (e.g. "Bee-discord") for matching to avoid collisions.
    $candidates = Get-ChildItem "$sessionDir\*.jsonl" -EA SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 10
    foreach ($f in $candidates) {
        $head = Get-Content $f.FullName -TotalCount 1 -EA SilentlyContinue
        if ($head -match "`"customTitle`"\s*:\s*`"$sessionName`"") {
            $tail = Get-Content $f.FullName -Tail 5 -EA SilentlyContinue
            for ($i = $tail.Count - 1; $i -ge 0; $i--) {
                try {
                    $obj = $tail[$i] | ConvertFrom-Json -EA Stop
                    if ($obj.type -eq 'assistant' -and $null -eq $obj.message.stop_reason) {
                        $newName = $f.FullName -replace '\.jsonl$', '.hung'
                        Rename-Item $f.FullName $newName -EA SilentlyContinue
                        $ts4 = Get-Date -Format o
                        Add-Content "$PinchLogs\$BotName-events.log" "[$ts4] QUARANTINE: renamed hung session $($f.Name) to .hung"
                        Write-Host "[$ts4] $BotName quarantined hung session" -ForegroundColor Yellow
                    }
                    break
                } catch {}
            }
            break
        }
    }

    # ── Exponential backoff + circuit breaker ─────────────────────────
    if ($alive -gt 30) {
        $crashes = 0; $backoff = 3      # healthy session — reset
    } else {
        $crashes++
        $backoff = [math]::Min(60, $backoff * 2)
    }

    if ($crashes -ge 10) {
        $ts3 = Get-Date -Format o
        Write-Host "[$ts3] $BotName CIRCUIT BREAKER: $crashes rapid crashes, pausing 5 min" -ForegroundColor Red
        Add-Content "$PinchLogs\$BotName-events.log" "[$ts3] CIRCUIT BREAKER: $crashes rapid crashes, pausing 5 min"
        Start-Sleep 300
        $crashes = 0; $backoff = 3
    } else {
        $jitter = Get-Random -Minimum 0 -Maximum 3
        $wait = $backoff + $jitter
        Write-Host "  restarting in ${wait}s (backoff=${backoff}s crashes=$crashes)" -ForegroundColor DarkGray
        Add-Content "$PinchLogs\$BotName-events.log" "[$ts2] restarting in ${wait}s (backoff=$backoff crashes=$crashes)"
        Start-Sleep $wait
    }
}
