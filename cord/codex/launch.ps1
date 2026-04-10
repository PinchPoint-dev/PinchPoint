# launch.ps1 - Launch a Codex bot in a PinchCord Windows Terminal tab
#
# Usage:
#   .\launch.ps1                        # Uses defaults from config
#   .\launch.ps1 -BotName Panda         # Override bot name
#   .\launch.ps1 -Token "MTIz..."       # Override token
#   .\launch.ps1 -Port 3848             # Override app-server port
#
# IMPORTANT: Discord env vars (DISCORD_BOT_TOKEN, etc.) MUST be set BEFORE
# starting the Codex app-server, so the MCP server inherits them. This script
# handles that ordering correctly. Do NOT set these after Start-Process.
#
# Token resolution (first match wins):
#   1. -Token parameter (explicit)
#   2. PANDA_DISCORD_TOKEN from .env.secrets (project root)
#   3. DISCORD_BOT_TOKEN from ~/.codex-<botname>/config.toml
#   4. Prompts the user

param(
    [string]$BotName = "Panda",
    [string]$Token = "",
    [int]$Port = 3848,
    [string]$Window = "PinchCord",
    [string]$ChannelId = "1488108052887633970"
)

$BotNameLower = $BotName.ToLower()
$CodexHome = "$env:USERPROFILE\.codex-$BotNameLower"
$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = (Get-Item (Split-Path -Parent (Split-Path -Parent $ScriptDir))).FullName

# ---- Token resolution ----
if (-not $Token) {
    # Try .env.secrets
    $secretsFile = Join-Path $RepoRoot ".env.secrets"
    if (Test-Path $secretsFile) {
        $key = "$($BotName.ToUpper())_DISCORD_TOKEN"
        $match = Select-String -Path $secretsFile -Pattern "^$key=(.+)$"
        if ($match) {
            $Token = $match.Matches[0].Groups[1].Value
            Write-Host "Token: from .env.secrets ($key)" -ForegroundColor DarkGray
        }
    }
}

if (-not $Token) {
    # Try config.toml
    $configToml = Join-Path $CodexHome "config.toml"
    if (Test-Path $configToml) {
        $match = Select-String -Path $configToml -Pattern 'DISCORD_BOT_TOKEN\s*=\s*"([^"]+)"'
        if ($match) {
            $Token = $match.Matches[0].Groups[1].Value
            Write-Host "Token: from config.toml" -ForegroundColor DarkGray
        }
    }
}

if (-not $Token) {
    Write-Host "ERROR: No Discord bot token found." -ForegroundColor Red
    Write-Host "  Set $($BotName.ToUpper())_DISCORD_TOKEN in .env.secrets" -ForegroundColor Yellow
    Write-Host "  Or pass -Token directly" -ForegroundColor Yellow
    exit 1
}

# ---- Build launch script for WT tab ----
# Key fix: env vars are set BEFORE Start-Process so the app-server
# (and its MCP server children) inherit DISCORD_BOT_TOKEN.

$launchScript = @"
`$env:CODEX_HOME = "$CodexHome"
`$env:DISCORD_BOT_TOKEN = "$Token"
`$env:DISCORD_ACCESS_MODE = "static"
`$env:PINCHCORD_HEARTBEAT = "true"
`$env:PINCHHUB_CHANNEL_ID = "$ChannelId"

`$host.UI.RawUI.WindowTitle = "$BotName"
Write-Host "=== $BotName on PinchCord ===" -ForegroundColor Green
Write-Host "Starting app-server on port $Port..." -ForegroundColor DarkGray

Start-Process -NoNewWindow -FilePath "C:\Users\samcd\AppData\Roaming\npm\codex.cmd" -ArgumentList "app-server","--listen","ws://127.0.0.1:$Port"
Start-Sleep 8

`$host.UI.RawUI.WindowTitle = "$BotName"
Write-Host "Starting adapter..." -ForegroundColor DarkGray
Set-Location "$ScriptDir"
`$env:CODEX_BOT_NAME = "$BotName"
`$env:CODEX_APP_SERVER_URL = "ws://127.0.0.1:$Port"
node adapter-persistent.mjs
"@

$scriptPath = "$env:TEMP\pinchcord-$BotNameLower.ps1"
Set-Content -Path $scriptPath -Value $launchScript

# ---- Launch in WT tab ----
wt -w $Window new-tab --title $BotName powershell -NoExit -ExecutionPolicy Bypass -File $scriptPath

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to open Windows Terminal tab." -ForegroundColor Red
    exit 1
}

Write-Host "$BotName tab opened in '$Window'" -ForegroundColor Green
Write-Host "  App-server: ws://127.0.0.1:$Port" -ForegroundColor DarkGray
Write-Host "  Token source: .env.secrets or config.toml" -ForegroundColor DarkGray
Write-Host "  Script: $scriptPath" -ForegroundColor DarkGray
