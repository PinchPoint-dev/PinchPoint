import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isNewerSnowflake, loadLastSeen, saveLastSeen } from '../modules/comms'

test('isNewerSnowflake orders Discord ids numerically', () => {
  expect(isNewerSnowflake('1515146067316965428', '1515142190894944457')).toBe(true)
  expect(isNewerSnowflake('1515142190894944457', '1515146067316965428')).toBe(false)
  expect(isNewerSnowflake('5', '5')).toBe(false)
  expect(isNewerSnowflake('5', null)).toBe(true)          // no watermark → everything is new
  expect(isNewerSnowflake('not-a-snowflake', '5')).toBe(true) // unparseable → fail open
})

test('loadLastSeen / saveLastSeen round-trip via the state dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-watermark-'))
  try {
    expect(loadLastSeen(dir)).toBeNull() // missing file
    saveLastSeen(dir, '1515146067316965428')
    expect(loadLastSeen(dir)).toBe('1515146067316965428')
    saveLastSeen(dir, '1515146067316965429')
    expect(loadLastSeen(dir)).toBe('1515146067316965429')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
