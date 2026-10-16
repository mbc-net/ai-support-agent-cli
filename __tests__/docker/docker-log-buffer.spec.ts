import { DockerLogBuffer } from '../../src/docker/docker-log-buffer'
import { DOCKER_MAX_LOG_CHUNK_BYTES, DOCKER_MAX_SESSION_LOG_BYTES } from '../../src/constants'

describe('DockerLogBuffer', () => {
  it('does nothing on an empty flush and accumulates output without an API client', async () => {
    const onTruncated = jest.fn()
    const buffer = new DockerLogBuffer(onTruncated)
    await buffer.flush()
    buffer.append('stdout\n')
    buffer.append('stderr\n')
    expect(buffer.bufferedLength).toBe(14)
    expect(buffer.content).toBe('')
    await buffer.flush()
    expect(buffer.content).toBe('stdout\nstderr\n')
    expect(buffer.bufferedLength).toBe(0)
    expect(onTruncated).not.toHaveBeenCalled()
  })

  it('caps saved output and warns once while delivering every chunk', async () => {
    const send = jest.fn().mockResolvedValue(undefined)
    const warn = jest.fn()
    const buffer = new DockerLogBuffer(warn, send)
    const text = 'x'.repeat(DOCKER_MAX_SESSION_LOG_BYTES + 10)
    buffer.append(text)
    await buffer.flush()
    const saved = buffer.content
    buffer.append('after truncation')
    await buffer.flush()
    expect(buffer.content).toBe(saved)
    expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(DOCKER_MAX_SESSION_LOG_BYTES)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.map(call => call[1]).join('')).toBe(text + 'after truncation')
    send.mock.calls.forEach(([seq, chunk], index) => {
      expect(seq).toBe(index + 1)
      expect(chunk.length).toBeLessThanOrEqual(DOCKER_MAX_LOG_CHUNK_BYTES)
    })
  })

  it('keeps independent overlapping flushes and shared sequence numbers', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const send = jest.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)
    const buffer = new DockerLogBuffer(jest.fn(), send)
    const firstChunk = 'x'.repeat(DOCKER_MAX_LOG_CHUNK_BYTES)
    buffer.append(firstChunk + 'tail')
    const firstFlush = buffer.flush()
    expect(buffer.bufferedLength).toBe(0)
    buffer.append('second')
    await buffer.flush()
    expect(send.mock.calls).toEqual([[1, firstChunk], [2, 'second']])
    release()
    await firstFlush
    expect(send.mock.calls).toEqual([[1, firstChunk], [2, 'second'], [3, 'tail']])
    expect(buffer.content).toBe(firstChunk + 'tailsecond')
  })

  it('propagates unhandled delivery failures without restoring consumed output', async () => {
    const error = new Error('delivery failed')
    const buffer = new DockerLogBuffer(jest.fn(), jest.fn().mockRejectedValue(error))
    buffer.append('output')
    await expect(buffer.flush()).rejects.toBe(error)
    expect(buffer.bufferedLength).toBe(0)
    expect(buffer.content).toBe('output')
  })
})
