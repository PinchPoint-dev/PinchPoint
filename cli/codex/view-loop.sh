#!/usr/bin/env bash
# Viewer re-attach loop for `pinchcord view <Bot>`. Reads the adapter's
# threads.json ($1) and attaches a literal codex TUI to the bot's current
# home-channel thread, re-attaching when the thread resets (app-server restart,
# `<bot> reset`). Kept as a committed script — not an inline string — so the
# tmux -> sh -c -> bash chain can't blank out its $-expansions (which is exactly
# what broke the first inline version).
set -u

F="${1:-}"
if [ -z "$F" ]; then echo "pinchcord view: no threads-file path given" >&2; exit 2; fi
echo "pinchcord view — watching $F"

while true; do
  if [ ! -f "$F" ]; then
    echo "waiting for the bot to start (no threads.json yet)…"; sleep 3; continue
  fi
  URL=$(jq -r '.appServerUrl // empty' "$F" 2>/dev/null)
  CH=$(jq -r '.homeChannelId // empty' "$F" 2>/dev/null)
  TID=$(jq -r --arg c "$CH" '.threads[$c] // empty' "$F" 2>/dev/null)
  AENV=$(jq -r '.authTokenEnv // empty' "$F" 2>/dev/null)
  if [ -z "$TID" ] || [ -z "$URL" ]; then
    echo "waiting for the home-channel thread…"; sleep 3; continue
  fi
  echo "attaching to thread $TID on $URL…"
  # env -u OPENAI_API_KEY keeps codex on the ChatGPT subscription (same as the bots).
  if [ -n "$AENV" ]; then
    env -u OPENAI_API_KEY codex resume "$TID" --remote "$URL" --remote-auth-token-env "$AENV"
  else
    env -u OPENAI_API_KEY codex resume "$TID" --remote "$URL"
  fi
  echo "viewer detached (thread ended/reset) — re-checking in 2s…"; sleep 2
done
