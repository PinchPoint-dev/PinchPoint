import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { viewSessionFor } from '../commands/view'

// The viewer loop is a committed script (not an inline shell string, which the
// tmux -> sh -c -> bash chain blanked out). It reads the adapter's threads.json
// and attaches a codex TUI to the current home-channel thread, re-attaching on
// reset.
const loop = readFileSync(join(import.meta.dir, '..', 'codex', 'view-loop.sh'), 'utf8')

test('view-loop.sh reads the threads file passed as $1 and pulls url/channel/thread', () => {
  expect(loop).toContain('F="${1:-}"')
  expect(loop).toContain('.appServerUrl')
  expect(loop).toContain('.homeChannelId')
  expect(loop).toContain('.threads[$c]')
})

test('view-loop.sh attaches the codex TUI off the API key, with optional auth token', () => {
  expect(loop).toContain('env -u OPENAI_API_KEY codex resume "$TID" --remote "$URL"')
  // security: only pass --remote-auth-token-env when the file names one
  expect(loop).toContain('--remote-auth-token-env "$AENV"')
})

test('view-loop.sh re-attaches in a loop that survives thread reset / restart', () => {
  expect(loop).toContain('while true; do')
  expect(loop).toContain('re-checking')
})

test('viewSessionFor is a distinct namespace from the bot/adapter sessions', () => {
  expect(viewSessionFor('Genna')).toBe('Codex-View-Genna')
})
