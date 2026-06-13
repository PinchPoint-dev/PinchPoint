const SUBCOMMAND_PARENTS = new Set(['thread'])

export interface ParsedArgs {
  command: string
  sub?: string
  positionals: string[]
  flags: Record<string, string | string[] | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? ''
  let i = 1
  let sub: string | undefined
  if (SUBCOMMAND_PARENTS.has(command) && argv[1] && !argv[1].startsWith('--')) {
    sub = argv[1]
    i = 2
  }
  const positionals: string[] = []
  const flags: Record<string, string | string[] | boolean> = {}
  for (; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      let key: string
      let val: string | boolean
      if (eq !== -1) {
        key = tok.slice(2, eq)
        val = tok.slice(eq + 1)
      } else {
        key = tok.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) { val = next; i++ }
        else val = true
      }
      const existing = flags[key]
      if (existing === undefined) flags[key] = val
      else if (Array.isArray(existing)) existing.push(val as string)
      else flags[key] = [existing as string, val as string]
    } else {
      positionals.push(tok)
    }
  }
  return { command, sub, positionals, flags }
}
