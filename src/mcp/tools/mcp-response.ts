export function mcpTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function mcpErrorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const }
}

export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
