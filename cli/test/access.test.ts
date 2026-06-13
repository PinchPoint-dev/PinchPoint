import { test, expect } from 'bun:test'
import { defaultAccess, ensureHubPolicy } from '../lib/access'

const HUB = '123456789012345678'

test('defaultAccess delivers un-mentioned hub messages', () => {
  const a = defaultAccess(HUB)
  expect(a.groups?.[HUB]?.requireMention).toBe(false)
  expect(a.groups?.[HUB]?.allowFrom).toEqual([])
  expect(a.dmPolicy).toBe('allowlist')
})

test('ensureHubPolicy adds the hub group when missing', () => {
  const { access, changed } = ensureHubPolicy({ dmPolicy: 'allowlist', allowFrom: [], pending: {} }, HUB)
  expect(changed).toBe(true)
  expect(access.groups?.[HUB]?.requireMention).toBe(false)
})

test('ensureHubPolicy migrates the old mention-gated default', () => {
  const old = { dmPolicy: 'allowlist', allowFrom: [], pending: {}, groups: { [HUB]: { requireMention: true, allowFrom: [] } } }
  const { access, changed } = ensureHubPolicy(old, HUB)
  expect(changed).toBe(true)
  expect(access.groups?.[HUB]?.requireMention).toBe(false)
})

test('ensureHubPolicy preserves human customization', () => {
  // requireMention true + a non-empty allowFrom is a deliberate choice, not our old default
  const custom = { groups: { [HUB]: { requireMention: true, allowFrom: ['123'] } } }
  const { access, changed } = ensureHubPolicy(custom, HUB)
  expect(changed).toBe(false)
  expect(access.groups?.[HUB]?.requireMention).toBe(true)

  // already-correct policy untouched
  const fine = { groups: { [HUB]: { requireMention: false, allowFrom: ['123'] } } }
  expect(ensureHubPolicy(fine, HUB).changed).toBe(false)
})

test('ensureHubPolicy keeps unrelated fields and groups intact', () => {
  const input = {
    mentionPatterns: ['\\bowl\\b'],
    groups: { other: { requireMention: true, allowFrom: [] }, [HUB]: { requireMention: true, allowFrom: [] } },
  }
  const { access } = ensureHubPolicy(input, HUB)
  expect(access.mentionPatterns).toEqual(['\\bowl\\b'])
  expect(access.groups?.other?.requireMention).toBe(true) // only the hub group is migrated
})
