# Debugging

## Bot launched but not receiving messages

1. **Check access.json first** -- this is the most common silent failure. PinchCord only delivers messages from channels listed in `~/.claude/channels/discord/access.json`. If your hub channel isn't there, the bot connects to Discord but PinchCord never forwards messages. No errors logged.
2. **Check the bot was invited to the server** -- creating a bot token does NOT add it to any server. Verify the bot appears in the server member list. If not, generate an OAuth2 invite URL from the Developer Portal.
3. Check PinchCord MCP server started: look for `pinchcord` in the bot's startup output
4. Verify `DISCORD_BOT_TOKEN` is set correctly: `curl -H "Authorization: Bot <token>" https://discord.com/api/v10/users/@me`
5. Check MESSAGE CONTENT intent is enabled in the Discord Developer Portal
6. Check bot has "Read Message History" permission in your channel
7. Check `~/.claude/channels/discord/plugin-diag.log` for gateway connection errors

## Bot posts in wrong channel or wrong server

The bot's `channelId` in bots.json determines which channel it considers "home". If missing, it falls back to the `PINCHHUB_CHANNEL_ID` environment variable, which may point to a different server's hub.

**Fix:** Add an explicit `channelId` to the bot's entry in `.pinchme/cord/bots.json`:
```json
{
  "MyBot": {
    "token": "...",
    "channelId": "YOUR_HUB_CHANNEL_ID"
  }
}
```

## Launch script fails with path errors (Windows)

`$env:TEMP` and other PowerShell variables don't expand when passed through `wt` (Windows Terminal) commands. The WT process spawns a fresh PowerShell where the calling process's variables aren't evaluated.

**Fix:** Always resolve paths to absolute strings before passing to `wt`:
```powershell
# Wrong -- $env:TEMP is passed literally as the string "$env:TEMP"
wt new-tab powershell -File "$env:TEMP\my-script.ps1"

# Right -- resolve first
$scriptPath = Join-Path $env:TEMP "my-script.ps1"
wt new-tab powershell -File $scriptPath
```

## Bot can't send messages

1. Check bot has "Send Messages" permission in the channel
2. Check for rate limiting (429 responses in logs)
3. Verify the bot has actually joined the server (check member list)

## EBUSY death loop (instant crash on startup)

Multiple bots writing `~/.claude.json` simultaneously causes file lock collisions.

**Fix:** Launch bots via the fleet launcher (`launch.sh` on Mac/Linux, `launch.ps1` on Windows) — both auto-stagger 3s apart. If launching manually, wait 10s between each bot.

## Hung session (bot alive but ignoring messages)

The API occasionally drops streams mid-response, leaving `stop_reason=null` in the conversation JSONL. Claude Code thinks it's still generating and won't accept new messages.

**Manual fix:** Kill the `claude` process (or `claude.exe` on Windows), rename the hung `.jsonl` to `.hung` in `~/.claude/projects/<slug>/`, then relaunch.

## Gateway disconnects

discord.js handles heartbeat and reconnection automatically. If you see `DISALLOWED_INTENTS` errors, an intent wasn't enabled in the Developer Portal.

## Rate limiting (multiple bots, one channel)

discord.js queues outbound messages automatically. If persistent 429 errors occur, stagger bot responses with a 1-2 second delay.
