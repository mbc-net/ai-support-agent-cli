import { StreamLineParser } from '../../src/utils/stream-parser'

describe('StreamLineParser', () => {
  let parser: StreamLineParser

  beforeEach(() => {
    parser = new StreamLineParser()
  })

  it('should emit complete lines', () => {
    const lines: string[] = []
    parser.push('line1\nline2\n', (line) => lines.push(line))
    expect(lines).toEqual(['line1', 'line2'])
  })

  it('should buffer incomplete lines', () => {
    const lines: string[] = []
    parser.push('partial', (line) => lines.push(line))
    expect(lines).toEqual([])

    parser.push(' data\n', (line) => lines.push(line))
    expect(lines).toEqual(['partial data'])
  })

  it('should handle lines split across multiple chunks', () => {
    const lines: string[] = []
    parser.push('{"type":', (line) => lines.push(line))
    parser.push('"test"}\n', (line) => lines.push(line))
    expect(lines).toEqual(['{"type":"test"}'])
  })

  it('should skip empty lines', () => {
    const lines: string[] = []
    parser.push('line1\n\n\nline2\n', (line) => lines.push(line))
    expect(lines).toEqual(['line1', 'line2'])
  })

  it('should trim whitespace from lines', () => {
    const lines: string[] = []
    parser.push('  hello  \n  world  \n', (line) => lines.push(line))
    expect(lines).toEqual(['hello', 'world'])
  })

  it('should skip whitespace-only lines', () => {
    const lines: string[] = []
    parser.push('data\n   \n  \t  \nmore\n', (line) => lines.push(line))
    expect(lines).toEqual(['data', 'more'])
  })

  it('should handle multiple chunks with no newlines', () => {
    const lines: string[] = []
    parser.push('a', (line) => lines.push(line))
    parser.push('b', (line) => lines.push(line))
    parser.push('c\n', (line) => lines.push(line))
    expect(lines).toEqual(['abc'])
  })

  it('should reset buffer', () => {
    const lines: string[] = []
    parser.push('partial', (line) => lines.push(line))
    parser.reset()
    parser.push('new data\n', (line) => lines.push(line))
    expect(lines).toEqual(['new data'])
  })
})
