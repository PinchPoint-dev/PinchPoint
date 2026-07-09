#!/usr/bin/env bash
# Supervised codex app-server for a codex bot. Keeps the app-server alive: if it
# crashes or exits, it clears the port and restarts. Started by `pinchcord
# launch` for codex bots (was previously a manual step that stayed dead after any
# crash/port-conflict — the recurring "adapter WebSocket 1006 / viewer failed to
# connect" outage).
#
# Usage: app-server.sh <port>
# The --listen host stays 127.0.0.1 (localhost only); network_access=true lets
# the bot's own shell reach Discord via the pinchcord CLI. OPENAI_API_KEY and
# DISCORD_BOT_TOKEN are stripped so codex stays on the ChatGPT subscription and
# the bot authenticates as itself.
set -u

PORT="${1:-3848}"
URL="ws://127.0.0.1:${PORT}"

echo "[app-server supervisor] port ${PORT} — starting"
while true; do
  # Free the port in case a previous instance hasn't fully released it (the
  # "Address in use (os error 98)" that left it dead).
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 && sleep 1

  env -u OPENAI_API_KEY -u DISCORD_BOT_TOKEN codex app-server \
    --listen "${URL}" \
    -c shell_environment_policy.inherit=all \
    -c sandbox_workspace_write.network_access=true

  code=$?
  echo "[app-server supervisor] app-server exited (${code}) — restarting in 2s"
  sleep 2
done
