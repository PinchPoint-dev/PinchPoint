import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { codexSessionsFor, isFleetSession } from '../commands/stop'

// A codex bot is three sessions; stop must target all of them — killing only
// the adapter left the app-server and viewer running headless forever.
test('stopping a codex bot targets its app-server and viewer sessions too', () => {
  expect(codexSessionsFor('Genna')).toEqual(['Codex-Genna-Server', 'Codex-View-Genna'])
})

test('isFleetSession recognizes every fleet session shape and nothing else', () => {
  expect(isFleetSession('Pinchcord-Eel')).toBe(true)
  expect(isFleetSession('Pinchcord')).toBe(true) // legacy combined session
  expect(isFleetSession('Codex-Genna-Server')).toBe(true)
  expect(isFleetSession('Codex-View-Genna')).toBe(true)
  expect(isFleetSession('main')).toBe(false)
  expect(isFleetSession('Posters')).toBe(false)
})

// The supervisor must not orphan its codex child when tmux kills the session —
// observed: app-server node processes outliving Codex-<Bot>-Server and holding
// the port, which then blocked the next launch.
const appServer = readFileSync(join(import.meta.dir, '..', 'codex', 'app-server.sh'), 'utf8')

test('app-server.sh traps teardown and kills its child plus the port', () => {
  expect(appServer).toContain('trap cleanup HUP INT TERM')
  expect(appServer).toContain('kill "$CHILD"')
  expect(appServer).toContain('wait "$CHILD"')
  expect(appServer).toMatch(/fuser -k "\$\{PORT\}\/tcp"/)
})
