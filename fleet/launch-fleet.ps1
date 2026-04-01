# launch-fleet.ps1 — Launch PinchCord bots as tabs in a named Windows Terminal window
# Usage:
#   .\launch-fleet.ps1 Engineer              # Launch just Engineer
#   .\launch-fleet.ps1 Engineer Reviewer     # Launch Engineer and Reviewer
#   .\launch-fleet.ps1                       # Launch all bots in config
#
# Reads bot config from ~/.pinchcord/bots.json
# Each bot opens as a named tab in the "PinchCord" terminal window.

param(
    [Parameter(Position=0, ValueFromRemainingArguments)]
    [string[]]$Bots,
    [string]$Window = "PinchCord",
    [string]$ConfigPath = "$env:USERPROFILE\.pinchcord\bots.json"
)

# ── Locate PinchCord server ────────────────────────────────────────
$ScriptDir = Split-Path -Parent $PSCommandPath
$PinchCordRoot = Split-Path -Parent $ScriptDir

# ── Load config ────────────────────────────────────────────────────
if (-not (Test-Path $ConfigPath)) {
    Write-Host "ERROR: Config not found at $ConfigPath" -ForegroundColor Red
    Write-Host "Copy fleet/bots.example.json to $ConfigPath and fill in your tokens." -ForegroundColor Yellow
    exit 1
}

$botsJson = Get-Content $ConfigPath -Raw | ConvertFrom-Json

# Default to all bots if none specified
if (-not $Bots -or $Bots.Count -eq 0) {
    $Bots = $botsJson.PSObject.Properties.Name
}

# ── Self-relaunch into named terminal window ───────────────────────
$botsFile = "$env:TEMP\pinchcord-launch-bots.txt"

if ($env:PINCHCORD_LAUNCHER -ne "1") {
    $env:PINCHCORD_LAUNCHER = "1"
    Set-Content -Path $botsFile -Value ($Bots -join "`n")
    wt -w $Window new-tab --title "Launcher" powershell -NoExit -ExecutionPolicy Bypass -File $PSCommandPath
    exit 0
}

# ── We're now inside the terminal window ───────────────────────────
$host.UI.RawUI.WindowTitle = "Launcher"

if (Test-Path $botsFile) {
    $Bots = Get-Content $botsFile
}

function Write-BotLauncher {
    param([string]$BotName, [psobject]$Config)

    $token = $Config.token
    $workDir = $Config.workDir
    $promptFile = $Config.promptFile
    $model = if ($Config.model) { $Config.model } else { "claude-sonnet-4-6" }
    $effort = if ($Config.effort) { $Config.effort } else { "high" }
    $extraArgs = if ($Config.extraArgs) { $Config.extraArgs } else { "" }
    $sessionName = "$BotName-discord"

    # Bots outside the PinchCord repo need --mcp-config to find the server
    $mcpFlag = ""
    if ($workDir -ne (Get-Item $PinchCordRoot).FullName) {
        $mcpConfig = Join-Path $PinchCordRoot "pinchcord-mcp.json"
        if (Test-Path $mcpConfig) {
            $mcpFlag = "--mcp-config `"$mcpConfig`""
        }
    }

    $channelId = if ($Config.channelId) { $Config.channelId } else { $env:PINCHHUB_CHANNEL_ID }

    $script = @"
`$env:DISCORD_BOT_TOKEN = "$token"
`$env:PINCHHUB_CHANNEL_ID = "$channelId"
`$env:PINCHCORD_HEARTBEAT = "true"
Set-Location "$workDir"
Write-Host "=== $BotName on PinchCord ===" -ForegroundColor Green
claude --dangerously-load-development-channels server:pinchcord $mcpFlag --append-system-prompt-file "$promptFile" --model "$model" --effort $effort --name $sessionName $extraArgs
"@
    $scriptPath = "$env:TEMP\pinchcord-$($BotName.ToLower()).ps1"
    Set-Content -Path $scriptPath -Value $script
    return $scriptPath
}

Write-Host "PinchCord Fleet Launcher" -ForegroundColor Cyan
Write-Host "Launching: $($Bots -join ', ')" -ForegroundColor DarkGray
Write-Host ""

$launched = @()

foreach ($botName in $Bots) {
    $config = $botsJson.$botName
    if (-not $config) {
        Write-Host "  SKIP: No config for '$botName' in bots.json" -ForegroundColor Yellow
        continue
    }

    $scriptPath = Write-BotLauncher -BotName $botName -Config $config

    wt -w $Window new-tab --title $botName powershell -NoExit -ExecutionPolicy Bypass -File $scriptPath

    Write-Host "  $botName tab added" -ForegroundColor DarkGray
    $launched += $botName

    if ($Bots.Count -gt 1) {
        Start-Sleep -Seconds 3
    }
}

if ($launched.Count -eq 0) {
    Write-Host "No bots launched." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Waiting for prompts..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Auto-approve dev channels prompt on each tab
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell

foreach ($botName in $launched) {
    $wshell.AppActivate("$botName-discord") | Out-Null
    Start-Sleep -Milliseconds 500
    $wshell.SendKeys('{ENTER}')
    Write-Host "  $botName approved" -ForegroundColor Green
    Start-Sleep -Milliseconds 500
}

Write-Host ""
Write-Host "Done. $($launched.Count) bot(s) in '$Window' window." -ForegroundColor Cyan
Write-Host "This tab can be closed or kept for monitoring." -ForegroundColor DarkGray
