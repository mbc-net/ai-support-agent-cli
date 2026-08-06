import * as crypto from 'crypto'
import * as http from 'http'

import { AUTH_TIMEOUT, ERR_AUTH_SERVER_START_FAILED, LOCALHOST_ADDRESS, MAX_AUTH_BODY_SIZE } from './constants'
import { t } from './i18n'
import { parseString } from './utils'
import { sendJson } from './utils/http-response'

export interface AuthResult {
  token: string
  apiUrl?: string
  tenantCode?: string
  projectCode?: string
}

export function startAuthServer(port?: number, allowedOrigin?: string): Promise<{
  url: string
  nonce: string
  waitForCallback: () => Promise<AuthResult>
  stop: () => void
}> {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(32).toString('hex')
    let nonceUsed = false
    let callbackResolve: ((result: AuthResult) => void) | null = null
    let callbackReject: ((error: Error) => void) | null = null
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const server = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? `http://${LOCALHOST_ADDRESS}`)
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/callback') {
        const contentType = req.headers['content-type'] ?? ''
        if (!contentType.startsWith('application/json')) {
          sendJson(res, 415, { error: 'Unsupported Media Type: expected application/json' })
          return
        }
        let body = ''
        let bodySize = 0
        req.on('data', (chunk: Buffer) => {
          bodySize += chunk.length
          if (bodySize > MAX_AUTH_BODY_SIZE) {
            sendJson(res, 413, { error: 'Request body too large' })
            req.destroy()
            return
          }
          body += chunk.toString()
        })
        req.on('end', () => {
          if (bodySize > MAX_AUTH_BODY_SIZE) return
          try {
            const data = JSON.parse(body) as Record<string, unknown>
            const token = parseString(data.token)

            if (!token) {
              sendJson(res, 400, { error: 'Missing token' })
              return
            }

            const nonceValid = typeof data.nonce === 'string'
              && data.nonce.length === nonce.length
              && crypto.timingSafeEqual(Buffer.from(data.nonce), Buffer.from(nonce))
            if (!nonceValid) {
              sendJson(res, 403, { error: 'Invalid nonce' })
              return
            }

            if (nonceUsed) {
              sendJson(res, 400, { error: 'Nonce already used' })
              return
            }
            nonceUsed = true

            sendJson(res, 200, { success: true })

            if (callbackResolve) {
              callbackResolve({
                token,
                apiUrl: parseString(data.apiUrl) ?? undefined,
                tenantCode: parseString(data.tenantCode) ?? undefined,
                projectCode: parseString(data.projectCode) ?? undefined,
              })
            }
          } catch {
            sendJson(res, 400, { error: 'Invalid request body' })
          }
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    const listenPort = port ?? 0 // 0 = OS auto-assign

    server.listen(listenPort, LOCALHOST_ADDRESS, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error(ERR_AUTH_SERVER_START_FAILED))
        return
      }

      const serverUrl = `http://${LOCALHOST_ADDRESS}:${addr.port}`

      const stop = (): void => {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
        server.close()
      }

      const waitForCallback = (): Promise<AuthResult> => {
        return new Promise<AuthResult>((res, rej) => {
          callbackResolve = res
          callbackReject = rej

          timeoutId = setTimeout(() => {
            rej(new Error(t('auth.timeout')))
            server.close()
          }, AUTH_TIMEOUT)
        })
      }

      resolve({ url: serverUrl, nonce, waitForCallback, stop })
    })

    server.on('error', (error) => {
      reject(error)
      if (callbackReject) {
        callbackReject(error)
      }
    })
  })
}
