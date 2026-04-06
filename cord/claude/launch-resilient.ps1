# launch-resilient.ps1 — resilient launcher for PinchCord bots
# Usage: & "path\to\launch-resilient.ps1" -BotName Bee -Token "..." -WorkDir "..." -PromptFile "..." -ProjectSlug "..." -ChannelId "..."
#
# Features:
#   - Exponential backoff with jitter (3s → 60s cap) to prevent EBUSY death loops
#   - Circuit breaker (10 rapid crashes → 5 min pause)
#   - Hung-session watchdog: detects API stream failures (stop_reason=null) and auto-restarts
#   - Session quarantine: renames hung .jsonl → .hung to prevent poisoned resume

param(
    [Parameter(Mandatory)][string]$BotName,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$WorkDir,
    [Parameter(Mandatory)][string]$PromptFile,
    [Parameter(Mandatory)][string]$ProjectSlug,
    [Parameter(Mandatory)][string]$ChannelId,
    [string]$Model = "claude-sonnet-4-6",
    [string]$Effort = "high",
    [string]$ExtraArgs = ""
)

# ── Logging ──────────────────────────────────────────────────────────
$PinchLogs = Join-Path $PSScriptRoot "..\..\..\.pinchme\cord\logs\discord"
if ($env:PINCHCORD_LOG_DIR) { $PinchLogs = "$env:PINCHCORD_LOG_DIR\discord" }
New-Item -ItemType Directory -Force -Path $PinchLogs | Out-Null

function Stop-ProcessTree([int]$RootPid) {
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootPid" -EA SilentlyContinue)
    foreach ($k in $kids) { Stop-ProcessTree $k.ProcessId }
    Stop-Process -Id $RootPid -Force -EA SilentlyContinue
}

# Clear any API key env vars — bots use Max subscription auth, not API keys.
Remove-Item Env:\ANTHROPIC_API_KEY -EA SilentlyContinue
Remove-Item Env:\CLAUDE_API_KEY -EA SilentlyContinue

# Set PinchCord environment variables
$env:DISCORD_BOT_TOKEN = $Token
$env:PINCHHUB_CHANNEL_ID = $ChannelId
$env:PINCHCORD_HEARTBEAT = "true"

$sessionName = "$BotName-discord"

# Validate WorkDir before entering restart loop
if (-not (Test-Path $WorkDir)) {
    Write-Host "ERROR: WorkDir '$WorkDir' does not exist" -ForegroundColor Red
    exit 1
}
Set-Location $WorkDir

# ── Singleton guard ───────────────────────────────────────────────────
# Prevent two launcher loops running simultaneously for the same bot.
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

# ── Build channel flag (computed once) ────────────────────────────────
$channelFlag = "--dangerously-load-development-channels server:pinchcord"
# Bots outside the project repo need --mcp-config to locate the pinchcord MCP server
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ((Resolve-Path $WorkDir).Path -ne $projectDir) {
    $mcpConfig = Join-Path $projectDir ".mcp.json"
    $channelFlag += " --mcp-config `"$mcpConfig`""
}

$cliArgs = "$channelFlag --append-system-prompt-file `"$PromptFile`" --model $Model --effort $Effort --name $sessionName"
if ($ExtraArgs) { $cliArgs += " $ExtraArgs" }

# ── Restart loop ─────────────────────────────────────────────────────
$crashes = 0
$backoff = 3

try {
while ($true) {
    $ts = Get-Date -Format o
    Write-Host "[$ts] $BotName starting" -ForegroundColor DarkGray
    Add-Content "$PinchLogs\$BotName-events.log" "[$ts] starting"
    $started = Get-Date

    $stderrLog = "$PinchLogs\$BotName-stderr.log"
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "claude"
    $psi.Arguments = $cliArgs
    $psi.UseShellExecute = $false
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = $WorkDir
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        $ts = Get-Date -Format o
        Write-Host "[$ts] $BotName FATAL: failed to start claude — $_" -ForegroundColor Red
        Add-Content "$PinchLogs\$BotName-events.log" "[$ts] FATAL: failed to start claude — $_"
        break
    }

    # Async stderr reader
    $p.BeginErrorReadLine()
    Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action {
        if ($Event.SourceEventArgs.Data) {
            Add-Content $using:stderrLog $Event.SourceEventArgs.Data
        }
    } | Out-Null

    # ── Hung-session watchdog ──────────────────────────────────────────
    # Every 5 min: if last assistant message has stop_reason=null AND file
    # hasn't been modified in 5+ min, the API stream died — kill to restart.
    $sessionDir = "$env:USERPROFILE\.claude\projects\$ProjectSlug"
    $watchdog = Start-Job -ScriptBlock {
        param($ClaudePid, $SessDir, $Name, $LogPath)
        Start-Sleep 120  # let session initialize

        while (Get-Process -Id $ClaudePid -EA SilentlyContinue) {
            Start-Sleep 300

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

            $staleMins = ((Get-Date) - $sessFile.LastWriteTime).TotalMinutes
            if ($staleMins -lt 5) { continue }

            $tail = Get-Content $sessFile.FullName -Tail 5 -EA SilentlyContinue
            for ($i = $tail.Count - 1; $i -ge 0; $i--) {
                try {
                    $obj = $tail[$i] | ConvertFrom-Json -EA Stop
                    if ($obj.type -eq 'assistant') {
                        if ($null -eq $obj.message.stop_reason) {
                            $now = Get-Date -Format o
                            Add-Content $LogPath "[$now] WATCHDOG: hung session (stop_reason=null, stale $([math]::Round($staleMins))m), killing PID $ClaudePid"
                            Stop-Process -Id $ClaudePid -Force -EA SilentlyContinue
                            return
                        }
                        break
                    }
                } catch {}
            }
        }
    } -ArgumentList $p.Id, $sessionDir, $sessionName, "$PinchLogs\$BotName-events.log"

    # ── Wait for exit ─────────────────────────────────────────────────
    Wait-Process -Id $p.Id
    $alive = ((Get-Date) - $started).TotalSeconds

    Stop-Job $watchdog -EA SilentlyContinue
    Remove-Job $watchdog -Force -EA SilentlyContinue
    Get-EventSubscriber | Where-Object { $_.SourceObject -eq $p } | Unregister-Event -Force -EA SilentlyContinue

    $ts2 = Get-Date -Format o
    Write-Host "[$ts2] $BotName exited ($($p.ExitCode)) after $([math]::Round($alive))s" -ForegroundColor DarkGray
    Add-Content "$PinchLogs\$BotName-events.log" "[$ts2] exited ($($p.ExitCode)) alive=$([math]::Round($alive))s"
    Stop-ProcessTree $p.Id

    # ── Quarantine hung sessions ──────────────────────────────────────
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
                        Add-Content "$PinchLogs\$BotName-events.log" "[$ts4] QUARANTINE: renamed $($f.Name) to .hung"
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
        $crashes = 0; $backoff = 3
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
} finally {
    # Clean up PID file so the singleton guard doesn't block future launches
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force -EA SilentlyContinue }
}
