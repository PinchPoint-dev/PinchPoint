import { expect, test } from 'bun:test'
import { parseArgs } from '../lib/args'

test('parses command and positionals', () => {
  const r = parseArgs(['send', 'hello world'])
  expect(r.command).toBe('send')
  expect(r.positionals).toEqual(['hello world'])
  expect(r.flags).toEqual({})
})

test('parses --flag value and --flag=value', () => {
  const r = parseArgs(['send', 'hi', '--channel', '123', '--reply-to=456'])
  expect(r.flags.channel).toBe('123')
  expect(r.flags['reply-to']).toBe('456')
  expect(r.positionals).toEqual(['hi'])
})

test('parses subcommand for thread', () => {
  const r = parseArgs(['thread', 'create', '789', 'My Thread'])
  expect(r.command).toBe('thread')
  expect(r.sub).toBe('create')
  expect(r.positionals).toEqual(['789', 'My Thread'])
})

test('repeated --file flags collect into array', () => {
  const r = parseArgs(['send', 'hi', '--file', 'a.png', '--file', 'b.png'])
  expect(r.flags.file).toEqual(['a.png', 'b.png'])
})

test('boolean flag with no value', () => {
  const r = parseArgs(['fetch', '--json'])
  expect(r.flags.json).toBe(true)
})

test('-- stops flag parsing', () => {
  const r = parseArgs(['send', '--', '--not-a-flag', '--reply-to'])
  expect(r.positionals).toEqual(['--not-a-flag', '--reply-to'])
  expect(r.flags).toEqual({})
})

test('flags before -- still parse', () => {
  const r = parseArgs(['send', '--channel', '123', '--', '--literal text'])
  expect(r.flags.channel).toBe('123')
  expect(r.positionals).toEqual(['--literal text'])
})
