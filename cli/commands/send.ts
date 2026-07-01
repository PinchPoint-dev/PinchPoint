import { Routes } from 'discord.js'
import { chunk } from '../lib/chunk'
import { readFileSync, statSync } from 'fs'
import type { Ctx } from '../lib/ctx'

const MAX_CHUNK = 2000

export async function run(ctx: Ctx): Promise<string> {
  // Join all positionals (like edit/thread send) — `send -- --literal text`
  // arrives as several positionals and must not be silently truncated.
  const text = ctx.positionals.length ? ctx.positionals.join(' ') : ctx.stdin
  if (!text) throw new Error('send: no text (pass as argument or via stdin)')
  const replyTo = typeof ctx.flags['reply-to'] === 'string' ? ctx.flags['reply-to'] as string : undefined

  const fileFlag = ctx.flags.file
  const files = Array.isArray(fileFlag) ? fileFlag as string[] : typeof fileFlag === 'string' ? [fileFlag] : []
  const attachments = files.map((path, i) => {
    statSync(path) // throws if missing
    return { id: i, name: path.split(/[\\/]/).pop()!, data: readFileSync(path) }
  })

  const chunks = chunk(text, MAX_CHUNK, 'newline')
  const sentIds: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = { content: chunks[i] }
    if (i === 0 && replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false }
    const useFiles = i === 0 ? attachments : []
    const res = await ctx.rest.post(Routes.channelMessages(ctx.channelId), {
      body: useFiles.length
        ? { ...body, attachments: useFiles.map(a => ({ id: a.id, filename: a.name })) }
        : body,
      files: useFiles.map(a => ({ name: a.name, data: a.data })),
    }) as { id: string }
    sentIds.push(res.id)
  }
  return sentIds.length === 1
    ? `sent (id: ${sentIds[0]})`
    : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
}
