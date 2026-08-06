import type { ServerResponse } from 'http'

/**
 * Write a JSON response with the given status code.
 *
 * Consolidates the repeated
 * `res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data))`
 * pattern used by the local HTTP servers (auth callback server, browser local server).
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}
