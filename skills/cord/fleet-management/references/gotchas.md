# PinchCord Fleet Management — Gotchas & Troubleshooting

## Resolved Issues (post `-NoExit` removal, 2026-04-02)

The following issues existed when tabs were launched with `powershell -NoExit`. That flag was removed because it was the root cause of all tab-closing complexity — 4 failed approaches and 3 incidents traced back to it. Now tabs close automatically when the process exits.

### ~~Killing the Process Does Not Close the Tab~~ — RESOLVED

Process-kill now works. `Stop-Process` closes the tab because there's no `-NoExit` keeping the shell alive.

### ~~Ctrl+D Does Not Work~~ — RESOLVED

No longer relevant without `-NoExit`.

## Still Dangerous

### Sending `exit` via SendKeys Is Still Dangerous

```powershell
# DANGEROUS — DO NOT USE:
$wshell.SendKeys("exit{ENTER}")
```

**Why:** If `wt focus-tab` targets the wrong index (indices shift, can't verify), `exit` kills a live bot session. This caused the 2026-04-02 incident where Owl killed Bee, Beaver, and Crow by sending `exit` to the wrong tabs.

### AppActivate by Bot Session Name

```powershell
# UNRELIABLE:
$wshell.AppActivate("Bee-discord")
```

**Why:** Windows Terminal shows one window title for the entire window, not per-tab. The title matches the currently focused tab. `AppActivate("Bee-discord")` only works if the Bee tab is already focused — which defeats the purpose.

**Use instead:** `wt -w PinchCord focus-tab -t $index` to select the tab, then `AppActivate("PinchCord")` to bring the window to the foreground.

### Tab Index Counting

```powershell
# IMPOSSIBLE — no API for this:
$tabCount = ???  # wt has no command to return tab count
```

`wt focus-tab -t $index` silently succeeds even for out-of-range indices. There is no error, no return code, no way to detect how many tabs exist. The only reliable feedback is visual confirmation from Sam.

## Incident History (2026-04-02)

### Incident 1: Owl Killed Live Bots via `exit`

**What happened:** Owl tried to close dead tabs by sending `exit{ENTER}` via SendKeys to specific tab indices. The indices were wrong (they had shifted after earlier tab operations), and `exit` was sent to live Bee, Beaver, and Crow sessions.

**Root cause:** Tab indices shift when tabs close. No way to verify which tab is at which index.

**Lesson:** Never send `exit` to tabs. Use `Ctrl+Shift+W` (the WT close-tab shortcut) which is a terminal-level operation, not a shell command — it closes the tab regardless of shell state.

### Incident 2: Owl Killed Itself via Process Match

**What happened:** Owl ran a `Stop-Process` command matching `pinchcord-*.ps1` patterns to clean up old bot processes. The regex matched Owl's own launcher process.

**Root cause:** Insufficiently specific process filter.

**Lesson:** Always exclude your own PID and parent PID when killing processes by pattern.

### Incident 3: Owl Killed Itself Targeting Different Tab Group

**What happened:** Owl tried to close PowerShell tabs that were in a different tab group (not the PinchCord window). The focus-tab command targeted the wrong tab, and Ctrl+Shift+W closed Owl's own tab.

**Root cause:** Multiple WT windows/tab groups with similar names. `wt -w PinchCord` couldn't distinguish between groups.

**Lesson:** When tabs are in a different tab group, be explicit about which window. Ask Sam to confirm the target before sending close commands.

### Incident 4: Double Bot Launch

**What happened:** Sam said "ok do the same for Crow now" without addressing a specific bot. Both Owl and Bee launched Crow simultaneously.

**Root cause:** Ambiguous instruction — no specific bot named.

**Resolution:** Sam established the Bot Launch Permission rule: launches only happen when a specific bot is named.

## Troubleshooting

### Bot Tab Shows Error on Launch

**"MCP config file not found"**

This happens when `--mcp-config` is passed but the file doesn't exist at the specified path. Bots with `workDir` set to the project repo don't need `--mcp-config` — the project root `.mcp.json` is auto-discovered by Claude Code.

Only bots with a workDir outside the project repo need an explicit `--mcp-config` flag pointing to the PinchCord MCP config.

### Tab Didn't Close After Ctrl+Shift+W

Possible causes:
1. **Wrong window focused:** `AppActivate("PinchCord")` must be called after `focus-tab` to ensure the PinchCord window is in the foreground
2. **Timing:** Add `Start-Sleep -Milliseconds 400` between focus-tab and SendKeys
3. **Confirmation dialog:** Some WT configurations show "Close all tabs?" on last tab — this blocks the close

### Bot Didn't Auto-Approve

Possible causes:
1. **Too fast:** Claude needs ~12 seconds to boot before the dev channels prompt appears. Increase the wait time.
2. **Wrong tab focused:** The Enter keystroke went to the wrong tab. Try multiple indices.
3. **Window not in foreground:** `AppActivate("PinchCord")` must succeed before SendKeys will reach the right window.
