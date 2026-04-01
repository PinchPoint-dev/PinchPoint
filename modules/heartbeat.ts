/**
 * heartbeat.ts — Dashboard status writer and restart marker detection for PinchCord.
 *
 * Writes a `.status-{botname}.json` file every 60 seconds so the web dashboard
 * at /pinch/bots can display bot health. Also watches for `.restart-{botname}`
 * marker files — when found, exits cleanly so the launcher can restart the bot.
 *
 * Low priority module. Opt-in via PINCHCORD_HEARTBEAT=true env var.
 * If this file is absent or the env var is not set, dashboard integration is disabled.
 */

import type { Client } from 'discord.js'
import { writeFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const BOT_NAME = process.env.PINCHCORD_BOT_NAME ?? 'unknown'
const ENABLED = process.env.PINCHCORD_HEARTBEAT === 'true'

let discordClient: Client | null = null
let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let startTime: number = Date.now()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the heartbeat writer. Starts the 60-second loop.
 * Only activates if PINCHCORD_HEARTBEAT=true is set.
 */
export function init(client: Client): void {
  if (!ENABLED) return

  discordClient = client
  startTime = Date.now()
  mkdirSync(STATE_DIR, { recursive: true })

  // Write immediately, then every 60 seconds
  writeStatus()
  heartbeatInterval = setInterval(() => {
    writeStatus()
    checkRestartMarker()
  }, 60_000)
  heartbeatInterval.unref()

  // Ensure offline status is written on kill signals
  const onExit = () => { stop(); process.exit(0) }
  process.on('SIGTERM', onExit)
  process.on('SIGINT', onExit)

  process.stderr.write(`pinchcord heartbeat: active for ${BOT_NAME}\n`)
}

/**
 * Stop the heartbeat loop and write a final offline status. Call on shutdown.
 */
export function stop(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
  writeStatus('offline')
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function writeStatus(override?: 'offline'): void {
  const statusFile = join(STATE_DIR, `.status-${BOT_NAME}.json`)
  const status = {
    bot: BOT_NAME,
    status: override ?? 'online',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastHeartbeat: new Date().toISOString(),
    gateway: discordClient?.isReady() ? 'connected' : 'disconnected',
    user: discordClient?.user?.tag ?? null,
  }
  try {
    writeFileSync(statusFile, JSON.stringify(status, null, 2))
  } catch (err) {
    process.stderr.write(`pinchcord heartbeat: failed to write status: ${err}\n`)
  }
}

function checkRestartMarker(): void {
  const markerFile = join(STATE_DIR, `.restart-${BOT_NAME}`)
  if (existsSync(markerFile)) {
    rmSync(markerFile, { force: true })
    process.stderr.write(`pinchcord heartbeat: restart marker found, exiting cleanly\n`)
    writeStatus('offline')
    process.exit(0)
  }
}
