import * as crypto from 'crypto'
import * as http from 'http'

import { AUTH_TIMEOUT, MAX_AUTH_BODY_SIZE } from './constants'
import { t } from './i18n'
import { parseString } from './utils'

export interface AuthResult {
  token: string
  apiUrl?: string
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
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? 'http://127.0.0.1')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/callback') {
        let body = ''
        let bodySize = 0
        req.on('data', (chunk: Buffer) => {
          bodySize += chunk.length
          if (bodySize > MAX_AUTH_BODY_SIZE) {
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
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
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing token' }))
              return
            }

            const nonceValid = typeof data.nonce === 'string'
              && data.nonce.length === nonce.length
              && crypto.timingSafeEqual(Buffer.from(data.nonce), Buffer.from(nonce))
            if (!nonceValid) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid nonce' }))
              return
            }

            if (nonceUsed) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Nonce already used' }))
              return
            }
            nonceUsed = true

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))

            if (callbackResolve) {
              callbackResolve({
                token,
                apiUrl: parseString(data.apiUrl) ?? undefined,
                projectCode: parseString(data.projectCode) ?? undefined,
              })
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid request body' }))
          }
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    const listenPort = port ?? 0 // 0 = OS auto-assign

    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start auth server'))
        return
      }

      const serverUrl = `http://127.0.0.1:${addr.port}`

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
