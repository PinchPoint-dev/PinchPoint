# PinchCord

Orchestrate a team of Claude Code agents through Discord — shared channels, inter-bot communication, and fleet management.

PinchCord is an MCP server + Claude Code plugin that connects Claude Code sessions to Discord. Run one bot or an entire fleet. Bots can talk to each other, respond to slash commands, manage threads, and coordinate work — all through a shared Discord channel.

PinchCord is part of the **PinchPoint** suite. This repo also ships skills for Point (knowledge API) and Pinch (scheduling) as they mature.

## How it works

```
You (Discord)
    | messages
Discord Server
    +-- #hub channel      (all bots see everything)
    +-- Bot DMs           (private per-bot)
         | WebSocket (discord.js)
PinchCord MCP Server (one per bot)
    | stdio
Claude Code (bot session)
```

Each bot is a Claude Code process with PinchCord loaded as an MCP server. A Discord bot token determines which bot it authenticates as. A system prompt gives it a role.

## Quick start

### 1. Create Discord bots

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create one application per bot
3. Under each application's "Bot" tab:
   - Copy the bot token
   - Enable **MESSAGE CONTENT** intent
   - Enable **SERVER MEMBERS** intent
4. Invite each bot to your server with permissions: Send Messages, Read Message History, Create Public Threads, Embed Links, Attach Files, Add Reactions, Use Slash Commands

### 2. Install PinchCord

```bash
git clone https://github.com/PinchPoint-dev/PinchPoint.git .pinchpoint
cd .pinchpoint
bun install
```

### 3. Configure your bots

Set up your PinchMe directory. This is where your bot config lives — either in your project repo (project-local) or your home directory (global):

```bash
# Option A: Project-local (recommended — config lives with your project)
cp -r .pinchpoint/setup/pinchme-template .pinchme

# Option B: Global (one fleet across all projects)
cp -r .pinchpoint/setup/pinchme-template ~/.pinchme
```

Edit `.pinchme/cord/bots.json` with your bot tokens:

```json
{
  "Engineer": {
    "token": "YOUR_DISCORD_BOT_TOKEN",
    "workDir": ".",
    "promptFile": ".pinchme/cord/prompts/engineer.md",
    "model": "claude-sonnet-4-6",
    "effort": "high"
  }
}
```

Write a system prompt for each bot in `.pinchme/cord/prompts/`. See `prompts/` in this repo for 6 example templates (Bee, Beaver, Fox, Badger, Owl, Crow).

#### Cross-repo bots

A bot's `workDir` can point to a different repo. This is useful when you have specialized bots that work in separate codebases but communicate through the same Discord channel.

```json
{
  "Engineer": {
    "token": "...",
    "workDir": ".",
    "promptFile": ".pinchme/cord/prompts/engineer.md",
    "model": "claude-sonnet-4-6",
    "effort": "high"
  },
  "Scraper": {
    "token": "...",
    "workDir": "/Users/you/Projects/OtherRepo",
    "promptFile": ".pinchme/cord/prompts/scraper.md",
    "model": "claude-sonnet-4-6",
    "effort": "medium"
  }
}
```

When `workDir` points outside the project where PinchCord is installed, the launcher automatically generates an MCP config so the bot can still connect to Discord. No extra setup needed — just set the path and launch.

The `.pinchme/.gitignore` automatically protects `bots.json` (tokens) and `logs/` from being committed. Prompts and mind entries are safe to share. You should also add `.pinchme/` to your project's root `.gitignore` if you don't want any of it committed.

### 4. Launch

**Fleet mode** (multiple bots in terminal tabs/panes):

```bash
# Mac / Linux (tmux)
./.pinchpoint/fleet/launch.sh                      # all bots
./.pinchpoint/fleet/launch.sh Engineer Reviewer    # specific bots
```

```powershell
# Windows (Windows Terminal)
.\.pinchpoint\fleet\launch.ps1                     # all bots
.\.pinchpoint\fleet\launch.ps1 Engineer Reviewer   # specific bots
```

The launcher auto-detects your config: checks `.pinchme/cord/bots.json` in the current directory first, then `~/.pinchme/cord/bots.json` as a fallback.

**Single bot** (manual):

```bash
export DISCORD_BOT_TOKEN="your-token"
export PINCHHUB_CHANNEL_ID="your-channel-id"
claude --dangerously-load-development-channels server:pinchcord \
  --append-system-prompt-file .pinchme/cord/prompts/engineer.md \
  --model claude-sonnet-4-6 --effort high --name Engineer-discord
```

## Modules

PinchCord is modular — each feature is an optional file in `modules/`. Remove a module to disable that feature. With no modules, PinchCord behaves identically to the official Discord plugin.

| Module | What it does |
|--------|-------------|
| `comms` | Bot-to-bot message delivery in the hub channel |
| `threads` | Thread creation, routing, auto-unarchiving |
| `channels` | Channel creation, private channels, forwarding |
| `attachments` | Auto-download attachments before Discord CDN URLs expire |
| `interactions` | Presence (activity status), emoji reactions, pinning |
| `diagnostics` | Persistent log file with auto-rotation at 1MB |
| `scheduler` | File-based scheduled message queue |
| `formats` | Auto-render structured markdown as Discord embeds |
| `heartbeat` | Dashboard status writer, restart markers |
| `commands` | Slash commands for task dispatch and fleet status |

## Project structure

```
PinchCord/
├── server.ts              # MCP server entry point
├── package.json
├── .mcp.json              # MCP server config
├── LICENSE                # Apache 2.0
├── NOTICE                 # Attribution
│
├── .claude-plugin/        # Claude Code plugin manifest
│   └── plugin.json
│
├── modules/               # Optional MCP feature modules
│   ├── comms.ts
│   ├── threads.ts
│   ├── channels.ts
│   ├── attachments.ts
│   ├── interactions.ts
│   ├── diagnostics.ts
│   ├── scheduler.ts
│   ├── formats.ts
│   ├── heartbeat.ts
│   └── commands.ts
│
├── skills/                # Claude Code skills (by product)
│   ├── cord/              # PinchCord skills
│   │   └── fleet-management/  # Launch, approve, close bot tabs
│   ├── point/             # Point API skills (future)
│   └── pinch/             # Pinch skills (future)
│
├── fleet/                 # Multi-bot fleet management
│   ├── launch.sh          # Fleet launcher (Mac/Linux — tmux)
│   ├── launch.ps1         # Fleet launcher (Windows — Windows Terminal)
│   ├── launch-resilient.sh      # Resilient single-bot launcher (Mac/Linux)
│   ├── launch-resilient.ps1     # Resilient single-bot launcher (Windows)
│   └── bots.example.json  # Template config
│
├── prompts/               # Example bot prompt templates
│   ├── bee.md             # Lead engineer
│   ├── beaver.md          # General dev
│   ├── fox.md             # Researcher
│   ├── badger.md          # Data manager
│   ├── owl.md             # QA & oversight
│   └── crow.md            # Team archivist
│
├── setup/                 # First-time setup
│   └── pinchme-template/  # Scaffold for .pinchme/ directory
│
└── docs/                  # Reference
    ├── protocol.md        # Inter-bot communication rules
    ├── changelog.md       # Version history
    └── debugging.md       # Troubleshooting guide
```

Your bots and config live in a `.pinchme/` directory (project-local or global):

```
.pinchme/                          # In your project repo or ~/
├── .gitignore                     # Protects bots.json and logs/ from commits
├── cord/                          # PinchCord config
│   ├── bots.json                  # Bot tokens, models, paths (gitignored)
│   ├── prompts/                   # Your bot system prompts (shareable)
│   │   ├── engineer.md
│   │   └── reviewer.md
│   ├── agents/                    # Your custom agents
│   ├── skills/                    # Project-specific skills
│   └── logs/                      # Runtime logs (gitignored)
├── mind/                          # Team archive / institutional memory
├── point/                         # Point config (future)
└── pinch/                         # Pinch config (future)
```

`.pinchme/` is part of the **PinchMe** convention — a universal user directory for all PinchPoint products. `git pull` on PinchCord never touches your `.pinchme/`.

## Requirements

- [Bun](https://bun.sh) (runtime)
- [Claude Code](https://claude.ai/claude-code) (CLI)
- [tmux](https://github.com/tmux/tmux) (for fleet launcher on Mac/Linux — `brew install tmux`)
- [Windows Terminal](https://aka.ms/terminal) (for fleet launcher on Windows — optional)
- A Discord server with bot applications created

## Acknowledgements

PinchCord is derived from the [Claude Code Discord plugin](https://github.com/anthropics/claude-code) (v0.0.4) by Anthropic, PBC, licensed under Apache 2.0.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
