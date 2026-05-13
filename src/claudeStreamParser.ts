export type StreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; output: string; isError: boolean }
  | { kind: 'system'; model?: string; sessionId?: string }
  | { kind: 'stats'; totalCostUsd?: number; inputTokens?: number; outputTokens?: number }
  | { kind: 'result-text'; text: string }

/**
 * Parses one `stream-json` line emitted by the Claude CLI.
 * Returns an array of typed events (may be empty for unrecognised event types).
 * Non-JSON lines (progress dots, warnings) are returned as `{ kind: 'text' }` events.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  let evt: any
  try {
    evt = JSON.parse(line)
  } catch {
    return [{ kind: 'text', text: line + '\n' }]
  }
  if (!evt || typeof evt !== 'object') return []

  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init') {
        return [{ kind: 'system', model: evt.model ?? undefined, sessionId: evt.session_id ?? undefined }]
      }
      return []

    case 'assistant':
      return parseAssistantMessage(evt.message)

    case 'user':
      return parseUserToolResult(evt.message)

    case 'result': {
      const events: StreamEvent[] = []
      if (typeof evt.result === 'string') {
        events.push({ kind: 'result-text', text: evt.result })
      }
      events.push({
        kind: 'stats',
        totalCostUsd: evt.total_cost_usd,
        inputTokens: evt.usage?.input_tokens,
        outputTokens: evt.usage?.output_tokens,
      })
      return events
    }

    default:
      return []
  }
}

function parseAssistantMessage(message: unknown): StreamEvent[] {
  const content = (message as any)?.content
  if (!Array.isArray(content)) return []
  const events: StreamEvent[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ kind: 'text', text: block.text })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      events.push({ kind: 'thinking', text: block.thinking })
    } else if (block.type === 'tool_use') {
      events.push({ kind: 'tool-start', id: block.id, name: block.name, input: block.input })
    }
  }
  return events
}

function parseUserToolResult(message: unknown): StreamEvent[] {
  const content = (message as any)?.content
  if (!Array.isArray(content)) return []
  const events: StreamEvent[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue
    const output = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((c: any) => c?.text ?? '').join('')
        : ''
    events.push({ kind: 'tool-result', id: block.tool_use_id, output, isError: !!block.is_error })
  }
  return events
}
