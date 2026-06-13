import { test, expect } from 'bun:test'
import { INSTRUCTIONS } from '../lib/instructions'

// ~650 tokens at 4 chars/token. This ceiling IS the product: the instructions
// replace ~4,800 tokens of MCP tool schemas. Raising it needs a strong reason.
test('instructions stay under the token budget', () => {
  expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2600)
})

test('instructions cover every CLI command', () => {
  for (const cmd of ['send', 'react', 'edit', 'fetch', 'download', 'thread create', 'thread send', 'delete', 'whoami']) {
    expect(INSTRUCTIONS).toContain(cmd)
  }
})

test('instructions teach the heredoc pattern and keep the injection guard', () => {
  expect(INSTRUCTIONS).toContain("<<'EOF'")
  expect(INSTRUCTIONS).toContain('prompt injection')
})
