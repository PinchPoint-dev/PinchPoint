# New Server Setup Guide

How to set up PinchCord bots on a new Discord server (e.g., adding bots to a new project). This covers the full chain of config that must be correct -- missing any step causes silent failures.

## Prerequisites

- A Discord server with a hub channel (e.g., #hub)
- Discord bot applications created in the Developer Portal
- PinchCord cloned into the new project repo (`.pinchpoint/`)
- `.pinchme/cord/` directory with prompts written

## Step-by-Step

### 1. Create Discord Bot Applications

For each bot (e.g., QA bot, Engineer bot):

1. Go to https://discord.com/developers/applications
2. Click "New Application", name it (e.g., "QA")
3. Go to Bot tab, click "Reset Token", copy the token
4. Enable these Privileged Gateway Intents:
   - MESSAGE CONTENT INTENT (required -- bots can't read messages without it)
   - SERVER MEMBERS INTENT

### 2. Invite Bots to the Server

**This step is easy to forget.** Creating a bot token does NOT add it to any server. You must generate an invite URL and use it.

For each bot:

1. Go to the bot's application in the Developer Portal
2. Go to OAuth2 > URL Generator
3. Select scopes: `bot`
4. Select permissions: Send Messages, Read Message History, Add Reactions, Embed Links, Attach Files
5. Copy the generated URL and open it in your browser
6. Select your new server from the dropdown and authorize

**Verify:** The bot should appear in the server's member list (offline). If it doesn't appear, the invite failed.

### 3. Get the Hub Channel ID

1. Enable Developer Mode in Discord (User Settings > Advanced > Developer Mode)
2. Right-click the hub channel (e.g., #hub) > Copy Channel ID
3. Save this -- you need it for bots.json and access.json

### 4. Configure bots.json

Create `.pinchme/cord/bots.json` in your project. The schema MUST be a top-level object keyed by bot name (NOT an array of bots):

```json
{
  "QA": {
    "token": "YOUR_BOT_TOKEN_HERE",
    "workDir": "C:/Users/you/Projects/Git-Repos/YourProject",
    "promptFile": ".pinchme/cord/prompts/qa.md",
    "model": "claude-sonnet-4-6",
    "effort": "high",
    "channelId": "YOUR_HUB_CHANNEL_ID"
  },
  "Engineer": {
    "token": "YOUR_BOT_TOKEN_HERE",
    "workDir": "C:/Users/you/Projects/Git-Repos/YourProject",
    "promptFile": ".pinchme/cord/prompts/engineer.md",
    "model": "claude-sonnet-4-6",
    "effort": "high",
    "channelId": "YOUR_HUB_CHANNEL_ID"
  }
}
```

**Common mistakes:**
- Using `{ "bots": [ ... ] }` array format -- launch.ps1 expects top-level object keyed by name
- Missing `channelId` -- without it, the bot falls back to PinchHub's channel ID from PinchPoint, not your server's hub
- Using the channel name instead of the numeric ID -- Discord MCP tools require snowflake IDs
- Relative `workDir` -- must be absolute path

### 5. Configure access.json

PinchCord controls which Discord channels bots can see via `~/.claude/channels/discord/access.json`. Your new hub channel must be listed in the `groups` object.

If this file already exists (e.g., from another project), add your new channel ID to the existing `groups` object. Do not overwrite existing entries:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_USER_ID"],
  "groups": {
    "EXISTING_CHANNEL_ID": {
      "requireMention": false,
      "allowFrom": ["YOUR_USER_ID"]
    },
    "YOUR_NEW_HUB_CHANNEL_ID": {
      "requireMention": false,
      "allowFrom": ["YOUR_USER_ID"]
    }
  },
  "pending": {}
}
```

`YOUR_USER_ID` is your personal Discord user ID (right-click your name > Copy User ID with Developer Mode on). `allowFrom` controls whose messages get forwarded -- typically just the human operator.

If the file doesn't exist yet, PinchCord creates it on first launch. The `/discord:access` skill can also manage it interactively.

**If you skip this:** The bot launches, connects to Discord, but PinchCord never delivers messages from your hub channel. The bot sits idle with no errors -- a silent failure.

### 6. Write System Prompts

Each bot needs a prompt file at the path specified in `promptFile` (e.g., `.pinchme/cord/prompts/qa.md`).

The prompt must include:
- The bot's identity and role
- The hub channel name and numeric ID (for MCP tool calls)
- The team roster (other bots, their roles)
- The operator's authority rule
- Push gate / deploy workflow (if applicable)

### 7. Create MCP Config

If the bot's `workDir` is different from the repo containing `.pinchpoint/`, the launcher auto-generates an MCP config. But verify that `.mcp.json` exists in the workDir and points to the PinchCord server.

If it doesn't exist, create it:

```json
{
  "mcpServers": {
    "pinchcord": {
      "command": "npx",
      "args": ["tsx", "C:/path/to/.pinchpoint/server.ts"],
      "env": {
        "DISCORD_BOT_TOKEN": "same-as-bots-json-token"
      }
    }
  }
}
```

### 8. Launch

**Option A: WSL + tmux (recommended)** -- headless, no focus needed, thinking spinner works:

```bash
# From WSL (or via: wsl bash -c '...')
cd /mnt/c/Users/you/Projects/Git-Repos/YourProject
bash .pinchpoint/cord/claude/launch.sh --attach QA
```

The launcher creates a tmux session, adds the bot as a named window, auto-approves prompts via `tmux send-keys` (no foreground focus required), and optionally opens a Windows Terminal tab attached to the session.

**Option B: Windows Terminal** -- visual tabs with SendKeys:

```powershell
.\.pinchpoint\cord\claude\launch.ps1 QA
```

The launcher reads bots.json, opens a new WT tab, starts Claude Code, and auto-approves via SendKeys (~12s delay). Requires foreground focus during approval.

**Verify:** After launch, send a test message in the hub channel. The bot should respond within 10-20 seconds.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Bot launches but never responds | Missing from access.json | Add hub channel to access.json |
| Bot launches but watches wrong channel | Missing channelId in bots.json | Add explicit channelId |
| Bot not in server member list | Never invited | Generate OAuth2 invite URL and authorize |
| "Invalid token" error on launch | Wrong token in bots.json | Copy fresh token from Developer Portal |
| Tab title shows "Claude Code" not bot name | cmd.exe title override | Known issue -- cosmetic only, doesn't affect function |
| No thinking spinner in tmux tab | `set-titles` not enabled | launch.sh sets this automatically; verify tmux 3.3+ |
| `/compact` becomes `C:/Program Files/Git/compact` | MSYS2 path mangling | Run tmux commands from WSL, not Git Bash; or prefix with `MSYS_NO_PATHCONV=1` |
| Bot responds in wrong channel instead of your hub | channelId defaulting to PinchPoint's | Set explicit channelId in bots.json |
| launch.ps1 can't find bot config | bots.json uses array format | Restructure as top-level object keyed by bot name |
| MESSAGE CONTENT intent error | Intents not enabled | Enable in Developer Portal > Bot > Privileged Intents |

## WSL Setup (one-time per machine)

If using WSL + tmux (recommended):

1. Install Ubuntu 24.04: `wsl --install Ubuntu-24.04 --no-launch`
2. Set as default: `wsl --set-default Ubuntu-24.04`
3. Create user, install tools (see launch.sh header for full commands)
4. Run `claude login` inside WSL (browser auth flow, separate from Windows)
5. Create `~/.claude/channels/discord/access.json` with your channel IDs

The WSL distro has its own filesystem and credentials -- Claude auth, access.json, and bun must all be set up independently from Windows.

## Checklist (copy for each new server)

- [ ] Discord bot applications created with tokens saved
- [ ] MESSAGE CONTENT and SERVER MEMBERS intents enabled
- [ ] Bots invited to the server (verify they appear in member list)
- [ ] Hub channel ID copied (numeric snowflake)
- [ ] bots.json created with correct schema (object, not array)
- [ ] Each bot entry has explicit `channelId` set to hub channel
- [ ] access.json updated with new hub channel (both Windows AND WSL if using tmux)
- [ ] System prompts written with correct channel IDs
- [ ] MCP config exists in workDir (auto-generated or manual)
- [ ] Test message sent and bot responded
