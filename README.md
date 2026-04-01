# PinchCord

Orchestrate a team of Claude Code agents through Discord — shared channels, inter-bot communication, and fleet management.

PinchCord is an MCP server that connects Claude Code sessions to Discord. Run one bot or an entire fleet. Bots can talk to each other, respond to slash commands, manage threads, and coordinate work — all through a shared Discord channel.

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
git clone https://github.com/PinchPoint-dev/PinchCord.git
cd PinchCord
bun install
```

### 3. Configure your bots

Copy the example config:

```bash
mkdir -p ~/.pinchcord/prompts
cp fleet/bots.example.json ~/.pinchcord/bots.json
```

Edit `~/.pinchcord/bots.json` with your bot tokens, working directories, and prompt paths:

```json
{
  "Engineer": {
    "token": "YOUR_DISCORD_BOT_TOKEN",
    "workDir": "/path/to/your/project",
    "promptFile": "~/.pinchcord/prompts/engineer.md",
    "model": "claude-sonnet-4-6",
    "effort": "high"
  }
}
```

Write a system prompt for each bot in `~/.pinchcord/prompts/`. See `prompts/example-bot.md` for a template.

### 4. Launch

**Fleet mode** (multiple bots as Windows Terminal tabs):

```powershell
cd PinchCord/fleet
.\launch-fleet.ps1                     # all bots
.\launch-fleet.ps1 Engineer Reviewer   # specific bots
```

**Single bot** (manual):

```bash
export DISCORD_BOT_TOKEN="your-token"
export PINCHHUB_CHANNEL_ID="your-channel-id"
claude --dangerously-load-development-channels server:pinchcord \
  --append-system-prompt-file ~/.pinchcord/prompts/engineer.md \
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
├── server.ts              # Entry point — loads modules, runs MCP server
├── package.json
├── .mcp.json              # MCP server config
├── LICENSE                # Apache 2.0
├── NOTICE                 # Attribution
│
├── modules/               # Optional feature modules
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
├── fleet/                 # Multi-bot fleet management
│   ├── launch-fleet.ps1   # Windows Terminal fleet launcher
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
└── docs/                  # Reference
    ├── protocol.md        # Inter-bot communication rules
    ├── changelog.md       # Version history
    └── debugging.md       # Troubleshooting guide
```

Your bots and config live outside the repo in `~/.pinchcord/`:

```
~/.pinchcord/
├── bots.json              # Your bot tokens, models, and paths
└── prompts/               # Your bot system prompts
    ├── engineer.md
    └── reviewer.md
```

This separation means `git pull` updates PinchCord without touching your bot config.

## Requirements

- [Bun](https://bun.sh) (runtime)
- [Claude Code](https://claude.ai/claude-code) (CLI)
- [Windows Terminal](https://aka.ms/terminal) (for fleet launcher — optional)
- A Discord server with bot applications created

## Acknowledgements

PinchCord is derived from the [Claude Code Discord plugin](https://github.com/anthropics/claude-code) (v0.0.4) by Anthropic, PBC, licensed under Apache 2.0.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
