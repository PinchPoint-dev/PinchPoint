# Debugging

## Bot launched but not receiving messages

1. Check PinchCord MCP server started: look for `pinchcord` in the bot's startup output
2. Verify `DISCORD_BOT_TOKEN` is set correctly: `curl -H "Authorization: Bot <token>" https://discord.com/api/v10/users/@me`
3. Check MESSAGE CONTENT intent is enabled in the Discord Developer Portal
4. Check bot has "Read Message History" permission in your channel
5. Check `~/.claude/channels/discord/plugin-diag.log` for gateway connection errors

## Bot can't send messages

1. Check bot has "Send Messages" permission in the channel
2. Check for rate limiting (429 responses in logs)
3. Verify the bot has actually joined the server (check member list)

## EBUSY death loop (instant crash on startup)

Multiple bots writing `~/.claude.json` simultaneously causes file lock collisions.

**Fix:** Launch bots via `launch-fleet.ps1` (auto-staggers 3s apart). If launching manually, wait 10s between each bot.

## Hung session (bot alive but ignoring messages)

The API occasionally drops streams mid-response, leaving `stop_reason=null` in the conversation JSONL. Claude Code thinks it's still generating and won't accept new messages.

**Manual fix:** Kill the `claude.exe` PID, rename the hung `.jsonl` to `.hung` in `~/.claude/projects/<slug>/`, then relaunch.

## Gateway disconnects

discord.js handles heartbeat and reconnection automatically. If you see `DISALLOWED_INTENTS` errors, an intent wasn't enabled in the Developer Portal.

## Rate limiting (multiple bots, one channel)

discord.js queues outbound messages automatically. If persistent 429 errors occur, stagger bot responses with a 1-2 second delay.
