import { Routes, type REST } from 'discord.js'
import { chunk } from '../lib/chunk'
import type { Ctx } from '../lib/ctx'

async function postUnarchiving(rest: REST, threadId: string, content: string): Promise<{ id: string }> {
  try {
    return await rest.post(Routes.channelMessages(threadId), { body: { content } }) as { id: string }
  } catch (err) {
    const raw = (err as { code?: number | string }).code
    if (Number(raw) !== 50083) throw err
    // Thread auto-archived (24h default) — unarchive and retry once, matching the old MCP behavior.
    await rest.patch(Routes.channel(threadId), { body: { archived: false } })
    return await rest.post(Routes.channelMessages(threadId), { body: { content } }) as { id: string }
  }
}

export async function run(ctx: Ctx): Promise<string> {
  if (ctx.sub === 'create') {
    const [messageId, ...nameParts] = ctx.positionals
    const name = nameParts.join(' ')
    if (!messageId || !name) throw new Error('thread create: usage: thread create <message_id> <name>')
    const res = await ctx.rest.post(Routes.threads(ctx.channelId, messageId), {
      body: { name: name.slice(0, 100) },
    }) as { id: string }
    return `thread created (id: ${res.id})`
  }
  if (ctx.sub === 'send') {
    const [threadId, ...textParts] = ctx.positionals
    const text = textParts.length ? textParts.join(' ') : ctx.stdin
    if (!threadId || !text) throw new Error('thread send: usage: thread send <thread_id> <text> (or pipe text via stdin)')
    const ids: string[] = []
    for (const part of chunk(text, 2000, 'newline')) {
      ids.push((await postUnarchiving(ctx.rest, threadId, part)).id)
    }
    return ids.length === 1
      ? `sent to thread (id: ${ids[0]})`
      : `sent ${ids.length} parts to thread (ids: ${ids.join(', ')})`
  }
  throw new Error('thread: usage: thread create <message_id> <name> | thread send <thread_id> <text>')
}
