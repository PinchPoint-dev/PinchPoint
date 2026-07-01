import { expect, test } from 'bun:test'
import { chunk } from '../lib/chunk'

test('short text is a single chunk', () => {
  expect(chunk('hello', 2000, 'length')).toEqual(['hello'])
})

test('long text splits at limit', () => {
  const text = 'a'.repeat(2500)
  const parts = chunk(text, 2000, 'length')
  expect(parts.length).toBe(2)
  expect(parts[0].length).toBe(2000)
  expect(parts[1].length).toBe(500)
})

test('newline mode prefers paragraph boundaries', () => {
  const text = 'x'.repeat(1500) + '\n\n' + 'y'.repeat(1000)
  const parts = chunk(text, 2000, 'newline')
  expect(parts[0].endsWith('x')).toBe(true)
  expect(parts[1].startsWith('y')).toBe(true)
})
