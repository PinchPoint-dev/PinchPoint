# PinchMe Setup Guide

This file is designed for both humans and AI assistants. If you're an LLM helping a user set up PinchCord, follow these steps in order.

## Prerequisites

Before starting, verify:
- [ ] **Bun** is installed (`bun --version` — install from https://bun.sh)
- [ ] **Claude Code** CLI is installed (`claude --version` — install from https://claude.ai/claude-code)
- [ ] **tmux** is installed on Mac/Linux (`tmux -V` — install with `brew install tmux` or `apt install tmux`)
- [ ] A **Discord server** exists where the bots will operate
- [ ] Bot applications have been created in the [Discord Developer Portal](https://discord.com/developers/applications) — one per bot. See the main README for step-by-step screenshots.

## Step 1 — Install PinchCord

Clone the PinchCord repo as a `.pinchpoint/` directory inside your project:

```bash
cd /path/to/your/project
git clone https://github.com/PinchPoint-dev/PinchPoint.git .pinchpoint
cd .pinchpoint && bun install && cd ..
```

Verify: `.pinchpoint/server.ts` should exist and `bun install` should have created `node_modules/`.

## Step 2 — Create your .pinchme directory

The `.pinchme/` directory holds your bot config, prompts, and project-specific data. It lives in your project root (not inside `.pinchpoint/`).

```bash
# Copy the template
cp -r .pinchpoint/cord/pinchme-template .pinchme
```

This creates:
```
.pinchme/
├── .gitignore          # Protects bots.json and logs from commits
├── cord/
│   ├── bots.json       # Bot tokens and config (gitignored)
│   ├── prompts/        # Bot system prompts
│   │   └── mybot.md    # Template prompt — rename and customize
│   ├── agents/         # Custom agents (optional)
│   ├── skills/         # Project-specific skills (optional)
│   └── logs/           # Runtime logs (gitignored)
├── mind/               # Team archive / institutional memory
├── point/              # Point config (future)
└── pinch/              # Pinch config (future)
```

## Step 3 — Configure bots.json

Edit `.pinchme/cord/bots.json`. Each bot needs:

```json
{
  "BotName": {
    "token": "DISCORD_BOT_TOKEN_FROM_DEVELOPER_PORTAL",
    "workDir": ".",
    "promptFile": ".pinchme/cord/prompts/botname.md",
    "model": "claude-sonnet-4-6",
    "effort": "high",
    "channelId": "DISCORD_CHANNEL_SNOWFLAKE_ID"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Discord bot token from the Developer Portal (Bot tab → Reset Token → Copy) |
| `workDir` | Yes | Working directory for the bot. Use `"."` for the current project, or an absolute path for cross-repo bots |
| `promptFile` | Yes | Path to the bot's system prompt file |
| `model` | No | Claude model ID (default: `claude-sonnet-4-6`). Options: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |
| `effort` | No | Reasoning effort: `high`, `medium`, or `low` (default: `high`) |
| `channelId` | Yes | Discord channel snowflake ID. Get it by right-clicking the channel in Discord with Developer Mode enabled (User Settings → App Settings → Advanced → Developer Mode) |
| `extraArgs` | No | Additional Claude Code CLI arguments (e.g., `"--add-dir /path/to/other/repo"`) |

**Important:** `channelId` must be set correctly or the bot will post in the wrong server.

## Step 4 — Write bot prompts

Create a `.md` file in `.pinchme/cord/prompts/` for each bot. The prompt defines the bot's role, personality, and instructions.

See `.pinchpoint/prompts/` for 9 example templates:

| Template | Role |
|----------|------|
| `bee.md` | Lead engineer — complex features, architecture, deep debugging |
| `beaver.md` | General dev — quick fixes, config, maintenance |
| `owl.md` | QA & oversight — reviews, architecture watchdog |
| `fox.md` | Researcher — gathers information, investigates questions |
| `badger.md` | Data manager — uploads, imports, index maintenance |
| `crow.md` | Team archivist — records decisions, solutions, failures |
| `hawk.md` | Silent watcher — second opinion, speaks only when catching issues |
| `hound.md` | Bug hunter — finds defects, writes reproductions and regression tests |
| `falcon.md` | Test runner — runs pipelines, produces structured verification reports |

Key things every prompt should include:
- The bot's name and role
- When to speak vs stay silent
- Instruction to use the `reply` MCP tool for all Discord responses (stdout is not visible)
- Team roster (other bots and their roles)
- The human operator's authority

## Step 5 — Set up Discord access

Each bot needs an `access.json` file to know which channels and users it should respond to. This file lives at `~/.claude/channels/discord/access.json` on the machine running the bot.

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_DISCORD_USER_ID"],
  "groups": {
    "YOUR_HUB_CHANNEL_ID": {
      "requireMention": false,
      "allowFrom": ["YOUR_DISCORD_USER_ID"]
    }
  },
  "pending": {}
}
```

Get your Discord user ID: enable Developer Mode in Discord (User Settings → Advanced), then right-click your own name and click "Copy User ID".

**Note:** All bots on the same machine share this access.json. If each bot runs on a separate machine, each needs its own copy.

## Step 6 — Launch

```bash
# Launch all bots
./.pinchpoint/cord/claude/launch.sh

# Launch specific bots
./.pinchpoint/cord/claude/launch.sh BotName1 BotName2

# Launch with explicit config (for cross-repo setups)
./.pinchpoint/cord/claude/launch.sh --config /path/to/bots.json BotName
```

The launcher:
1. Creates a tmux session called `PinchCord`
2. Opens each bot as a named tmux window
3. Sets up mouse scrolling and 10k line history
4. Auto-approves the dev channels prompt
5. Opens a Windows Terminal viewer tab per bot (WSL only)

### Verify

```bash
# Check all bots are running
tmux list-windows -t PinchCord

# View a specific bot's terminal
tmux attach -t PinchCord
# Then Ctrl+B, then the window number to switch bots

# Send a test message in your Discord channel
# The bot should respond within a few seconds
```

## Troubleshooting

**Bot doesn't respond to messages:**
1. Check the bot is online in Discord (green dot next to its name)
2. Check `channelId` in bots.json matches the channel you're messaging in
3. Check `access.json` includes your user ID and the channel ID
4. Check the bot's tmux window for errors: `tmux attach -t PinchCord` then select the bot's window

**"MCP config file not found":**
The bot's `workDir` is outside the PinchCord project. The launcher handles this automatically — if you see this error, update to the latest `launch.sh`.

**"EBUSY" errors on launch:**
Multiple Claude Code sessions colliding on `~/.claude.json`. Wait a few seconds and relaunch the affected bot. The staggered launch (3s between bots) usually prevents this.

**Bot posts in the wrong channel:**
`channelId` in bots.json is wrong or missing. Update it to the correct Discord channel snowflake ID.
