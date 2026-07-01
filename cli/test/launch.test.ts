import { test, expect } from 'bun:test'
import { selectBots } from '../commands/launch'
import type { Ctx } from '../lib/ctx'

const base = { token: 'T', channelId: 'C', workDir: '/mnt/c/repo', promptFile: '/mnt/c/p.md' }
const ctx = (bots: Record<string, unknown>, names: string[] = []) =>
  ({ positionals: names, flags: {}, bots }) as unknown as Ctx

// bots.json fields end up single-quote-interpolated into bash -lc and
// PowerShell lines — quotes in them break launch (or worse, inject).
test('selectBots rejects bot names unsafe for shell/tmux interpolation', () => {
  expect(() => selectBots(ctx({ "O'Brien": base }))).toThrow(/must match/)
  expect(() => selectBots(ctx({ 'Bee; rm -rf /': base }))).toThrow(/must match/)
  expect(() => selectBots(ctx({ 'Bee Bot': base }))).toThrow(/must match/)
})

test('selectBots rejects quotes in workDir and promptFile', () => {
  expect(() => selectBots(ctx({ Bee: { ...base, workDir: "/mnt/c/O'Brien/repo" } }))).toThrow(/quote/)
  expect(() => selectBots(ctx({ Bee: { ...base, promptFile: '/mnt/c/say-"hi".md' } }))).toThrow(/quote/)
})

test('selectBots rejects unsafe effort/model (interpolated unquoted)', () => {
  expect(() => selectBots(ctx({ Bee: { ...base, effort: "high' x" } }))).toThrow(/effort/)
  expect(() => selectBots(ctx({ Bee: { ...base, model: 'opus$(reboot)' } }))).toThrow(/model/)
})

test('selectBots passes clean entries through unchanged', () => {
  const [[name, bot]] = selectBots(ctx({ 'Bee-2': { ...base, effort: 'high', model: 'claude-opus-4-8' } }))
  expect(name).toBe('Bee-2')
  expect(bot.workDir).toBe('/mnt/c/repo')
  expect(bot.effort).toBe('high')
})
