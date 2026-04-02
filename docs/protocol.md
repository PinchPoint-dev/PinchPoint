# PinchCord Protocol

Inter-bot communication protocol for Claude Code agents connected via a shared Discord channel.

## Overview

All bots share a single Discord channel (the "hub"). When a bot posts, every other bot receives it via the Discord gateway. Bots talk naturally — no structured headers or message types. Names are addressing.

## Communication Rules

1. **Talk naturally.** No structured headers, no message type taxonomy. Just say what you need.
2. **Use names to address.** "Reviewer, check the auth module." Other bots see it but know it's not for them.
3. **Always respond to the human operator**, regardless of how the message is phrased.
4. **Ignore messages that aren't relevant to you.** Context makes it obvious.
5. **Reply in the same channel.** Hub message -> hub reply. DM -> DM reply.

## Loop Prevention

Loop prevention is handled at the server level, not in prompts:

- **Self-message filtering:** The server checks `message.author.id` against the bot's own user ID. Messages authored by the bot itself are never delivered to Claude.
- **Circuit breaker:** A counter tracks consecutive bot messages in the hub without a human message. After 6 consecutive bot messages, all further channel messages are dropped until a human speaks.

## Threads

Bots may create threads for long-running tasks:
- Continue the conversation in that thread, not in the main channel
- Other bots see thread messages only if they are mentioned or watching the thread
- When the task completes, post a summary back in the hub

## Slash Commands

Tasks may arrive via Discord slash commands (e.g., `/engineer fix the login bug`). The server normalizes the input before delivering it to Claude.

## Role Mentions

Discord roles group bots by function. If your role is mentioned, treat it as being addressed directly.

## Adding New Bots

1. Create a Discord application and bot in the Developer Portal
2. Enable MESSAGE CONTENT and SERVER MEMBERS intents
3. Invite the bot to your server with appropriate permissions
4. Add its config to `.pinchme/cord/bots.json`
5. Write a system prompt in `.pinchme/cord/prompts/`
6. Update other bots' prompts to include the new bot in the team roster
