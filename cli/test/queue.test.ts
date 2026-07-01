import { test, expect } from 'bun:test'
import { enqueueIfNeeded, finishCatchUp } from '../modules/comms'
import type { Message } from 'discord.js'

const msg = (id: string) => ({ id }) as unknown as Message

// One scenario, because queue state is module-level and finishCatchUp is
// one-way (catchUpComplete latches). Covers both regressions at once:
//  - >100 messages queued without loss (old cap silently dropped overflow)
//  - messages arriving during drain past the 5-iteration cap are handed off,
//    not stranded in the queue forever
test('queue never drops above the old 100 cap and drain leaves nothing stranded', async () => {
  for (let i = 0; i < 150; i++) {
    expect(enqueueIfNeeded(msg(`m${i}`))).toBe(true)
  }
  expect(enqueueIfNeeded(msg('chain-0'))).toBe(true)

  const handled: string[] = []
  let chain = 0
  await finishCatchUp(async m => {
    handled.push((m as { id: string }).id)
    // Each chain message enqueues the next during its own drain pass, forcing
    // one extra while-iteration per link — 5 links exhaust the iteration cap
    // and leave the last link for the leftover hand-off.
    if ((m as { id: string }).id === `chain-${chain}` && chain < 5) {
      chain++
      enqueueIfNeeded(msg(`chain-${chain}`))
    }
  })

  expect(handled.length).toBe(156) // 150 + chain-0..chain-5
  expect(handled).toContain('m149') // would be dropped by the old cap
  expect(handled).toContain('chain-5') // would be stranded by the old drain cap

  // Catch-up over: realtime messages now bypass the queue entirely.
  expect(enqueueIfNeeded(msg('post'))).toBe(false)
})
