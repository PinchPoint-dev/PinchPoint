#!/usr/bin/env bash
# launch-resilient.sh — resilient launcher for a single PinchCord bot
# Mac/Linux equivalent of launch-resilient.ps1
#
# Usage:
#   ./launch-resilient.sh \
#     --bot Bee \
#     --token "YOUR_TOKEN" \
#     --work-dir "/path/to/project" \
#     --prompt-file ".pinchme/cord/prompts/bee.md" \
#     --project-slug "my-project" \
#     --channel-id "1234567890"
#
# Optional:
#   --model claude-sonnet-4-6  (default)
#   --effort high              (default)
#   --extra-args "..."
#
# Features:
#   - Exponential backoff with jitter (3s -> 60s cap)
#   - Circuit breaker (10 rapid crashes -> 5 min pause)
#   - Hung-session watchdog: detects API stream failures (stop_reason=null)
#   - Session quarantine: renames hung .jsonl -> .hung to prevent poisoned resume
#   - Singleton guard via PID file

set -uo pipefail

# ── Parse arguments ──────────────────────────────────────────────────
BOT_NAME=""
TOKEN=""
WORK_DIR=""
PROMPT_FILE=""
PROJECT_SLUG=""
CHANNEL_ID=""
MODEL="claude-sonnet-4-6"
EFFORT="high"
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bot)          BOT_NAME="$2";      shift 2 ;;
        --token)        TOKEN="$2";         shift 2 ;;
        --work-dir)     WORK_DIR="$2";      shift 2 ;;
        --prompt-file)  PROMPT_FILE="$2";   shift 2 ;;
        --project-slug) PROJECT_SLUG="$2";  shift 2 ;;
        --channel-id)   CHANNEL_ID="$2";    shift 2 ;;
        --model)        MODEL="$2";         shift 2 ;;
        --effort)       EFFORT="$2";        shift 2 ;;
        --extra-args)   EXTRA_ARGS="$2";    shift 2 ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

# Validate required arguments
for var_name in BOT_NAME TOKEN WORK_DIR PROMPT_FILE PROJECT_SLUG CHANNEL_ID; do
    if [[ -z "${!var_name}" ]]; then
        echo "ERROR: --$(echo "$var_name" | tr '[:upper:]' '[:lower:]' | tr '_' '-') is required" >&2
        exit 1
    fi
done

# ── Logging ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PINCH_LOGS="${PINCHCORD_LOG_DIR:-$(dirname "$SCRIPT_DIR")/../.pinchme/cord/logs}/discord"
mkdir -p "$PINCH_LOGS"
EVENTS_LOG="$PINCH_LOGS/${BOT_NAME}-events.log"
STDERR_LOG="$PINCH_LOGS/${BOT_NAME}-stderr.log"

log_event() {
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    echo "[$ts] $1" >> "$EVENTS_LOG"
    echo "[$ts] $1"
}

# ── Process tree kill ────────────────────────────────────────────────
kill_tree() {
    local pid="$1"
    # Kill all children first, then the parent
    local children
    children=$(pgrep -P "$pid" 2>/dev/null || true)
    for child in $children; do
        kill_tree "$child"
    done
    kill -9 "$pid" 2>/dev/null || true
}

# ── Clear stale API key env vars ─────────────────────────────────────
unset ANTHROPIC_API_KEY 2>/dev/null || true
unset CLAUDE_API_KEY 2>/dev/null || true

# Set PinchCord environment variables
export DISCORD_BOT_TOKEN="$TOKEN"
export PINCHHUB_CHANNEL_ID="$CHANNEL_ID"
export PINCHCORD_HEARTBEAT="true"

SESSION_NAME="${BOT_NAME}-discord"

# Validate work directory
if [[ ! -d "$WORK_DIR" ]]; then
    echo "ERROR: WorkDir '$WORK_DIR' does not exist" >&2
    exit 1
fi

# ── Singleton guard ──────────────────────────────────────────────────
PID_FILE="$PINCH_LOGS/${BOT_NAME}-launcher.pid"

if [[ -f "$PID_FILE" ]]; then
    existing_pid=$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
        # Check it's actually a shell process (our launcher), not a recycled PID
        existing_cmd=$(ps -p "$existing_pid" -o comm= 2>/dev/null || echo "")
        if [[ "$existing_cmd" =~ (bash|zsh|sh) ]] && [[ "$existing_pid" != "$$" ]]; then
            log_event "duplicate launch detected (PID $existing_pid active) - exiting"
            exit 0
        fi
    fi
fi
echo $$ > "$PID_FILE"

# Clean up PID file on exit
cleanup() {
    rm -f "$PID_FILE"
    # Kill watchdog if running
    [[ -n "${WATCHDOG_PID:-}" ]] && kill "$WATCHDOG_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ── Build claude args array ──────────────────────────────────────────
CLAUDE_ARGS=(--dangerously-load-development-channels server:pinchcord)

# Cross-repo bots need --mcp-config to find the pinchcord MCP server
PINCHCORD_ROOT="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(cd "$PINCHCORD_ROOT/.." 2>/dev/null && pwd)"
RESOLVED_WORK_DIR="$(cd "$WORK_DIR" 2>/dev/null && pwd || echo "$WORK_DIR")"

if [[ "$RESOLVED_WORK_DIR" != "$PROJECT_DIR"* ]]; then
    MCP_CONFIG="$PROJECT_DIR/.mcp.json"
    if [[ -f "$MCP_CONFIG" ]]; then
        CLAUDE_ARGS+=(--mcp-config "$MCP_CONFIG")
    fi
fi

CLAUDE_ARGS+=(--append-system-prompt-file "$PROMPT_FILE" --model "$MODEL" --effort "$EFFORT" --name "$SESSION_NAME")
if [[ -n "$EXTRA_ARGS" ]]; then
    # Split extra args on whitespace (intentional — these come from bots.json)
    read -ra extra_arr <<< "$EXTRA_ARGS"
    CLAUDE_ARGS+=("${extra_arr[@]}")
fi

# ── Session directory (for watchdog) ─────────────────────────────────
SESSION_DIR="$HOME/.claude/projects/$PROJECT_SLUG"

# ── Hung-session watchdog ────────────────────────────────────────────
# Runs in background: every 5 min, checks if the session file is stale
# and the last assistant message has stop_reason=null (dead API stream).
start_watchdog() {
    local claude_pid="$1"
    (
        sleep 120  # let session initialize

        while kill -0 "$claude_pid" 2>/dev/null; do
            sleep 300

            # Find the session file for this bot
            if [[ ! -d "$SESSION_DIR" ]]; then
                continue
            fi

            sess_file=""
            while IFS= read -r f; do
                head_line=$(head -1 "$f" 2>/dev/null || echo "")
                if echo "$head_line" | grep -q "\"customTitle\".*\"$SESSION_NAME\""; then
                    sess_file="$f"
                    break
                fi
            done < <(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -10)

            if [[ -z "$sess_file" ]]; then
                continue
            fi

            # Check staleness
            if command -v stat &>/dev/null; then
                if [[ "$(uname)" == "Darwin" ]]; then
                    last_mod=$(stat -f %m "$sess_file" 2>/dev/null || echo 0)
                else
                    last_mod=$(stat -c %Y "$sess_file" 2>/dev/null || echo 0)
                fi
                now=$(date +%s)
                stale_secs=$(( now - last_mod ))
                if [[ $stale_secs -lt 300 ]]; then
                    continue
                fi
                stale_mins=$(( stale_secs / 60 ))
            else
                continue
            fi

            # Check last assistant message for null stop_reason
            tail_lines=$(tail -5 "$sess_file" 2>/dev/null || echo "")
            if echo "$tail_lines" | grep -q '"type".*"assistant"' && \
               echo "$tail_lines" | grep -q '"stop_reason".*null'; then
                log_event "WATCHDOG: hung session (stop_reason=null, stale ${stale_mins}m), killing PID $claude_pid"
                kill -9 "$claude_pid" 2>/dev/null || true
                return
            fi
        done
    ) &
    WATCHDOG_PID=$!
}

# ── Restart loop ─────────────────────────────────────────────────────
crashes=0
backoff=3

log_event "launcher started (PID $$)"

while true; do
    log_event "$BOT_NAME starting"
    started=$(date +%s)

    # Launch claude, capturing stderr
    cd "$WORK_DIR"
    claude "${CLAUDE_ARGS[@]}" 2>>"$STDERR_LOG" &
    CLAUDE_PID=$!

    # Start the watchdog for this session
    start_watchdog "$CLAUDE_PID"

    # Wait for claude to exit
    set +e
    wait "$CLAUDE_PID"
    exit_code=$?
    set -e

    now=$(date +%s)
    alive=$(( now - started ))

    # Stop watchdog
    if [[ -n "${WATCHDOG_PID:-}" ]]; then
        kill "$WATCHDOG_PID" 2>/dev/null || true
        wait "$WATCHDOG_PID" 2>/dev/null || true
        WATCHDOG_PID=""
    fi

    log_event "$BOT_NAME exited ($exit_code) alive=${alive}s"
    kill_tree "$CLAUDE_PID"

    # ── Quarantine hung sessions ─────────────────────────────────────
    if [[ -d "$SESSION_DIR" ]]; then
        while IFS= read -r f; do
            head_line=$(head -1 "$f" 2>/dev/null || echo "")
            if echo "$head_line" | grep -q "\"customTitle\".*\"$SESSION_NAME\""; then
                tail_lines=$(tail -5 "$f" 2>/dev/null || echo "")
                if echo "$tail_lines" | grep -q '"type".*"assistant"' && \
                   echo "$tail_lines" | grep -q '"stop_reason".*null'; then
                    hung_name="${f%.jsonl}.hung"
                    mv "$f" "$hung_name" 2>/dev/null || true
                    log_event "QUARANTINE: renamed $(basename "$f") to .hung"
                fi
                break
            fi
        done < <(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -10)
    fi

    # ── Exponential backoff + circuit breaker ────────────────────────
    if [[ $alive -gt 30 ]]; then
        crashes=0
        backoff=3
    else
        crashes=$(( crashes + 1 ))
        backoff=$(( backoff * 2 ))
        [[ $backoff -gt 60 ]] && backoff=60
    fi

    if [[ $crashes -ge 10 ]]; then
        log_event "CIRCUIT BREAKER: $crashes rapid crashes, pausing 5 min"
        sleep 300
        crashes=0
        backoff=3
    else
        jitter=$(( RANDOM % 3 ))
        wait_time=$(( backoff + jitter ))
        log_event "restarting in ${wait_time}s (backoff=${backoff}s crashes=$crashes)"
        sleep "$wait_time"
    fi
done
