import { readFileSync } from 'fs'

export function parseCodexJsonLines(stdout) {
  if (!stdout || !stdout.trim()) return []

  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

export function extractCodexResult(lines, lastMessagePath) {
  const threadEvent = [...lines].reverse().find(line => line.type === 'thread.started')
  const resultEvent = [...lines].reverse().find(line => line.type === 'result')

  let text = ''

  if (lastMessagePath) {
    try {
      text = readFileSync(lastMessagePath, 'utf-8').trim()
    } catch {
      text = ''
    }
  }

  if (!text) {
    const agentMessages = lines
      .filter(line => line.type === 'item.completed' && line.item?.type === 'agent_message')
      .map(line => line.item.text)
      .filter(Boolean)
    text = agentMessages[agentMessages.length - 1] || ''
  }

  return {
    text: text || '(no response)',
    threadId: threadEvent?.thread_id || null,
    result: resultEvent || null,
  }
}
