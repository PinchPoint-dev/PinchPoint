/**
 * diagnostics.ts — Persistent log file for PinchCord.
 *
 * Routes log output to both stderr AND a persistent file at
 * ~/.claude/channels/discord/plugin-diag.log. The file is automatically
 * rotated (truncated to the last 500 lines) when it exceeds 1MB.
 *
 * Export: log(msg) — use in place of process.stderr.write everywhere in
 * server.ts so that all plugin activity survives across restarts.
 *
 * If this file is absent, server.ts falls back to bare stderr writes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const LOG_FILE = join(STATE_DIR, 'plugin-diag.log')

/** Maximum file size before rotation is triggered (1 MB). */
const MAX_LOG_BYTES = 1 * 1024 * 1024

/** Number of lines retained after a rotation. */
const ROTATE_KEEP_LINES = 500

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensures the state directory and an initial log file exist.
 * Called lazily on first write so the module is safe to import at startup.
 */
function ensureLogFile(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    if (!existsSync(LOG_FILE)) {
      writeFileSync(LOG_FILE, '', { mode: 0o600 })
    }
  } catch (err) {
    process.stderr.write(`pinchcord diagnostics: ensureLogFile failed: ${err}\n`)
  }
}

/**
 * Rotates the log file if it exceeds MAX_LOG_BYTES.
 * Reads the current contents, keeps the last ROTATE_KEEP_LINES lines,
 * and rewrites the file. Failures are swallowed — never crash the plugin.
 */
function rotateIfNeeded(): void {
  try {
    const st = statSync(LOG_FILE)
    if (st.size <= MAX_LOG_BYTES) return

    const raw = readFileSync(LOG_FILE, 'utf8')
    const lines = raw.split('\n')
    const kept = lines.slice(-ROTATE_KEEP_LINES)
    writeFileSync(LOG_FILE, kept.join('\n'), { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`pinchcord diagnostics: log rotation failed: ${err}\n`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Writes a log message to both stderr and the persistent log file.
 *
 * Each line is prefixed with an ISO 8601 timestamp. The log file is
 * rotated automatically when it exceeds 1 MB. All errors are swallowed
 * so that a logging failure never crashes the plugin.
 *
 * @param msg - The message to log (no trailing newline required).
 */
export function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`

  // Always write to stderr first — it never fails silently.
  process.stderr.write(line)

  // Write to the persistent file.
  try {
    ensureLogFile()
    rotateIfNeeded()
    appendFileSync(LOG_FILE, line, { mode: 0o600 })
  } catch {
    // Non-fatal — stderr already received the message above.
  }
}
