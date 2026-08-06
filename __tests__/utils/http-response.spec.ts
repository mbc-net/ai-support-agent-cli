import type { ServerResponse } from 'http'

import { sendJson } from '../../src/utils/http-response'

describe('sendJson', () => {
  function createMockRes(): {
    res: ServerResponse
    writeHead: jest.Mock
    end: jest.Mock
  } {
    const writeHead = jest.fn()
    const end = jest.fn()
    const res = { writeHead, end } as unknown as ServerResponse
    return { res, writeHead, end }
  }

  it('writes the status with an application/json content-type', () => {
    const { res, writeHead } = createMockRes()
    sendJson(res, 200, { ok: true })
    expect(writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'application/json',
    })
  })

  it('ends the response with the JSON-serialized payload', () => {
    const { res, end } = createMockRes()
    sendJson(res, 400, { error: 'bad' })
    expect(end).toHaveBeenCalledWith(JSON.stringify({ error: 'bad' }))
  })

  it('passes through the given status code', () => {
    const { res, writeHead } = createMockRes()
    sendJson(res, 413, { error: 'too large' })
    expect(writeHead).toHaveBeenCalledWith(413, {
      'Content-Type': 'application/json',
    })
  })
})
