# pinchcord — CLI + slim MCP (opt-in, zero tool tax)

A two-part alternative to running the full PinchCord MCP, built to eliminate
the per-bot tool-schema token tax while keeping native `claude/channel`
wake-from-idle:

- **`cli.ts` (`pinchcord`)** — all **outbound** Discord actions as shell
  commands over the Discord REST API. Bots call it via Bash.
- **`server.ts`** — a **slim inbound-only MCP**: holds the Discord gateway,
  delivers inbound messages to the bot via `claude/channel`, and registers
  **zero tools**. Outbound is the CLI's job.

The full-tool `server.ts` at the repo root remains the default. This is the
opt-in lean mode.

## Why

Every MCP tool schema lives in every bot's context **every turn**. The full
server exposes a tool surface costing thousands of tokens per bot per turn
(~4.8k measured). The slim MCP registers none — bots learn the CLI surface
from one ~550-token paragraph in the MCP `instructions`. Measured result: the
"MCP tools" category disappears from `/context` entirely.

## Requirements

- [Bun](https://bun.sh) (the CLI and server run on it)
- Claude Code with the experimental channels feature (research preview). The
  slim server loads via `--dangerously-load-development-channels`, which shows
  a one-time trust dialog per session — `pinchcord launch` auto-approves it.
- For `launch`: tmux in the target environment (WSL on Windows, native on
  macOS/Linux). On Windows, bots run inside WSL with a **native** Linux bun
  and claude.

## Quickstart

```bash
cd cli && bun install

# 1. Scaffold config (writes a bots.json template on first run)
bun cli.ts setup
# … fill in .pinchme/cord/bots.json: token, channelId, workDir, promptFile

# 2. Re-run setup to provision state dirs + MCP config + PATH shim, then check
bun cli.ts setup && bun cli.ts doctor --bot MyBot

# 3. Launch (default: WSL/tmux; one tmux session + visible terminal tab per bot)
pinchcord launch MyBot
pinchcord ps
pinchcord stop --all
```

`bots.json` entries: `token`, `channelId` (hub), `workDir`, `promptFile`,
optional `effort`, `model`, `extraArgs` (extra claude flags; Windows paths are
auto-translated for WSL).

> ⚠️ **Launch MUST pass `--strict-mcp-config`** (pinchcord launch bakes this
> in). Without it, a workspace that auto-loads the full PinchCord MCP would
> load BOTH servers and the bot pays for both — worse than no migration.

## CLI usage

```
pinchcord send [text] [--channel ID] [--reply-to MID] [--file PATH ...]
pinchcord react <message_id> <emoji> [--channel ID]
pinchcord edit <message_id> <text> [--channel ID]
pinchcord fetch [--channel ID] [--limit N] [--before MID] [--full] [--json]
pinchcord download <message_id> [--channel ID] [--out DIR]
pinchcord thread create <message_id> <name> [--channel ID]
pinchcord thread send <thread_id> <text>
pinchcord delete <message_id> [--channel ID]
pinchcord whoami | doctor | setup | status
pinchcord launch [bots...] [--mode wsl|wt|mac] [--detach]
pinchcord stop <bot|--all> | restart <bot> | ps
```

Long text pipes via stdin (`send`, `edit`, `thread send`). `fetch` truncates
content at 300 chars (`--full` for everything, `--before <id>` to page back).
Literal text starting with `--` goes after a `--` separator.

### Resolution

| What    | Precedence |
|---------|------------|
| Token   | `--token` → `$DISCORD_BOT_TOKEN` → `bots.json[bot].token` |
| Channel | `--channel` → `$PINCHHUB_CHANNEL_ID` → `bots.json[bot].channelId` |
| Bot     | `--bot` → `$CLAUDE_SESSION_NAME` (a legacy `-discord` suffix is stripped) |

Inside a launched bot session, `DISCORD_BOT_TOKEN` and `PINCHHUB_CHANNEL_ID`
are already exported (from the per-bot state-dir `.env`, mode 600 — launch
and the server never put tokens on command lines), so bots just run
`pinchcord send "..."`. The `--token` flag is the exception: like any CLI
argument it is visible in the process list while the command runs — prefer
the env var or `bots.json` on shared machines.
`bots.json` is found at `$PINCHCORD_BOTS_JSON`, `./.pinchme/cord/bots.json`,
or `~/.pinchme/cord/bots.json`.

## Fleet behaviour

- **One tmux session per bot** (`Pinchcord-<Bot>`), each auto-opened as its
  own terminal tab (Windows Terminal via WSL interop, Terminal.app on mac).
  Closing a tab never kills its bot; `--detach` skips opening terminals.
- **Verified startup**: launch polls each bot, approves the dev-channels trust
  dialog when it actually renders, and reports `✓ ready (channels live)` only
  once the session is up. Crashed startups keep their pane for inspection
  (`remain-on-exit`) and show as `DEAD` in `pinchcord ps`.
- **No duplicates**: launching an already-running bot is a no-op with a
  `restart` hint (two claudes on one token would fight over the gateway).
- **Delivery watermark**: each bot persists the newest handled hub message id
  (`last-seen` in its state dir). Restarts deliver only what was missed — no
  20-message backlog replay. The watermark advances on disk only after a
  message actually reaches Claude, so a delivery that fails mid-session is
  retried at the next restart rather than silently lost. Within a running
  session delivery is at-most-once (no duplicates); a crash-restart may
  redeliver messages that raced a failed one.
- **Hub access policy**: per-bot `access.json` is provisioned with
  `requireMention: false` for the hub channel (everything in the hub reaches
  every bot); DMs stay allowlist-only. Customizations are preserved on re-runs
  of `setup`.

> ⚠️ **Restrict who can write to the hub channel.** Bot messages in the hub
> bypass the access gate entirely by design (that's how bots talk to each
> other), and with `requireMention: false` every hub message reaches every
> bot. Set the channel's Discord permissions so only your bots and trusted
> operators can post there.

## Platform support

| Mode  | Host | Status |
|-------|------|--------|
| `wsl` | Windows host, bots in WSL tmux | Default, fully supported |
| `mac` | macOS, native tmux | Supported |
| `wt`  | Windows native (Windows Terminal tabs) | Best-effort (dialog auto-approve is SendKeys-based) |
| Linux native | tmux path works; no auto-opened terminal | Experimental |

## Tests

```bash
cd cli && bun test && bunx tsc --noEmit
```
