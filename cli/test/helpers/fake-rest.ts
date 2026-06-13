import type { REST } from 'discord.js'
import type { Ctx } from '../../lib/ctx'

export interface Call { method: string; route: string; options?: Record<string, unknown> }

export class FakeREST {
  calls: Call[] = []
  private responses: unknown[] = []
  private failures = new Map<number, unknown>() // nth call (0-based) → error to throw

  queue(...responses: unknown[]): this { this.responses.push(...responses); return this }
  failAt(index: number, error: unknown): this { this.failures.set(index, error); return this }

  private handle(method: string, route: string, options?: Record<string, unknown>): Promise<unknown> {
    const index = this.calls.length
    this.calls.push({ method, route, options })
    const failure = this.failures.get(index)
    if (failure !== undefined) return Promise.reject(failure)
    return Promise.resolve(this.responses.shift() ?? { id: `msg-${index}` })
  }

  get(route: string, options?: Record<string, unknown>) { return this.handle('GET', route, options) }
  post(route: string, options?: Record<string, unknown>) { return this.handle('POST', route, options) }
  patch(route: string, options?: Record<string, unknown>) { return this.handle('PATCH', route, options) }
  put(route: string, options?: Record<string, unknown>) { return this.handle('PUT', route, options) }
  delete(route: string, options?: Record<string, unknown>) { return this.handle('DELETE', route, options) }

  asREST(): REST { return this as unknown as REST }
}

export function makeCtx(fake: FakeREST, over: Partial<Ctx> = {}): Ctx {
  return {
    rest: fake.asREST(),
    channelId: 'CHAN',
    positionals: [],
    flags: {},
    stdin: '',
    bots: {},
    ...over,
  }
}
