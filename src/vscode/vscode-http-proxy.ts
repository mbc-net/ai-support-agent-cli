import * as http from 'http'

import { logger } from '../logger'
import { getErrorMessage } from '../utils'

import { VSCODE_BIND_HOST } from './constants'

export interface ProxyRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

export interface ProxyResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

/**
 * ローカル code-server への HTTP プロキシ
 *
 * トンネル経由で受け取った HTTP リクエストをローカルの code-server に転送し、
 * レスポンスを返す。
 */
export async function proxyHttpRequest(
  port: number,
  request: ProxyRequest,
): Promise<ProxyResponse> {
  return new Promise<ProxyResponse>((resolve, reject) => {
    const options: http.RequestOptions = {
      method: request.method,
      hostname: VSCODE_BIND_HOST,
      port,
      path: request.path,
      headers: {
        ...request.headers,
        host: `${VSCODE_BIND_HOST}:${port}`,
      },
    }

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('base64')
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) {
            headers[key] = Array.isArray(value) ? value.join(', ') : value
          }
        }

        resolve({
          statusCode: res.statusCode ?? 500,
          headers,
          body,
        })
      })
    })

    req.on('error', (error) => {
      logger.debug(`[vscode-http-proxy] Proxy error for ${request.method} ${request.path}: ${getErrorMessage(error)}`)
      reject(error)
    })

    req.setTimeout(30000, () => {
      req.destroy()
      reject(new Error('Proxy request timeout'))
    })

    if (request.body) {
      req.write(Buffer.from(request.body, 'base64'))
    }

    req.end()
  })
}
