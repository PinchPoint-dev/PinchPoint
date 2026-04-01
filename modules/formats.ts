/**
 * formats.ts — Embed rendering and table formatting for PinchCord.
 *
 * Auto-detects structured markdown and renders it as Discord embeds when
 * appropriate. Handles markdown table rendering with two strategies:
 *   - Small tables (<5 rows): Discord embed with inline fields
 *   - Large tables (5+ rows): fenced code block for monospace alignment
 *
 * If this file is absent, server.ts renders all messages as plain text.
 */

import { EmbedBuilder } from 'discord.js'

// ---------------------------------------------------------------------------
// Bot colors
// ---------------------------------------------------------------------------

/** Embed accent colors keyed by bot name. */
export const BOT_COLORS: Record<string, number> = {
  Bee:    0xF59E0B, // amber
  Beaver: 0x92400E, // brown
  Fox:    0xEA580C, // orange
  Badger: 0x6B7280, // gray
  Owl:    0x3B82F6, // blue
}

const DEFAULT_COLOR = 0x5865F2 // Discord blurple

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type TextPart  = { type: 'text';  content: string }
export type EmbedPart = { type: 'embed'; embed: EmbedBuilder }
export type MixedPart = TextPart | EmbedPart

export type FormatResult =
  | TextPart
  | EmbedPart
  | { type: 'mixed'; parts: MixedPart[] }

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Returns true if the text looks like structured long-form markdown. */
function isStructuredMarkdown(text: string): boolean {
  const headerCount = (text.match(/^##\s/gm) ?? []).length
  return headerCount >= 2 && text.length > 500
}

/** Returns true if the text contains at least one markdown table. */
function hasMarkdownTable(text: string): boolean {
  return /^\|.+\|[\s]*\n\|[-| :]+\|/m.test(text)
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

interface ParsedTable {
  headers: string[]
  rows: string[][]
}

function parseMarkdownTable(block: string): ParsedTable | null {
  const lines = block.trim().split('\n').filter(l => l.trim().startsWith('|'))
  if (lines.length < 3) return null // need header + separator + 1 data row

  const parseRow = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1) // drop leading/trailing empty segments
      .map(cell => cell.trim())

  const headers = parseRow(lines[0])
  // lines[1] is the separator row — skip it
  const rows = lines.slice(2).map(parseRow)

  if (headers.length === 0 || rows.length === 0) return null
  return { headers, rows }
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Renders a small markdown table as a Discord embed with inline fields.
 * One field per column; values from each row are stacked with newlines.
 */
function tableToEmbed(table: ParsedTable, botName?: string): EmbedBuilder {
  const color = (botName && BOT_COLORS[botName]) ?? DEFAULT_COLOR
  const embed = new EmbedBuilder().setColor(color)

  const MAX_EMBED_FIELDS = 25
  for (let col = 0; col < Math.min(table.headers.length, MAX_EMBED_FIELDS); col++) {
    const values = table.rows.map(row => row[col] ?? '').join('\n')
    embed.addFields({
      name: table.headers[col] || '\u200b', // zero-width space for blank headers
      value: values.slice(0, 1024) || '\u200b',
      inline: true,
    })
  }

  return embed
}

/**
 * Converts a markdown table block to a monospace code block string.
 */
function tableToCodeBlock(block: string): string {
  return '```\n' + block.trim() + '\n```'
}

// ---------------------------------------------------------------------------
// Structured markdown → embed
// ---------------------------------------------------------------------------

/**
 * Converts structured markdown (## headers) to a Discord embed.
 * Each ## section becomes a field; the first non-header content becomes
 * the embed description.
 */
function structuredMarkdownToEmbed(text: string, botName?: string): EmbedBuilder {
  const color = (botName && BOT_COLORS[botName]) ?? DEFAULT_COLOR
  const embed = new EmbedBuilder().setColor(color)

  // Extract a title from the first # heading if present
  const titleMatch = text.match(/^#\s+(.+)$/m)
  if (titleMatch) {
    embed.setTitle(titleMatch[1].slice(0, 256))
  }

  // Split on ## headings
  const sections = text.split(/^##\s+/m).filter(s => s.trim())

  let descSet = false
  for (const section of sections) {
    const newline = section.indexOf('\n')
    if (newline === -1) continue

    const heading = section.slice(0, newline).trim()
    const body = section.slice(newline + 1).trim()

    // First section before any ## headings → description
    if (!heading && !descSet) {
      const desc = body.replace(/^#[^#].*\n?/gm, '').trim() // strip h1 lines
      if (desc) {
        embed.setDescription(desc.slice(0, 4096))
        descSet = true
      }
      continue
    }

    if (!heading) continue

    embed.addFields({
      name: heading.slice(0, 256),
      value: (body || '\u200b').slice(0, 1024),
    })
  }

  // If we never set a description but have pre-header text, use it
  if (!descSet) {
    const preHeader = text.split(/^##\s+/m)[0].replace(/^#[^#].*\n?/gm, '').trim()
    if (preHeader) {
      embed.setDescription(preHeader.slice(0, 4096))
    }
  }

  return embed
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Formats a message string for Discord output.
 *
 * Decision tree:
 * 1. If the text contains markdown tables, render each table section as an
 *    embed (small) or code block (large). Non-table text is returned as-is.
 * 2. Else if the text has 2+ ## headers AND is >500 chars, render as embed.
 * 3. Otherwise return plain text.
 *
 * @param text     The raw message text.
 * @param botName  Optional bot name for color selection.
 */
export function formatMessage(text: string, botName?: string): FormatResult {
  try {
    if (hasMarkdownTable(text)) {
      return formatWithTables(text, botName)
    }

    if (isStructuredMarkdown(text)) {
      return {
        type: 'embed',
        embed: structuredMarkdownToEmbed(text, botName),
      }
    }

    return { type: 'text', content: text }
  } catch (err) {
    process.stderr.write(`pinchcord formats: formatMessage error: ${err}\n`)
    return { type: 'text', content: text }
  }
}

/**
 * Splits text around table blocks and formats each piece appropriately.
 */
function formatWithTables(text: string, botName?: string): FormatResult {
  // Split on markdown table blocks (header row + separator + data rows)
  const tableRe = /(\|.+\|\s*\n\|[-| :]+\|\s*\n(?:\|.+\|\s*\n?)+)/g
  const parts: MixedPart[] = []
  let lastIndex = 0

  for (const match of text.matchAll(tableRe)) {
    const tableBlock = match[0]
    const matchStart = match.index ?? 0

    // Text before the table
    const before = text.slice(lastIndex, matchStart).trim()
    if (before) {
      parts.push({ type: 'text', content: before })
    }

    // Parse and render the table
    const parsed = parseMarkdownTable(tableBlock)
    if (parsed) {
      const isLarge = parsed.rows.length >= 5
      if (isLarge) {
        parts.push({ type: 'text', content: tableToCodeBlock(tableBlock) })
      } else {
        parts.push({ type: 'embed', embed: tableToEmbed(parsed, botName) })
      }
    } else {
      // Fallback: couldn't parse, emit as-is
      parts.push({ type: 'text', content: tableBlock })
    }

    lastIndex = matchStart + tableBlock.length
  }

  // Remaining text after last table
  const after = text.slice(lastIndex).trim()
  if (after) {
    parts.push({ type: 'text', content: after })
  }

  if (parts.length === 0) {
    return { type: 'text', content: text }
  }
  if (parts.length === 1) {
    return parts[0] as FormatResult
  }
  return { type: 'mixed', parts }
}
