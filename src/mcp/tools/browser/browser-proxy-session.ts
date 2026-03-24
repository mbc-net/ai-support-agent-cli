/**
 * BrowserProxySession — proxy that delegates browser operations to the main
 * process via the local HTTP server.
 *
 * Used by MCP tools in the child process when AI_SUPPORT_BROWSER_LOCAL_PORT
 * is set. Presents the same interface as BrowserSession so that MCP tools
 * can operate transparently.
 */

import http from 'http'

import { logger } from '../../../logger'
import { BrowserActionLog } from './browser-action-log'

export class BrowserProxySession {
  readonly variables: ProxyVariableMap
  readonly actionLog = new BrowserActionLog()

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
  ) {
    this.variables = new ProxyVariableMap(baseUrl, sessionId)
  }

  /**
   * Navigate to a URL and return a screenshot buffer.
   */
  async navigate(url: string, options?: {
    waitForSelector?: string
    waitForTimeout?: number
    fullPage?: boolean
  }): Promise<{ title: string; url: string; screenshot: Buffer }> {
    const result = await this.post('navigate', {
      url,
      waitForSelector: options?.waitForSelector,
      waitForTimeout: options?.waitForTimeout,
      fullPage: options?.fullPage ?? true,
    })
    return {
      title: result.title as string,
      url: result.url as string,
      screenshot: Buffer.from(result.screenshot as string, 'base64'),
    }
  }

  /**
   * Click an element by CSS selector.
   */
  async click(selector: string, options?: {
    waitForNavigation?: boolean
    screenshot?: boolean
  }): Promise<{ title: string; url: string; screenshot?: Buffer }> {
    const result = await this.post('click', {
      selector,
      waitForNavigation: options?.waitForNavigation ?? false,
      screenshot: options?.screenshot ?? true,
    })
    return {
      title: result.title as string,
      url: result.url as string,
      screenshot: result.screenshot ? Buffer.from(result.screenshot as string, 'base64') : undefined,
    }
  }

  /**
   * Fill a form field.
   */
  async fill(selector: string, value: string, screenshot?: boolean): Promise<Buffer | undefined> {
    const result = await this.post('fill', { selector, value, screenshot: screenshot ?? false })
    return result.screenshot ? Buffer.from(result.screenshot as string, 'base64') : undefined
  }

  /**
   * Extract text from an element and store in a variable (atomic operation).
   */
  async extract(selector: string, variableName: string): Promise<string> {
    const result = await this.post('extract', { selector, variableName })
    const text = result.text as string
    this.variables.setLocal(variableName, text)
    return text
  }

  /**
   * Get text content from the page.
   */
  async getText(selector?: string): Promise<string> {
    const result = await this.post('get-text', { selector })
    return result.text as string
  }

  /**
   * Take a screenshot.
   */
  async screenshot(fullPage?: boolean): Promise<Buffer> {
    const result = await this.post('screenshot', { fullPage: fullPage ?? true })
    return Buffer.from(result.screenshot as string, 'base64')
  }

  /**
   * Get the current URL.
   */
  async getUrl(): Promise<string> {
    const result = await this.get('url')
    return result.url as string
  }

  /**
   * Get the current page title.
   */
  async getTitle(): Promise<string> {
    const result = await this.get('title')
    return result.title as string
  }

  /**
   * Set a session variable.
   */
  async setVariable(name: string, value: string): Promise<void> {
    await this.post('variable', { name, value })
    // Update local cache so subsequent get() calls reflect the new value
    this.variables.setLocal(name, value)
  }

  /**
   * Get a session variable.
   */
  async getVariable(name: string): Promise<string | undefined> {
    try {
      const result = await this.get(`variable/${name}`)
      return result.value as string
    } catch {
      return undefined
    }
  }

  /**
   * List all session variables.
   */
  async listVariables(): Promise<Record<string, string>> {
    const result = await this.get('variables')
    return (result.variables ?? {}) as Record<string, string>
  }

  /**
   * Stub for isActive — proxy sessions are always considered active
   * as long as the main process session is alive.
   */
  isActive(): boolean {
    return true
  }

  private post(action: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return httpRequest(this.baseUrl, 'POST', `/browser/${this.sessionId}/${action}`, JSON.stringify(data))
  }

  private get(action: string): Promise<Record<string, unknown>> {
    return httpRequest(this.baseUrl, 'GET', `/browser/${this.sessionId}/${action}`)
  }
}

/**
 * Proxy Map that delegates variable operations to the local HTTP server.
 * Provides a synchronous get() that uses a local cache, refreshed by the proxy session methods.
 */
class ProxyVariableMap {
  private cache = new Map<string, string>()

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
  ) {}

  get(name: string): string | undefined {
    return this.cache.get(name)
  }

  set(name: string, value: string): this {
    this.cache.set(name, value)
    // Fire-and-forget to the server
    httpRequest(this.baseUrl, 'POST', `/browser/${this.sessionId}/variable`, JSON.stringify({ name, value }))
      .catch((err) => { logger.warn(`[proxy-variable] Failed to sync variable "${name}" to server: ${String(err)}`) })
    return this
  }

  /** Update local cache only (no HTTP request). Used when setVariable() already sent the request. */
  setLocal(name: string, value: string): void {
    this.cache.set(name, value)
  }

  entries(): IterableIterator<[string, string]> {
    return this.cache.entries()
  }

  /** Refresh cache from the server. Call before reading variables. */
  async refresh(): Promise<void> {
    const result = await httpRequest(this.baseUrl, 'GET', `/browser/${this.sessionId}/variables`)
    const vars = (result.variables ?? {}) as Record<string, string>
    this.cache.clear()
    for (const [k, v] of Object.entries(vars)) {
      this.cache.set(k, v)
    }
  }
}

function httpRequest(baseUrl: string, method: string, path: string, body?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    }

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString()
        try {
          const json = JSON.parse(responseBody) as Record<string, unknown>
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error((json.error as string) ?? `HTTP ${res.statusCode}`))
          } else {
            resolve(json)
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${responseBody}`))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(60000, () => {
      req.destroy(new Error('Request timeout'))
    })

    if (body) {
      req.write(body)
    }
    req.end()
  })
}
