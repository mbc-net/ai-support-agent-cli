/**
 * NDJSON line builders for Claude Code CLI output simulation.
 * Used by tests that mock the Claude Code subprocess stdout.
 *
 * Used by: chat-executor.spec.ts
 */

/** Build an NDJSON line for a "result" event (process exit with success) */
export function ndjsonResult(text: string, options?: { usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; total_cost_usd?: number }): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: text,
    ...(options?.usage ? { usage: options.usage } : {}),
    ...(options?.total_cost_usd !== undefined ? { total_cost_usd: options.total_cost_usd } : {}),
  }) + '\n'
}

/** Build an NDJSON line for an "assistant" event (model response with optional tool uses) */
export function ndjsonAssistant(
  text: string,
  toolUses?: Array<{ name: string; id: string; input: Record<string, unknown> }>,
): string {
  const content: Array<Record<string, unknown>> = []
  if (toolUses) {
    for (const tu of toolUses) {
      content.push({ type: 'tool_use', name: tu.name, id: tu.id, input: tu.input })
    }
  }
  content.push({ type: 'text', text })
  return JSON.stringify({ type: 'assistant', message: { content } }) + '\n'
}
