import { test, expect } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { run as download } from '../commands/download'
import type { Ctx } from '../lib/ctx'

const fakeCtx = (url: string) =>
  ({
    positionals: ['1'],
    flags: { out: join(tmpdir(), 'pinchcord-test-inbox') },
    channelId: 'C',
    rest: { get: async () => ({ attachments: [{ id: 'a', filename: 'x.png', url, size: 10 }] }) },
  }) as unknown as Ctx

test('download rejects non-Discord-CDN attachment URLs (SSRF guard)', async () => {
  await expect(download(fakeCtx('https://evil.example/x.png'))).rejects.toThrow(/unexpected origin/)
  await expect(download(fakeCtx('http://cdn.discordapp.com/x.png'))).rejects.toThrow(/unexpected origin/) // https only
  await expect(download(fakeCtx('https://cdn.discordapp.com.evil.example/x.png'))).rejects.toThrow(/unexpected origin/)
})
