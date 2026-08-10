import { EventEmitter } from 'events'

import { streamToBuffer } from '../../src/utils/stream-collect'

describe('streamToBuffer', () => {
  it('concatenates emitted data chunks into a single Buffer', async () => {
    const stream = new EventEmitter() as EventEmitter & NodeJS.ReadableStream
    const promise = streamToBuffer(stream)

    stream.emit('data', Buffer.from('hello '))
    stream.emit('data', Buffer.from('world'))
    stream.emit('end')

    const result = await promise
    expect(result).toBeInstanceOf(Buffer)
    expect(result.toString()).toBe('hello world')
  })

  it('resolves with an empty Buffer when no data is emitted', async () => {
    const stream = new EventEmitter() as EventEmitter & NodeJS.ReadableStream
    const promise = streamToBuffer(stream)

    stream.emit('end')

    const result = await promise
    expect(result).toEqual(Buffer.alloc(0))
    expect(result.toString()).toBe('')
  })

  it('rejects when the stream emits an error', async () => {
    const stream = new EventEmitter() as EventEmitter & NodeJS.ReadableStream
    const promise = streamToBuffer(stream)

    const err = new Error('stream failed')
    stream.emit('error', err)

    await expect(promise).rejects.toBe(err)
  })
})
