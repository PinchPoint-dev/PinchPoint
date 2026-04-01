/**
 * attachments.ts — Immediate attachment download, image_path, and inbox cleanup
 * for PinchCord.
 *
 * When a message arrives with attachments, call downloadOnReceipt() to save them
 * to disk before Discord CDN URLs expire. The returned DownloadedAttachment objects
 * can be passed to getAttachmentMeta() to produce notification metadata that
 * includes image_path for image files — allowing Claude to Read images directly
 * without a separate download_attachment call.
 *
 * startCleanup() / stopCleanup() manage a background interval that deletes inbox
 * files older than 1 hour, preventing unbounded disk growth.
 *
 * If this file is absent, server.ts handles attachments the standard way
 * (on-demand via the download_attachment tool).
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Attachment, Message } from 'discord.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')

/** Directory where downloaded attachment files are stored. */
export const INBOX_DIR = join(STATE_DIR, 'inbox')

/** Maximum attachment size accepted (matches Discord's own limit). */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MB

/** How long inbox files are kept before cleanup deletes them (1 hour). */
const MAX_AGE_MS = 60 * 60 * 1000

/** How often the cleanup pass runs (15 minutes). */
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000

/** MIME type prefixes that identify image files. */
const IMAGE_MIME_PREFIXES = ['image/']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of downloading a single attachment to the local inbox. */
export interface DownloadedAttachment {
  /** Absolute path to the saved file, ready to pass to Read. */
  localPath: string
  /** Original filename from Discord. */
  name: string
  /** MIME type reported by Discord (e.g. "image/png"). May be empty string if unknown. */
  contentType: string
  /** File size in bytes. */
  size: number
  /** True if the MIME type starts with "image/". */
  isImage: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns a sanitized file extension from a filename or falls back to 'bin'.
 */
function safeExt(filename: string): string {
  if (!filename.includes('.')) return 'bin'
  const raw = filename.slice(filename.lastIndexOf('.') + 1)
  return raw.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
}

/**
 * Downloads a single Discord attachment to INBOX_DIR.
 * Throws if the attachment exceeds MAX_ATTACHMENT_BYTES or the fetch fails.
 */
async function downloadOne(att: Attachment): Promise<DownloadedAttachment> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachment "${att.name}" too large: ${(att.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`,
    )
  }

  // Validate URL is a Discord CDN origin (SSRF protection)
  const parsed = new URL(att.url)
  if (parsed.protocol !== 'https:' || (!parsed.hostname.endsWith('.discord.com') && !parsed.hostname.endsWith('.discordapp.com') && !parsed.hostname.endsWith('.discordapp.net'))) {
    throw new Error(`attachment URL has unexpected origin: ${att.url}`)
  }

  mkdirSync(INBOX_DIR, { recursive: true })

  const res = await fetch(att.url)
  if (!res.ok) {
    throw new Error(`failed to fetch attachment "${att.name}": HTTP ${res.status}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? att.id
  const ext = safeExt(name)
  const localPath = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  writeFileSync(localPath, buf)

  const contentType = att.contentType ?? ''
  const isImage = IMAGE_MIME_PREFIXES.some(p => contentType.startsWith(p))

  return { localPath, name, contentType, size: att.size, isImage }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Downloads all attachments on a message immediately upon receipt.
 *
 * Call this as soon as a message arrives so CDN URLs don't expire before
 * Claude gets around to requesting them. Attachments that exceed the size
 * limit or fail to download are skipped with a warning to stderr.
 *
 * @param msg - The Discord.js Message that may carry attachments.
 * @returns Array of DownloadedAttachment descriptors (empty if none).
 */
export async function downloadOnReceipt(msg: Message): Promise<DownloadedAttachment[]> {
  if (msg.attachments.size === 0) return []

  const results: DownloadedAttachment[] = []

  for (const att of msg.attachments.values()) {
    try {
      const downloaded = await downloadOne(att)
      results.push(downloaded)
    } catch (err) {
      process.stderr.write(
        `pinchcord attachments: skipping "${att.name ?? att.id}": ${err}\n`,
      )
    }
  }

  return results
}

/**
 * Produces notification metadata for a set of downloaded attachments.
 *
 * For image attachments, includes an `image_path` field pointing to the first
 * downloaded image so Claude can call Read on it directly without a separate
 * download_attachment tool call.
 *
 * Returns an object suitable for spreading into the `meta` record that
 * server.ts builds before calling mcp.notification().
 *
 * @param downloads - Array returned by downloadOnReceipt().
 * @returns Flat key/value metadata record.
 */
export function getAttachmentMeta(downloads: DownloadedAttachment[]): Record<string, string> {
  if (downloads.length === 0) return {}

  const meta: Record<string, string> = {}

  // Local paths for all downloaded files (semicolon-separated list).
  meta.downloaded_paths = downloads.map(d => d.localPath).join('; ')

  // Convenience: image_path points to the first image attachment.
  const firstImage = downloads.find(d => d.isImage)
  if (firstImage) {
    meta.image_path = firstImage.localPath
  }

  // If there are multiple images, expose all of them.
  const allImages = downloads.filter(d => d.isImage)
  if (allImages.length > 1) {
    meta.image_paths = allImages.map(d => d.localPath).join('; ')
  }

  return meta
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let cleanupTimer: ReturnType<typeof setInterval> | null = null

/**
 * Deletes inbox files that are older than MAX_AGE_MS (1 hour).
 * Errors on individual files are swallowed — one bad file won't abort the pass.
 */
function runCleanup(inboxDir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(inboxDir)
  } catch {
    return // Directory doesn't exist yet — nothing to clean.
  }

  const cutoff = Date.now() - MAX_AGE_MS

  for (const entry of entries) {
    const filePath = join(inboxDir, entry)
    try {
      const st = statSync(filePath)
      if (st.isFile() && st.mtimeMs < cutoff) {
        rmSync(filePath, { force: true })
      }
    } catch {
      // Skip files that can't be stat'd or removed.
    }
  }
}

/**
 * Starts a background interval that deletes inbox files older than 1 hour.
 * Runs immediately on the first tick (15 minutes after start), then every
 * 15 minutes thereafter. Safe to call multiple times — a second call
 * replaces the existing interval.
 *
 * @param inboxDir - Directory to scan; defaults to the standard INBOX_DIR.
 */
export function startCleanup(inboxDir: string = INBOX_DIR): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer)
  }
  cleanupTimer = setInterval(() => runCleanup(inboxDir), CLEANUP_INTERVAL_MS)
  // Allow the process to exit even if the interval is still pending.
  if (cleanupTimer.unref) cleanupTimer.unref()
}

/**
 * Stops the background cleanup interval.
 * Call during plugin shutdown to allow a clean exit.
 */
export function stopCleanup(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
