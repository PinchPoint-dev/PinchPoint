import { test, expect } from 'bun:test'
import { describeError } from '../lib/errors'

test('known Discord code gets a hint', () => {
  const err = Object.assign(new Error('Invalid Form Body'), { code: 50035 })
  expect(describeError(err)).toContain('2000-char cap')
})

test('string codes are handled', () => {
  const err = Object.assign(new Error('Thread is archived'), { code: '50083' })
  expect(describeError(err)).toContain('archived')
})

test('unknown errors pass through', () => {
  expect(describeError(new Error('boom'))).toBe('boom')
  expect(describeError('weird')).toBe('weird')
})
