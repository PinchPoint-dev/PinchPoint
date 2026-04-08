# launch.ps1 - Launch PinchCord bots as tabs in a named Windows Terminal window
# Usage:
#   .\launch.ps1 Engineer              # Launch just Engineer
#   .\launch.ps1 Engineer Reviewer     # Launch Engineer and Reviewer
#   .\launch.ps1                       # Launch all bots in config
#   .\launch.ps1 -UseWsl               # Launch via WSL + tmux (reliable, no focus issues)
#
# Config resolution (first match wins):
#   1. -ConfigPath flag (explicit override)
#   2. PINCHME_DIR env var → $PINCHME_DIR/cord/bots.json
#   3. .pinchme/cord/bots.json in current working directory (project-local)
#   4. ~/.pinchme/cord/bots.json in home directory (global)
#
# Windows (default): Opens each bot as a named tab in "PinchCord" terminal window.
#   Auto-approves dev channels prompt with verify-and-retry (3 attempts per bot).
# WSL (-UseWsl): Runs bots in a tmux session via WSL. Uses tmux send-keys for
#   deterministic prompt approval. Monitor with: wsl tmux attach -t PinchCord

param(
    [Parameter(Position=0, ValueFromRemainingArguments)]
    [string[]]$Bots,
    [string]$Window = "PinchCord",
    [string]$ConfigPath = "",
    [switch]$UseWsl
)

# ── Locate PinchCord server ────────────────────────────────────────
$ScriptDir = Split-Path -Parent $PSCommandPath
$PinchCordRoot = Split-Path -Parent $ScriptDir

# ── Resolve config path (fallback chain) ───────────────────────────
if (-not $ConfigPath) {
    $candidates = @()
    if ($env:PINCHME_DIR) {
        $candidates += Join-Path $env:PINCHME_DIR "cord\bots.json"
    }
    $candidates += Join-Path (Get-Location) ".pinchme\cord\bots.json"
    $repoRoot = Split-Path -Parent $PinchCordRoot
    $candidates += Join-Path $repoRoot ".pinchme\cord\bots.json"
    $candidates += Join-Path $env:USERPROFILE ".pinchme\cord\bots.json"

    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $ConfigPath = $c
            break
        }
    }
}

if (-not $ConfigPath -or -not (Test-Path $ConfigPath)) {
    Write-Host "ERROR: No bots.json found. Checked:" -ForegroundColor Red
    Write-Host "  .pinchme/cord/bots.json  (project-local)" -ForegroundColor Yellow
    Write-Host "  ~/.pinchme/cord/bots.json  (global)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To get started:" -ForegroundColor Cyan
    Write-Host "  mkdir -p .pinchme/cord" -ForegroundColor DarkGray
    Write-Host "  cp <PinchCord>/cord/bots.example.json .pinchme/cord/bots.json" -ForegroundColor DarkGray
    Write-Host "  # Edit bots.json with your Discord bot tokens" -ForegroundColor DarkGray
    exit 1
}

Write-Host "Config: $ConfigPath" -ForegroundColor DarkGray

try {
    $botsJson = Get-Content $ConfigPath -Raw | ConvertFrom-Json
} catch {
    Write-Host "ERROR: Failed to parse bots.json at $ConfigPath" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Yellow
    exit 1
}

# Default to all bots if none specified
if (-not $Bots -or $Bots.Count -eq 0) {
    $Bots = $botsJson.PSObject.Properties.Name
}

# ── WSL + tmux mode (delegate to launch.sh) ───────────────────────
if ($UseWsl) {
    $wslCheck = wsl --list --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: WSL is not installed or not available." -ForegroundColor Red
        Write-Host "  Install WSL: wsl --install" -ForegroundColor Yellow
        Write-Host "  Or omit -UseWsl to use Windows Terminal tabs." -ForegroundColor Yellow
        exit 1
    }
    $launchSh = "$ScriptDir/launch.sh"
    if (-not (Test-Path $launchSh)) {
        Write-Host "ERROR: launch.sh not found at $launchSh" -ForegroundColor Red
        exit 1
    }
    $wslPath = wsl wslpath -u ($launchSh -replace '\\', '/')
    $wslConfig = wsl wslpath -u ($ConfigPath -replace '\\', '/')
    $botArgs = ($Bots -join ' ')
    Write-Host "Delegating to WSL + tmux..." -ForegroundColor Cyan
    wsl bash $wslPath --config $wslConfig $botArgs
    exit $LASTEXITCODE
}

# ── Self-relaunch into named terminal window ───────────────────────
$botsFile = "$env:TEMP\pinchcord-launch-bots.txt"

if ($env:PINCHCORD_LAUNCHER -ne "1") {
    $env:PINCHCORD_LAUNCHER = "1"
    Set-Content -Path $botsFile -Value ($Bots -join "`n")
    wt -w $Window new-tab --title "Launcher" powershell -ExecutionPolicy Bypass -File $PSCommandPath -ConfigPath "$ConfigPath"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to open Windows Terminal tab. Is 'wt' installed?" -ForegroundColor Red
        exit 1
    }
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

    # Bots outside the PinchCord repo need --mcp-config to find the server.
    # Generate a temp MCP config with the absolute path to PinchCordRoot,
    # since ${CLAUDE_PLUGIN_ROOT} only works in plugin mode.
    $mcpFlag = ""
    $repoRoot = (Get-Item (Split-Path -Parent $PinchCordRoot)).FullName
    $resolved = if ([System.IO.Path]::IsPathRooted($workDir)) { $workDir } else { try { (Resolve-Path $workDir -ErrorAction Stop).Path } catch { $workDir } }
    $resolvedWorkDir = $resolved
    if ($resolvedWorkDir -and -not $resolvedWorkDir.StartsWith($repoRoot)) {
        $mcpConfigPath = "$env:TEMP\pinchcord-mcp-$($BotName.ToLower()).json"
        $pinchCordAbsolute = (Get-Item $PinchCordRoot).FullName
        $escapedPath = $pinchCordAbsolute -replace '\\', '\\\\'
        $mcpJson = @"
{
  "mcpServers": {
    "pinchcord": {
      "command": "bun",
      "args": ["run", "--cwd", "$escapedPath", "--shell=bun", "--silent", "start"]
    }
  }
}
"@
        Set-Content -Path $mcpConfigPath -Value $mcpJson
        $mcpFlag = "--mcp-config `"$mcpConfigPath`""
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

# ── Helpers ───────────────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell

function Test-BotApproved {
    param([string]$BotName)
    # After approval, claude loads MCP servers (spawns child processes).
    # If the claude process for this bot has children, the prompt was accepted.
    $claude = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
        Where-Object { $_.CommandLine -match [regex]::Escape("$BotName-discord") }
    if (-not $claude) { return $false }
    $pid = $claude[0].ProcessId
    $children = @(Get-CimInstance Win32_Process |
        Where-Object { $_.ParentProcessId -eq $pid })
    return $children.Count -gt 0
}

function Approve-BotTab {
    param([string]$BotName, [string]$WindowName)
    # New tab is already active after creation. Bring WT window to foreground
    # and send Enter. Target the WINDOW name, not the tab title.
    $wshell.AppActivate($WindowName) | Out-Null
    Start-Sleep -Milliseconds 400
    $wshell.SendKeys('{ENTER}')
}

# ── Launch and approve each bot ───────────────────────────────────
$launched = @()
$failed = @()

foreach ($botName in $Bots) {
    $config = $botsJson.$botName
    if (-not $config) {
        Write-Host "  SKIP: No config for '$botName' in bots.json" -ForegroundColor Yellow
        continue
    }

    $scriptPath = Write-BotLauncher -BotName $botName -Config $config

    # Open tab (becomes the active tab in the WT window)
    wt -w $Window new-tab --title $botName powershell -ExecutionPolicy Bypass -File $scriptPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  $botName FAILED to open tab" -ForegroundColor Red
        continue
    }

    Write-Host "  $botName tab opened" -ForegroundColor DarkGray

    # Wait for claude to start and show the dev channels prompt
    Start-Sleep -Seconds 5

    # Try to approve with verify-and-retry (up to 3 attempts)
    $approved = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "  $botName approving (attempt $attempt)..." -ForegroundColor Yellow

        Approve-BotTab -BotName $botName -WindowName $Window

        # Wait for MCP servers to spawn (indicates successful approval)
        $waitSecs = if ($attempt -eq 1) { 12 } else { 8 }
        Start-Sleep -Seconds $waitSecs

        if (Test-BotApproved -BotName $botName) {
            Write-Host "  $botName CONNECTED (attempt $attempt)" -ForegroundColor Green
            $approved = $true
            break
        }

        Write-Host "  $botName not connected yet" -ForegroundColor DarkGray
    }

    if ($approved) {
        $launched += $botName
    } else {
        Write-Host "  $botName FAILED after 3 attempts - may need manual Enter" -ForegroundColor Red
        $failed += $botName
        $launched += $botName  # Still track it (tab exists, just needs manual approve)
    }

    # Stagger to avoid EBUSY on ~/.claude.json
    if ($Bots.Count -gt 1 -and $botName -ne $Bots[-1]) {
        Start-Sleep -Seconds 3
    }
}

if ($launched.Count -eq 0) {
    Write-Host "No bots launched." -ForegroundColor Red
    exit 1
}

Write-Host ""
if ($failed.Count -gt 0) {
    Write-Host "WARNING: $($failed.Count) bot(s) may need manual approval: $($failed -join ', ')" -ForegroundColor Yellow
    Write-Host "  Switch to their tab in '$Window' and press Enter." -ForegroundColor DarkGray
}
Write-Host "Done. $($launched.Count) bot(s) in '$Window' window." -ForegroundColor Cyan
Write-Host "This tab can be closed or kept for monitoring." -ForegroundColor DarkGray
