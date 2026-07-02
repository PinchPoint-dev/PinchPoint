import { test, expect } from 'bun:test'
import { groupDelivers, fallbackAccess } from '../lib/gateway-access'

const HOME = '1507628373218955265'
const MAIN = '1522097467250704425'
const SENDER = '999'

// Home channel: requireMention false → every message delivered (ambient too).
test('home channel (requireMention false) delivers un-mentioned messages', () => {
  const access = { groups: { [HOME]: { requireMention: false, allowFrom: [] } } }
  expect(groupDelivers(access, { channelId: HOME, senderId: SENDER, mentioned: false })).toBe(true)
  expect(groupDelivers(access, { channelId: HOME, senderId: SENDER, mentioned: true })).toBe(true)
})

// #main: mention-gated → only mentioned messages delivered.
test('#main (requireMention true) drops un-mentioned, delivers mentioned', () => {
  const access = { groups: { [MAIN]: { requireMention: true, allowFrom: [] } } }
  expect(groupDelivers(access, { channelId: MAIN, senderId: SENDER, mentioned: false })).toBe(false)
  expect(groupDelivers(access, { channelId: MAIN, senderId: SENDER, mentioned: true })).toBe(true)
})

test('requireMention defaults to true when unspecified (matches the gateway)', () => {
  const access = { groups: { [MAIN]: {} } }
  expect(groupDelivers(access, { channelId: MAIN, senderId: SENDER, mentioned: false })).toBe(false)
  expect(groupDelivers(access, { channelId: MAIN, senderId: SENDER, mentioned: true })).toBe(true)
})

test('a channel absent from groups is never delivered', () => {
  const access = { groups: { [HOME]: { requireMention: false } } }
  expect(groupDelivers(access, { channelId: '404', senderId: SENDER, mentioned: true })).toBe(false)
  expect(groupDelivers({}, { channelId: HOME, senderId: SENDER, mentioned: true })).toBe(false)
})

test('non-empty allowFrom restricts senders', () => {
  const access = { groups: { [HOME]: { requireMention: false, allowFrom: ['111'] } } }
  expect(groupDelivers(access, { channelId: HOME, senderId: '111', mentioned: false })).toBe(true)
  expect(groupDelivers(access, { channelId: HOME, senderId: '222', mentioned: false })).toBe(false)
})

test('fallbackAccess delivers everything in the single hub, no mention gate', () => {
  const access = fallbackAccess(HOME)
  expect(groupDelivers(access, { channelId: HOME, senderId: SENDER, mentioned: false })).toBe(true)
  expect(groupDelivers(access, { channelId: MAIN, senderId: SENDER, mentioned: true })).toBe(false)
})
