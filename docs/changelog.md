# Changelog

## 0.2.0 — 2026-04-17

Codex bot support, cross-platform launchers, and distribution polish.

**New**

- Codex (GPT) bot support — `cord/codex/adapter-persistent.mjs` (always-on app-server mode) and `adapter-exec.mjs` (one-shot per message)
- Codex launchers — `cord/codex/launch.ps1` (Windows) and `cord/codex/launch.sh` (WSL / Mac / Linux)
- Resilient single-bot launchers — `cord/claude/launch-resilient.ps1` and `launch-resilient.sh` with restart loop, backoff, circuit breaker, and watchdog for unattended operation
- 3 new bot prompt archetypes — `falcon.md` (test runner), `hawk.md` (watcher), `hound.md` (bug hunter). Total archetypes: 9
- Stepped Discord bot setup guide in README with 8 inline screenshots (`docs/images/setup/`)
- `docs/new-server-setup.md` — generic walkthrough for adding bots to a new project
- `cord/pinchme-template/SETUP.md` — LLM-followable setup instructions
- Cross-repo bot support — `workDir` outside the repo auto-generates an MCP config

**Changed**

- Renamed `fleet/` directory to `cord/` to match the brand
- `cord/claude/launch.sh` — tmux session settings (passthrough, set-titles, mouse, 10k history) now apply on every launch; auto-opens per-bot viewer tabs in Windows Terminal instead of the single `--attach` flow
- `cord/codex/launch.ps1` — codex binary resolved dynamically via `Get-Command` with `$env:APPDATA` fallback (no hardcoded user paths)

**Fixed**

- `set-titles` / `allow-passthrough` so Claude's thinking spinner reaches the outer terminal tab title
- WSL path conversion for `promptFile` and shell-script line endings
- Fleet launcher verify-and-retry + explicit WSL launch option
- UTF-8 BOM added to PowerShell scripts to avoid Windows-1252 parsing errors
- Silent failures across launchers, modules, and comms queue now log to stderr
- Comms queue race condition and drain-loop iteration cap

**Removed**

- `close-tab.ps1` — obsolete after `-NoExit` was dropped from tab launch; close works via `Stop-Process`

**Security & licensing**

- Apache 2.0 LICENSE file now matches `package.json`, `NOTICE`, and README
- All example bot names and operator references genericized (`MyBot`, `the operator`) — no internal project identity in the distro

## 0.1.0 — 2026-04-01

Initial public release.

- Modular MCP server forked from the official Claude Code Discord plugin (v0.0.4)
- 10 optional modules: comms, threads, channels, attachments, interactions, diagnostics, scheduler, formats, heartbeat, commands
- Fleet launcher — `launch.sh` (Mac/Linux, tmux) and `launch.ps1` (Windows, Windows Terminal)
- Bot-to-bot communication in shared hub channels
- Auto-download attachments before Discord CDN URLs expire
- Slash commands for task dispatch and fleet status
- Persistent diagnostics log with auto-rotation
- Scheduled message queue
- Heartbeat status writer for monitoring
