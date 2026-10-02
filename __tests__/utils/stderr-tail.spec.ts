import { EventEmitter } from 'events'

import { captureStderrTail } from '../../src/utils/stderr-tail'

describe('captureStderrTail', () => {
  it('空なら空文字', () => {
    const tail = captureStderrTail(new EventEmitter() as never)
    expect(tail()).toBe('')
  })

  it('末尾を ": <内容>" で返す（前後の空白を除く）', () => {
    const stream = new EventEmitter()
    const tail = captureStderrTail(stream as never)
    stream.emit('data', Buffer.from('  first\n'))
    stream.emit('data', 'second  \n')
    expect(tail()).toBe(': first\nsecond')
  })

  it('★ 上限を超えたら末尾だけ残す', () => {
    const stream = new EventEmitter()
    const tail = captureStderrTail(stream as never, 10)
    stream.emit('data', 'x'.repeat(100))
    stream.emit('data', 'END')
    expect(tail()).toBe(`: ${'x'.repeat(7)}END`)
  })

  it('stream が無くても動く', () => {
    expect(captureStderrTail(null)()).toBe('')
  })
})
