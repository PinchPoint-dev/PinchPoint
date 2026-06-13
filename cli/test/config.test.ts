import { expect, test } from 'bun:test'
import { resolveToken, resolveChannel, botNameFromEnv } from '../lib/config'

const bots = {
  Bee: { token: 'bee-token', channelId: 'bee-chan' },
  Owl: { token: 'owl-token', channelId: 'owl-chan' },
}

test('token: flag wins over env and bots.json', () => {
  expect(resolveToken({ flags: { token: 'flag-tok' }, env: { DISCORD_BOT_TOKEN: 'env-tok' }, bots, bot: 'Bee' })).toBe('flag-tok')
})

test('token: env beats bots.json', () => {
  expect(resolveToken({ flags: {}, env: { DISCORD_BOT_TOKEN: 'env-tok' }, bots, bot: 'Bee' })).toBe('env-tok')
})

test('token: falls back to bots.json by bot name', () => {
  expect(resolveToken({ flags: {}, env: {}, bots, bot: 'Owl' })).toBe('owl-token')
})

test('token: throws when nothing resolves', () => {
  expect(() => resolveToken({ flags: {}, env: {}, bots: {}, bot: undefined })).toThrow(/token/i)
})

test('channel: flag wins, then env, then bots.json', () => {
  expect(resolveChannel({ flags: { channel: 'flag-c' }, env: { PINCHHUB_CHANNEL_ID: 'env-c' }, bots, bot: 'Bee' })).toBe('flag-c')
  expect(resolveChannel({ flags: {}, env: { PINCHHUB_CHANNEL_ID: 'env-c' }, bots, bot: 'Bee' })).toBe('env-c')
  expect(resolveChannel({ flags: {}, env: {}, bots, bot: 'Bee' })).toBe('bee-chan')
})

test('botNameFromEnv strips -discord suffix', () => {
  expect(botNameFromEnv({ CLAUDE_SESSION_NAME: 'Bee-discord' })).toBe('Bee')
  expect(botNameFromEnv({ CLAUDE_SESSION_NAME: 'Owl' })).toBe('Owl')
  expect(botNameFromEnv({})).toBeUndefined()
})

import { loadBotsFrom } from '../lib/config'

test('loadBotsFrom skips missing files and parses the first hit', () => {
  const files: Record<string, string> = { '/b.json': '{"Bee":{"token":"t"}}' }
  const read = (p: string) => {
    if (!(p in files)) throw new Error('ENOENT')
    return files[p]
  }
  expect(loadBotsFrom(['/a.json', '/b.json'], read)).toEqual({ Bee: { token: 't' } })
})

test('loadBotsFrom warns on corrupt JSON and continues', () => {
  const warnings: string[] = []
  const read = (p: string) => (p === '/bad.json' ? '{oops' : '{"Bee":{}}')
  const r = loadBotsFrom(['/bad.json', '/ok.json'], read, m => warnings.push(m))
  expect(r).toEqual({ Bee: {} })
  expect(warnings[0]).toContain('/bad.json')
  expect(warnings[0]).toContain('invalid JSON')
})
