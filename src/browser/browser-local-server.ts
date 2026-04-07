/**
 * BrowserLocalServer — local HTTP server for inter-process browser control.
 *
 * Agent main process runs this server so that MCP child processes can
 * control browser sessions via HTTP instead of sharing in-memory objects.
 * Binds to 127.0.0.1 only (no external access).
 */

import http from 'http'

import { logger } from '../logger'
import { BrowserSessionManager } from '../mcp/tools/browser/browser-session-manager'
import { validateUrl } from '../mcp/tools/browser/browser-security'
import { tryClickSelectors, tryFillSelectors } from '../mcp/tools/browser/selector-utils'
import { executePlaywrightScript } from './browser-script-executor'

/** Action log entry emitted to the caller */
export interface ActionLogNotification {
  sessionId: string
  entry: { timestamp: number; source: 'direct' | 'chat'; action: string; details: string }
}

export class BrowserLocalServer {
  private server: http.Server | null = null
  private port = 0
  onActionLog: ((notification: ActionLogNotification) => void) | null = null

  constructor(private readonly sessionManager: BrowserSessionManager) {}

  /**
   * Start the HTTP server on a random available port.
   * @returns the port number
   */
  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })

      server.on('error', (err) => {
        logger.error(`[browser-local-server] Server error: ${String(err)}`)
        reject(err)
      })

      // Bind to 127.0.0.1 only, port 0 = random available port
      server.unref()
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.server = server
          logger.info(`[browser-local-server] Listening on 127.0.0.1:${this.port}`)
          resolve(this.port)
        } else {
          reject(new Error('Failed to get server address'))
        }
      })
    })
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        logger.info('[browser-local-server] Stopped')
        this.server = null
        resolve()
      })
    })
  }

  /**
   * Get the port the server is listening on.
   */
  getPort(): number {
    return this.port
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await readBody(req)
      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)
      const segments = url.pathname.split('/').filter(Boolean)

      // Route: /sessions/first — returns the first active session ID
      if (segments.length === 2 && segments[0] === 'sessions' && segments[1] === 'first') {
        const sessions = this.sessionManager.listSessions()
        if (sessions.length === 0) {
          sendJson(res, 404, { error: 'No active sessions' })
        } else {
          sendJson(res, 200, { sessionId: sessions[0].sessionId })
        }
        return
      }

      // Route: /browser/:sessionId/:action
      if (segments.length < 3 || segments[0] !== 'browser') {
        sendJson(res, 404, { error: 'Not found' })
        return
      }

      const sessionId = segments[1]
      const action = segments[2]

      const session = this.sessionManager.get(sessionId)
      if (!session) {
        sendJson(res, 404, { error: `Session not found: ${sessionId}` })
        return
      }

      const params = body ? JSON.parse(body) : {}

      switch (action) {
        case 'navigate':
          await this.handleNavigate(res, sessionId, session, params)
          break
        case 'click':
          await this.handleClick(res, sessionId, session, params)
          break
        case 'fill':
          await this.handleFill(res, sessionId, session, params)
          break
        case 'get-text':
          await this.handleGetText(res, sessionId, session, params)
          break
        case 'extract':
          await this.handleExtract(res, sessionId, session, params)
          break
        case 'screenshot':
          await this.handleScreenshot(res, session, params)
          break
        case 'url':
          this.handleGetUrl(res, session)
          break
        case 'title':
          await this.handleGetTitle(res, session)
          break
        case 'variable': {
          if (req.method === 'GET') {
            const varName = segments[3]
            if (varName) {
              this.handleGetVariable(res, sessionId, session, varName)
            } else {
              sendJson(res, 400, { error: 'Missing variable name' })
            }
          } else {
            await this.handleSetVariable(res, sessionId, session, params)
          }
          break
        }
        case 'variables':
          this.handleListVariables(res, session)
          break
        case 'execute-script':
          await this.handleExecuteScript(res, sessionId, session, params)
          break
        default:
          sendJson(res, 404, { error: `Unknown action: ${action}` })
      }
    } catch (error) {
      logger.error(`[browser-local-server] Request error: ${String(error)}`)
      sendJson(res, 500, { error: String(error) })
    }
  }

  /**
   * Record an action log entry and notify via callback.
   * BrowserActionLog.onChange may also fire for direct operations, but
   * for chat operations via BrowserLocalServer we use onActionLog to
   * ensure delivery even before the Web browser panel is connected.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emitActionLog(sessionId: string, session: any, action: string, details: string): void {
    const entry = { timestamp: Date.now(), source: 'chat' as const, action, details }
    // Add to log without triggering onChange (to avoid double notification)
    session.actionLog.addEntry(entry)
    if (this.onActionLog) {
      this.onActionLog({ sessionId, entry })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleNavigate(res: http.ServerResponse, sessionId: string, session: any, params: Record<string, unknown>): Promise<void> {
    const url = params.url as string
    if (!url) {
      sendJson(res, 400, { error: 'Missing url' })
      return
    }

    const validation = validateUrl(url)
    if (!validation.valid) {
      sendJson(res, 400, { error: validation.reason ?? 'Invalid URL' })
      return
    }

    const page = await session.getPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    if (params.waitForSelector) {
      await page.waitForSelector(params.waitForSelector as string, { timeout: 10000 })
    }
    if (params.waitForTimeout) {
      const clampedTimeout = Math.min(params.waitForTimeout as number, 10000)
      await page.waitForTimeout(clampedTimeout)
    }

    const title: string = await page.title()
    const currentUrl: string = page.url()
    const screenshotBuffer = await session.screenshot(params.fullPage ?? true)
    const base64 = screenshotBuffer.toString('base64')

    this.emitActionLog(sessionId, session, 'navigate', url)

    sendJson(res, 200, { title, url: currentUrl, screenshot: base64 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleClick(res: http.ServerResponse, sessionId: string, session: any, params: Record<string, unknown>): Promise<void> {
    const selector = params.selector as string
    if (!selector) {
      sendJson(res, 400, { error: 'Missing selector' })
      return
    }

    const page = await session.getPage()

    const matchedSelector = await tryClickSelectors(page, selector, { waitForNavigation: !!params.waitForNavigation })

    const title: string = await page.title()
    const currentUrl: string = page.url()

    this.emitActionLog(sessionId, session, 'click', matchedSelector)

    if (params.screenshot !== false) {
      const screenshotBuffer = await session.screenshot(true)
      const base64 = screenshotBuffer.toString('base64')
      sendJson(res, 200, { title, url: currentUrl, screenshot: base64 })
    } else {
      sendJson(res, 200, { title, url: currentUrl })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleFill(res: http.ServerResponse, sessionId: string, session: any, params: Record<string, unknown>): Promise<void> {
    const selector = params.selector as string
    const value = params.value as string
    if (!selector || value === undefined) {
      sendJson(res, 400, { error: 'Missing selector or value' })
      return
    }

    const page = await session.getPage()
    const matchedSelector = await tryFillSelectors(page, selector, value)

    this.emitActionLog(sessionId, session, 'fill', `${matchedSelector} "${value}"`)

    if (params.screenshot) {
      const screenshotBuffer = await session.screenshot(true)
      const base64 = screenshotBuffer.toString('base64')
      sendJson(res, 200, { screenshot: base64 })
    } else {
      sendJson(res, 200, { ok: true })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleGetText(res: http.ServerResponse, sessionId: string, session: any, params: Record<string, unknown>): Promise<void> {
    const page = await session.getPage()
    const target = (params.selector as string) ?? 'body'
    const text: string = await page.locator(target).innerText({ timeout: 10000 })
    const maxLength = 50 * 1024
    const truncated = text.length > maxLength ? text.substring(0, maxLength) + '\n... (truncated)' : text
    const preview = text.replace(/\s+/g, ' ').trim()
    const previewText = preview.length > 100 ? preview.substring(0, 100) + '…' : preview
    this.emitActionLog(sessionId, session, 'get_text', `${target} → "${previewText}"`)
    sendJson(res, 200, { text: truncated })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleExtract(res: http.ServerResponse, sessionId: string, session: any, params: Record<string, unknown>): Promise<void> {
    const selector = params.selector as string
    const variableName = params.variableName as string
    if (!selector || !variableName) {
      sendJson(res, 400, { error: 'Missing selector or variableName' })
      return
    }

    const page = await session.getPage()
    const text: string = await page.locator(selector).innerText({ timeout: 10000 })
    const maxLength = 50 * 1024
    const truncated = text.length > maxLength ? text.substring(0, maxLength) + '\n... (truncated)' : text

    session.variables.set(variableName, truncated)

    const preview = text.replace(/\s+/g, ' ').trim()
    const previewText = preview.length > 100 ? preview.substring(0, 100) + '…' : preview
    this.emitActionLog(sessionId, session, 'extract', `${variableName} "${selector}" → "${previewText}"`)

    sendJson(res, 200, { text: truncated })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleScreenshot(res: http.ServerResponse, session: any, params: Record<string, unknown>): Promise<void> {
    const screenshotBuffer = await session.screenshot(params.fullPage ?? true)
    const base64 = screenshotBuffer.toString('base64')
    sendJson(res, 200, { screenshot: base64 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleGetUrl(res: http.ServerResponse, session: any): void {
    sendJson(res, 200, { url: session.getCurrentUrl() })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleGetTitle(res: http.ServerResponse, session: any): Promise<void> {
    const title = await session.getPageTitle()
    sendJson(res, 200, { title })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleGetVariable(res: http.ServerResponse, sessionId: string, session: any, name: string): void {
    const value = session.variables.get(name)
    if (value === undefined) {
      sendJson(res, 404, { error: `Variable not found: ${name}` })
      return
    }
    this.emitActionLog(sessionId, session, 'get_variable', `${name} → "${value}"`)
    sendJson(res, 200, { name, value })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleSetVariable(res: http.ServerResponse, sessionId: string, session: any, params: Record<string, unknown>): Promise<void> {
    const name = params.name as string
    const value = params.value as string
    if (!name || value === undefined) {
      sendJson(res, 400, { error: 'Missing name or value' })
      return
    }
    session.variables.set(name, value)
    this.emitActionLog(sessionId, session, 'set_variable', `${name} "${value}"`)
    sendJson(res, 200, { ok: true })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleExecuteScript(res: http.ServerResponse, sessionId: string, session: any, params: Record<string, unknown>): Promise<void> {
    const script = params.script as string
    if (!script) {
      sendJson(res, 400, { error: 'Missing script' })
      return
    }

    const result = await executePlaywrightScript(session, script, (step, total, line) => {
      // Emit progress via action log callback
      if (this.onActionLog) {
        this.onActionLog({
          sessionId,
          entry: { timestamp: Date.now(), source: 'chat', action: 'script_progress', details: `${step}/${total}: ${line}` },
        })
      }
    })

    sendJson(res, 200, result)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleListVariables(res: http.ServerResponse, session: any): void {
    const entries = Array.from(session.variables.entries()) as [string, string][]
    sendJson(res, 200, { variables: Object.fromEntries(entries) })
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
