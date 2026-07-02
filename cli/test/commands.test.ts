import { test, expect } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { FakeREST, makeCtx } from './helpers/fake-rest'
import { run as send } from '../commands/send'
import { run as react } from '../commands/react'
import { run as edit } from '../commands/edit'
import { run as thread } from '../commands/thread'
import { run as fetchCmd } from '../commands/fetch'
import { run as del } from '../commands/delete'
import { run as whoami } from '../commands/whoami'
import { stateDirFor } from '../commands/setup'
import { run as status } from '../commands/status'
import { resolveMode, selectBots } from '../commands/launch'
import { run as stop } from '../commands/stop'
import { WT_NAME_PATTERN } from '../commands/ps'
import type { BotsJson } from '../lib/config'

test('send: single message, reply-to set', async () => {
  const f = new FakeREST().queue({ id: 'A' })
  const out = await send(makeCtx(f, { positionals: ['hi'], flags: { 'reply-to': 'R1' } }))
  expect(out).toBe('sent (id: A)')
  expect(f.calls[0].route).toBe('/channels/CHAN/messages')
  const body = (f.calls[0].options as { body: Record<string, unknown> }).body
  expect(body.message_reference).toEqual({ message_id: 'R1', fail_if_not_exists: false })
})

test('send: long text chunks; reply-to only on first chunk', async () => {
  const text = 'x'.repeat(4500)
  const f = new FakeREST().queue({ id: 'A' }, { id: 'B' }, { id: 'C' })
  const out = await send(makeCtx(f, { positionals: [text], flags: { 'reply-to': 'R1' } }))
  expect(out).toBe('sent 3 parts (ids: A, B, C)')
  expect(f.calls).toHaveLength(3)
  const bodies = f.calls.map(c => (c.options as { body: Record<string, unknown> }).body)
  expect(bodies[0].message_reference).toBeDefined()
  expect(bodies[1].message_reference).toBeUndefined()
})

test('send: joins all positionals — `send -- --literal text` is not truncated', async () => {
  const f = new FakeREST().queue({ id: 'A' })
  await send(makeCtx(f, { positionals: ['--literal', 'text'] }))
  const body = (f.calls[0].options as { body: { content: string } }).body
  expect(body.content).toBe('--literal text')
})

test('react: emoji is URI-encoded in route', async () => {
  const f = new FakeREST()
  await react(makeCtx(f, { positionals: ['M1', 'name:123'] }))
  expect(f.calls[0].method).toBe('PUT')
  expect(f.calls[0].route).toContain(encodeURIComponent('name:123'))
})

test('edit: patches the message', async () => {
  const f = new FakeREST().queue({ id: 'M1' })
  const out = await edit(makeCtx(f, { positionals: ['M1', 'new', 'text'] }))
  expect(out).toBe('edited (id: M1)')
  expect(f.calls[0].method).toBe('PATCH')
  expect((f.calls[0].options as { body: { content: string } }).body.content).toBe('new text')
})

test('edit: falls back to stdin when no text positional', async () => {
  const f = new FakeREST().queue({ id: 'M1' })
  await edit(makeCtx(f, { positionals: ['M1'], stdin: 'line1\nline2' }))
  expect((f.calls[0].options as { body: { content: string } }).body.content).toBe('line1\nline2')
})

test('edit: rejects >2000 chars with actionable error', async () => {
  const f = new FakeREST()
  await expect(edit(makeCtx(f, { positionals: ['M1', 'y'.repeat(2001)] })))
    .rejects.toThrow(/2000/)
  expect(f.calls).toHaveLength(0)
})

test('thread send: chunks long text', async () => {
  const f = new FakeREST().queue({ id: 'A' }, { id: 'B' })
  const out = await thread(makeCtx(f, { sub: 'send', positionals: ['T1', 'z'.repeat(2500)] }))
  expect(out).toBe('sent 2 parts to thread (ids: A, B)')
  expect(f.calls.every(c => c.route === '/channels/T1/messages')).toBe(true)
})

test('thread send: uses stdin when only thread id given', async () => {
  const f = new FakeREST().queue({ id: 'A' })
  const out = await thread(makeCtx(f, { sub: 'send', positionals: ['T1'], stdin: 'from stdin' }))
  expect(out).toBe('sent to thread (id: A)')
})

test('thread send: auto-unarchives on 50083 and retries once', async () => {
  const archived = Object.assign(new Error('Thread is archived'), { code: 50083 })
  // Queue order: PATCH unarchive consumes the first response, retry POST the second.
  const f = new FakeREST().failAt(0, archived).queue({ archived: false }, { id: 'A' })
  const out = await thread(makeCtx(f, { sub: 'send', positionals: ['T1', 'hello'] }))
  expect(out).toBe('sent to thread (id: A)')
  expect(f.calls.map(c => `${c.method} ${c.route}`)).toEqual([
    'POST /channels/T1/messages',
    'PATCH /channels/T1',
    'POST /channels/T1/messages',
  ])
  expect((f.calls[1].options as { body: { archived: boolean } }).body.archived).toBe(false)
})

const msg = (id: string, content: string) => ({
  id, content, author: { username: 'u', id: 'U' }, timestamp: 'T', attachments: [],
})

test('fetch: truncates long content by default, --full disables', async () => {
  const long = 'a'.repeat(500)
  const f = new FakeREST().queue([msg('1', long)])
  const out = await fetchCmd(makeCtx(f, {}))
  expect(out).toContain('use --full')
  expect(out).not.toContain('a'.repeat(400))

  const f2 = new FakeREST().queue([msg('1', long)])
  const out2 = await fetchCmd(makeCtx(f2, { flags: { full: true } }))
  expect(out2).toContain('a'.repeat(500))
})

test('fetch: --before paginates and full page hints older cursor', async () => {
  // API order is newest-first; the command reverses for display.
  const f = new FakeREST().queue([msg('6', 'new'), msg('5', 'old')])
  const out = await fetchCmd(makeCtx(f, { flags: { before: '7', limit: '2' } }))
  const q = (f.calls[0].options as { query: URLSearchParams }).query
  expect(q.get('before')).toBe('7')
  expect(out).toContain('--before 5') // oldest id offered as next cursor
})

test('delete: deletes by message id', async () => {
  const f = new FakeREST().queue(undefined)
  const out = await del(makeCtx(f, { positionals: ['M9'] }))
  expect(out).toBe('deleted')
  expect(f.calls[0]).toMatchObject({ method: 'DELETE', route: '/channels/CHAN/messages/M9' })
})

test('whoami: reports bot identity', async () => {
  const f = new FakeREST().queue({ id: 'B1', username: 'Beaver' })
  const out = await whoami(makeCtx(f, {}))
  expect(out).toBe('Beaver (id: B1)')
  expect(f.calls[0].route).toBe('/users/@me')
})

test('setup: stateDirFor is per-bot, lowercased, under ~/.claude/channels', () => {
  expect(stateDirFor('Beaver')).toBe(join(homedir(), '.claude', 'channels', 'discord-beaver'))
  expect(stateDirFor('OWL')).toBe(join(homedir(), '.claude', 'channels', 'discord-owl'))
  // Distinct bots never share a dir (no access.json/attachment collisions).
  expect(stateDirFor('Bee')).not.toBe(stateDirFor('Beaver'))
})

test('status: empty roster points at setup', async () => {
  const out = await status(makeCtx(new FakeREST(), { bots: {} }))
  expect(out).toBe('no bots.json found — run: pinchcord setup')
})

test('status: flags tokenless bots without hitting the API', async () => {
  const out = await status(makeCtx(new FakeREST(), { bots: { Ghost: {} } }))
  expect(out).toContain('Ghost: ✗ no token in bots.json')
  expect(out).toContain('fleet status')
})

test('launch: resolveMode defaults to wsl and rejects unknown modes', () => {
  expect(resolveMode({})).toBe('wsl')
  expect(resolveMode({ mode: 'mac' })).toBe('mac')
  expect(resolveMode({ mode: 'wt' })).toBe('wt')
  expect(() => resolveMode({ mode: 'tmux' })).toThrow(/wsl \| wt \| mac/)
})

test('launch: selectBots maps a named roster entry to a FleetBot', () => {
  const bots = {
    Beaver: { token: 'tok', channelId: 'C1', workDir: '/w', promptFile: '/p.md', effort: 'high' },
  } as BotsJson
  const picked = selectBots(makeCtx(new FakeREST(), { bots, positionals: ['Beaver'] }))
  expect(picked).toEqual([['Beaver', {
    name: 'Beaver', token: 'tok', channelId: 'C1',
    workDir: '/w', promptFile: '/p.md', effort: 'high', model: undefined, runtime: 'claude',
  }]])
})

test('launch: selectBots rejects unknown bots and incomplete entries', () => {
  const bots = { Ghost: { token: 'tok2' } } as BotsJson
  expect(() => selectBots(makeCtx(new FakeREST(), { bots, positionals: ['Nope'] })))
    .toThrow(/not in bots.json/)
  expect(() => selectBots(makeCtx(new FakeREST(), { bots, positionals: ['Ghost'] })))
    .toThrow(/needs workDir and promptFile/)
})

// stop's guard paths throw before any tmux/powershell process is spawned —
// safe to assert in unit tests.
test('stop: wt mode explains the manual path instead of touching tmux', async () => {
  await expect(stop(makeCtx(new FakeREST(), { flags: { mode: 'wt' } })))
    .rejects.toThrow(/pinchcord ps --mode wt/)
})

test('stop: requires a bot name or --all', async () => {
  await expect(stop(makeCtx(new FakeREST(), {})))
    .rejects.toThrow(/stop <bot> \| stop --all/)
})
