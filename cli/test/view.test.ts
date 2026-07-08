import { test, expect } from 'bun:test'
import { buildViewerShell, viewSessionFor } from '../commands/view'

// The viewer shell reads the adapter's threads.json each iteration and attaches
// a codex TUI to the current home-channel thread, re-attaching on reset.
test('buildViewerShell reads the threads file and attaches with codex resume --remote', () => {
  const s = buildViewerShell('Genna', '/home/x/.claude/channels/discord-genna/threads.json')
  expect(s).toContain("F='/home/x/.claude/channels/discord-genna/threads.json'")
  // pulls url, home channel, and the per-channel thread out of the file
  expect(s).toContain('.appServerUrl')
  expect(s).toContain('.homeChannelId')
  expect(s).toContain('.threads[$c]')
  // attaches the literal codex TUI over the remote app-server, off the API key
  expect(s).toContain('env -u OPENAI_API_KEY codex resume "$TID" --remote "$URL"')
})

test('buildViewerShell wires the optional remote auth token and re-attach loop', () => {
  const s = buildViewerShell('Genna', '/tmp/threads.json')
  // security: only pass --remote-auth-token-env when the file names one
  expect(s).toContain('--remote-auth-token-env "$AENV"')
  // re-attach loop survives thread reset / app-server restart
  expect(s).toContain('while true; do')
  expect(s).toContain('re-checking')
})

test('viewSessionFor is a distinct namespace from the bot/adapter sessions', () => {
  expect(viewSessionFor('Genna')).toBe('Codex-View-Genna')
})
