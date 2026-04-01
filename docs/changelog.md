# Changelog

## 0.1.0 — 2026-04-01

Initial public release.

- Modular MCP server forked from the official Claude Code Discord plugin (v0.0.4)
- 10 optional modules: comms, threads, channels, attachments, interactions, diagnostics, scheduler, formats, heartbeat, commands
- Fleet launcher (`launch-fleet.ps1`) for running multiple bots as Windows Terminal tabs
- Bot-to-bot communication in shared hub channels
- Auto-download attachments before Discord CDN URLs expire
- Slash commands for task dispatch and fleet status
- Persistent diagnostics log with auto-rotation
- Scheduled message queue
- Heartbeat status writer for monitoring
