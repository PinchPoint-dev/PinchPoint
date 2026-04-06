#!/usr/bin/env bash
# launch.sh — Launch PinchCord bots as tmux panes in a named session
# Mac/Linux equivalent of launch.ps1
#
# Usage:
#   ./launch.sh                     # Launch all bots in config
#   ./launch.sh Bee Beaver          # Launch specific bots
#   ./launch.sh --config /path/to/bots.json Bee  # Explicit config
#
# Requirements: tmux, jq, claude (Claude Code CLI)
#
# Config resolution (first match wins):
#   1. --config flag (explicit override)
#   2. PINCHME_DIR env var → $PINCHME_DIR/cord/bots.json
#   3. .pinchme/cord/bots.json in current working directory (project-local)
#   4. ~/.pinchme/cord/bots.json in home directory (global)
#
# Each bot opens as a named tmux window in the "PinchCord" session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PINCHCORD_ROOT="$(dirname "$SCRIPT_DIR")"
SESSION_NAME="PinchCord"
CONFIG_PATH=""
BOTS=()

# ── Parse arguments ──────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --config)
            CONFIG_PATH="$2"
            shift 2
            ;;
        --window|--session)
            SESSION_NAME="$2"
            shift 2
            ;;
        *)
            BOTS+=("$1")
            shift
            ;;
    esac
done

# ── Check dependencies ───────────────────────────────────────────────
for cmd in tmux jq claude; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: '$cmd' is required but not found." >&2
        case "$cmd" in
            tmux) echo "  Install: brew install tmux" >&2 ;;
            jq)   echo "  Install: brew install jq" >&2 ;;
            claude) echo "  Install: https://docs.anthropic.com/en/docs/claude-code" >&2 ;;
        esac
        exit 1
    fi
done

# ── Resolve config path (fallback chain) ─────────────────────────────
if [[ -z "$CONFIG_PATH" ]]; then
    candidates=()
    [[ -n "${PINCHME_DIR:-}" ]] && candidates+=("$PINCHME_DIR/cord/bots.json")
    candidates+=("$(pwd)/.pinchme/cord/bots.json")
    repo_root="$(dirname "$PINCHCORD_ROOT")"
    candidates+=("$repo_root/.pinchme/cord/bots.json")
    candidates+=("$HOME/.pinchme/cord/bots.json")

    for c in "${candidates[@]}"; do
        if [[ -f "$c" ]]; then
            CONFIG_PATH="$c"
            break
        fi
    done
fi

if [[ -z "$CONFIG_PATH" || ! -f "$CONFIG_PATH" ]]; then
    echo "ERROR: No bots.json found. Checked:" >&2
    echo "  .pinchme/cord/bots.json  (project-local)" >&2
    echo "  ~/.pinchme/cord/bots.json  (global)" >&2
    echo "" >&2
    echo "To get started:" >&2
    echo "  mkdir -p .pinchme/cord" >&2
    echo "  cp <PinchCord>/cord/bots.example.json .pinchme/cord/bots.json" >&2
    echo "  # Edit bots.json with your Discord bot tokens" >&2
    exit 1
fi

echo "Config: $CONFIG_PATH"

# Validate JSON
if ! jq empty "$CONFIG_PATH" 2>/dev/null; then
    echo "ERROR: Failed to parse bots.json at $CONFIG_PATH" >&2
    exit 1
fi

# Default to all bots if none specified
if [[ ${#BOTS[@]} -eq 0 ]]; then
    while IFS= read -r line; do BOTS+=("$line"); done < <(jq -r 'keys[]' "$CONFIG_PATH")
fi

# ── Launch tmux session ──────────────────────────────────────────────
# Create session if it doesn't exist (detached)
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux new-session -d -s "$SESSION_NAME" -n "Launcher"
    echo "Created tmux session: $SESSION_NAME"
else
    echo "Using existing tmux session: $SESSION_NAME"
fi

echo "PinchCord Fleet Launcher"
echo "Launching: ${BOTS[*]}"
echo ""

launched=()

for bot_name in "${BOTS[@]}"; do
    # Check bot exists in config
    if ! jq -e ".[\"$bot_name\"]" "$CONFIG_PATH" &>/dev/null; then
        echo "  SKIP: No config for '$bot_name' in bots.json"
        continue
    fi

    # Read bot config
    token=$(jq -r ".[\"$bot_name\"].token // empty" "$CONFIG_PATH")
    work_dir=$(jq -r ".[\"$bot_name\"].workDir // empty" "$CONFIG_PATH")
    prompt_file=$(jq -r ".[\"$bot_name\"].promptFile // empty" "$CONFIG_PATH")
    model=$(jq -r ".[\"$bot_name\"].model // \"claude-sonnet-4-6\"" "$CONFIG_PATH")
    effort=$(jq -r ".[\"$bot_name\"].effort // \"high\"" "$CONFIG_PATH")
    extra_args=$(jq -r ".[\"$bot_name\"].extraArgs // empty" "$CONFIG_PATH")
    channel_id=$(jq -r ".[\"$bot_name\"].channelId // empty" "$CONFIG_PATH")
    session_name="${bot_name}-discord"

    if [[ -z "$token" || -z "$work_dir" || -z "$prompt_file" ]]; then
        echo "  SKIP: $bot_name missing required fields (token, workDir, promptFile)"
        continue
    fi

    # Fall back to env for channel ID
    channel_id="${channel_id:-${PINCHHUB_CHANNEL_ID:-}}"

    # Build MCP config for cross-repo bots (secure temp file)
    mcp_flag=""
    repo_root="$(cd "$PINCHCORD_ROOT/.." 2>/dev/null && pwd)"
    resolved_work_dir="$(cd "$work_dir" 2>/dev/null && pwd || echo "$work_dir")"
    if [[ "$resolved_work_dir" != "$repo_root"* ]]; then
        mcp_config_path="$(mktemp /tmp/pinchcord-mcp-XXXXXX.json)"
        chmod 600 "$mcp_config_path"
        cat > "$mcp_config_path" <<MCPEOF
{
  "mcpServers": {
    "pinchcord": {
      "command": "bun",
      "args": ["run", "--cwd", "$PINCHCORD_ROOT", "--shell=bun", "--silent", "start"]
    }
  }
}
MCPEOF
        mcp_flag="--mcp-config \"$mcp_config_path\""
    fi

    # Write a temp launch script (avoids token leaking into shell history)
    bot_script="$(mktemp /tmp/pinchcord-bot-XXXXXX.sh)"
    chmod 700 "$bot_script"
    cat > "$bot_script" <<BOTEOF
#!/usr/bin/env bash
export DISCORD_BOT_TOKEN='$token'
export PINCHHUB_CHANNEL_ID='$channel_id'
export PINCHCORD_HEARTBEAT=true
cd '$work_dir'
echo '=== $bot_name on PinchCord ==='
claude --dangerously-load-development-channels server:pinchcord $mcp_flag --append-system-prompt-file '$prompt_file' --model '$model' --effort $effort --name $session_name $extra_args
BOTEOF

    # Create a new tmux window running the script (token stays out of history)
    # exec bash keeps the window open after claude exits for debugging
    tmux new-window -t "$SESSION_NAME" -n "$bot_name" "bash $bot_script; exec bash"

    echo "  $bot_name window added"
    launched+=("$bot_name")

    # Stagger launches to avoid EBUSY on ~/.claude.json
    if [[ ${#BOTS[@]} -gt 1 && "$bot_name" != "${BOTS[-1]}" ]]; then
        sleep 3
    fi
done

if [[ ${#launched[@]} -eq 0 ]]; then
    echo "No bots launched."
    exit 1
fi

echo ""
echo "Auto-approving dev channels prompt..."

# Wait for Claude to start and show the prompt
sleep 5

for bot_name in "${launched[@]}"; do
    # Send Enter to approve the dev channels prompt
    tmux send-keys -t "$SESSION_NAME:$bot_name" Enter
    echo "  $bot_name approved"
    sleep 1
done

echo ""
echo "Done. ${#launched[@]} bot(s) in tmux session '$SESSION_NAME'."
echo ""
echo "Useful commands:"
echo "  tmux attach -t $SESSION_NAME          # View all bots"
echo "  tmux select-window -t $SESSION_NAME:Bee  # Switch to a bot"
echo "  tmux kill-session -t $SESSION_NAME    # Stop all bots"
