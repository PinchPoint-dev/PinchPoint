#!/usr/bin/env bash
# launch.sh -- Launch a Codex bot in a tmux session (WSL compatible)
#
# Usage:
#   ./launch.sh                          # Launch with defaults
#   ./launch.sh --bot Goanna             # Override bot name
#   ./launch.sh --port 3849              # Override app-server port
#   ./launch.sh --channel 1492138400008896604  # Override channel
#
# Requirements: tmux, node, bun (for PinchCord MCP), codex CLI
#
# Architecture:
#   Window 1 (app-server): codex app-server --listen ws://127.0.0.1:PORT
#   Window 2 (adapter):    node adapter-persistent.mjs (Discord <-> Codex bridge)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Defaults
BOT_NAME="Goanna"
PORT=3848
CHANNEL_ID=""
TOKEN=""
MODEL="gpt-5.4"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --bot)      BOT_NAME="$2"; shift 2 ;;
        --port)     PORT="$2"; shift 2 ;;
        --channel)  CHANNEL_ID="$2"; shift 2 ;;
        --token)    TOKEN="$2"; shift 2 ;;
        --model)    MODEL="$2"; shift 2 ;;
        *)          echo "Unknown option: $1"; exit 1 ;;
    esac
done

BOT_LOWER="$(echo "$BOT_NAME" | tr '[:upper:]' '[:lower:]')"

# ── Token resolution ────────────────────────────────────────────
if [[ -z "$TOKEN" ]]; then
    # Try bots.json
    if [[ -f "$REPO_ROOT/.pinchme/cord/bots.json" ]] && command -v python3 &>/dev/null; then
        TOKEN="$(python3 -c "import json; d=json.load(open('$REPO_ROOT/.pinchme/cord/bots.json')); print(d.get('$BOT_NAME',{}).get('token',''))" 2>/dev/null)"
    fi
fi

if [[ -z "$TOKEN" ]]; then
    # Try .env.secrets
    KEY="$(echo "$BOT_NAME" | tr '[:lower:]' '[:upper:]')_DISCORD_TOKEN"
    if [[ -f "$REPO_ROOT/.env.secrets" ]]; then
        TOKEN="$(grep "^$KEY=" "$REPO_ROOT/.env.secrets" | cut -d= -f2)"
    fi
fi

if [[ -z "$TOKEN" ]]; then
    echo "ERROR: No Discord bot token found for $BOT_NAME" >&2
    echo "  Add token to .pinchme/cord/bots.json or .env.secrets" >&2
    exit 1
fi

echo "Token: resolved for $BOT_NAME"

# ── Set up Codex home ───────────────────────────────────────────
CODEX_HOME="$HOME/.codex-$BOT_LOWER"
mkdir -p "$CODEX_HOME"

# ── Check dependencies ──────────────────────────────────────────
for cmd in tmux node; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: '$cmd' is required but not found." >&2
        exit 1
    fi
done

# Check if codex is available (try native first, then Windows interop)
CODEX_CMD=""
if command -v codex &>/dev/null; then
    CODEX_CMD="codex"
elif command -v cmd.exe &>/dev/null && cmd.exe /c "where codex" &>/dev/null 2>&1; then
    # Use Windows codex via cmd.exe interop (WSL)
    CODEX_CMD="cmd.exe /c codex"
fi

if [[ -z "$CODEX_CMD" ]]; then
    echo "ERROR: codex CLI not found. Install with: npm install -g @openai/codex" >&2
    exit 1
fi

# ── Kill existing session ───────────────────────────────────────
tmux kill-session -t "$BOT_NAME" 2>/dev/null || true

# ── Create tmux session with app-server ─────────────────────────
tmux new-session -d -s "$BOT_NAME" -n "app-server"
# Enable mouse scrolling and generous history
tmux set -t "$BOT_NAME" -g mouse on 2>/dev/null || true
tmux set -t "$BOT_NAME" -g history-limit 10000 2>/dev/null || true

# Set env vars and start app-server
tmux send-keys -t "$BOT_NAME:app-server" "export CODEX_HOME='$CODEX_HOME'" Enter
tmux send-keys -t "$BOT_NAME:app-server" "export DISCORD_BOT_TOKEN='$TOKEN'" Enter
tmux send-keys -t "$BOT_NAME:app-server" "export DISCORD_ACCESS_MODE='static'" Enter
tmux send-keys -t "$BOT_NAME:app-server" "export PINCHHUB_CHANNEL_ID='$CHANNEL_ID'" Enter
tmux send-keys -t "$BOT_NAME:app-server" "export PINCHCORD_HEARTBEAT='true'" Enter
tmux send-keys -t "$BOT_NAME:app-server" "echo '=== $BOT_NAME app-server ===' && $CODEX_CMD app-server --listen ws://127.0.0.1:$PORT" Enter

echo "App-server starting on ws://127.0.0.1:$PORT..."
sleep 8

# ── Create adapter window ───────────────────────────────────────
tmux new-window -t "$BOT_NAME" -n "adapter"

tmux send-keys -t "$BOT_NAME:adapter" "export DISCORD_BOT_TOKEN='$TOKEN'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export DISCORD_ACCESS_MODE='static'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export PINCHHUB_CHANNEL_ID='$CHANNEL_ID'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export PINCHCORD_HEARTBEAT='true'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export CODEX_BOT_NAME='$BOT_NAME'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export CODEX_APP_SERVER_URL='ws://127.0.0.1:$PORT'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export CODEX_MODEL='$MODEL'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export CODEX_WORK_DIR='$REPO_ROOT'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "export CODEX_PROMPT_FILE='$REPO_ROOT/.pinchme/cord/prompts/$BOT_LOWER.md'" Enter
tmux send-keys -t "$BOT_NAME:adapter" "cd '$SCRIPT_DIR' && echo '=== $BOT_NAME adapter ===' && node adapter-persistent.mjs" Enter

echo ""
echo "$BOT_NAME launched in tmux session '$BOT_NAME'"
echo "  App-server: ws://127.0.0.1:$PORT (window 'app-server')"
echo "  Adapter:    adapter-persistent.mjs (window 'adapter')"
echo ""
echo "Useful commands:"
echo "  tmux attach -t $BOT_NAME                  # View bot"
echo "  tmux select-window -t $BOT_NAME:adapter   # See adapter logs"
echo "  tmux kill-session -t $BOT_NAME            # Stop bot"
# ── Open viewer tab in Windows Terminal (WSL) ──────────────────
if command -v wt.exe &>/dev/null; then
    echo ""
    echo "Opening viewer tab..."
    if wt.exe -w 0 new-tab --title "$BOT_NAME" wsl.exe tmux attach -t "$BOT_NAME" 2>/dev/null; then
        echo "  $BOT_NAME viewer tab opened"
    else
        echo "  WARNING: Failed to open viewer tab for $BOT_NAME" >&2
    fi
fi
