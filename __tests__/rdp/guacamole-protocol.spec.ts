import {
  decodeGuacamoleInstructions,
  encodeGuacamoleInstruction,
  GuacamoleParseError,
  GuacamoleStreamDecoder,
} from '../../src/rdp/guacamole-protocol'

/**
 * Guacamole protocol codec.
 *
 * Wire format is `LENGTH.VALUE,LENGTH.VALUE,...;` where LENGTH counts UTF-16 code
 * units (what `String.prototype.length` returns). guacamole-common-js — the client
 * that renders the stream in the browser — measures lengths the same way, so this
 * codec must match it rather than counting code points or bytes. A mismatch would
 * desynchronise the stream on the first non-BMP character and wedge the session.
 */

describe('encodeGuacamoleInstruction', () => {
  it('encodes an opcode with no arguments', () => {
    expect(encodeGuacamoleInstruction('nop', [])).toBe('3.nop;')
  })

  it('encodes an opcode with arguments', () => {
    expect(encodeGuacamoleInstruction('select', ['rdp'])).toBe(
      '6.select,3.rdp;',
    )
  })

  it('encodes empty-string arguments as zero length', () => {
    expect(encodeGuacamoleInstruction('connect', ['', 'x'])).toBe(
      '7.connect,0.,1.x;',
    )
  })

  it('measures multi-byte characters in UTF-16 code units, not bytes', () => {
    // 'あ' is 3 bytes in UTF-8 but a single UTF-16 code unit.
    expect(encodeGuacamoleInstruction('x', ['あ'])).toBe('1.x,1.あ;')
  })

  it('measures a surrogate pair as two code units (matches guacamole-common-js)', () => {
    // '😀' is one code point but two UTF-16 code units.
    expect(encodeGuacamoleInstruction('x', ['😀'])).toBe('1.x,2.😀;')
  })

  it('does not escape commas or semicolons inside arguments', () => {
    // The length prefix makes escaping unnecessary; escaping would corrupt values.
    expect(encodeGuacamoleInstruction('x', ['a,b;c'])).toBe('1.x,5.a,b;c;')
  })

  it('rejects an empty opcode', () => {
    expect(() => encodeGuacamoleInstruction('', [])).toThrow(GuacamoleParseError)
  })
})

describe('decodeGuacamoleInstructions', () => {
  it('decodes a single instruction', () => {
    expect(decodeGuacamoleInstructions('6.select,3.rdp;')).toEqual({
      instructions: [{ opcode: 'select', args: ['rdp'] }],
      rest: '',
    })
  })

  it('decodes several instructions in one buffer', () => {
    expect(decodeGuacamoleInstructions('3.nop;1.x,1.y;')).toEqual({
      instructions: [
        { opcode: 'nop', args: [] },
        { opcode: 'x', args: ['y'] },
      ],
      rest: '',
    })
  })

  it('decodes empty arguments', () => {
    expect(decodeGuacamoleInstructions('1.x,0.,1.y;').instructions).toEqual([
      { opcode: 'x', args: ['', 'y'] },
    ])
  })

  it('round-trips values containing the delimiters', () => {
    const encoded = encodeGuacamoleInstruction('x', ['a,b;c', ''])
    expect(decodeGuacamoleInstructions(encoded).instructions).toEqual([
      { opcode: 'x', args: ['a,b;c', ''] },
    ])
  })

  it('round-trips non-BMP characters', () => {
    const encoded = encodeGuacamoleInstruction('clipboard', ['😀あ'])
    expect(decodeGuacamoleInstructions(encoded).instructions).toEqual([
      { opcode: 'clipboard', args: ['😀あ'] },
    ])
  })

  describe('partial input', () => {
    it('returns the incomplete tail as rest', () => {
      expect(decodeGuacamoleInstructions('3.nop;6.sel')).toEqual({
        instructions: [{ opcode: 'nop', args: [] }],
        rest: '6.sel',
      })
    })

    it('treats a missing terminator as incomplete rather than an error', () => {
      expect(decodeGuacamoleInstructions('6.select,3.rdp')).toEqual({
        instructions: [],
        rest: '6.select,3.rdp',
      })
    })

    it('treats a truncated length prefix as incomplete', () => {
      expect(decodeGuacamoleInstructions('12')).toEqual({
        instructions: [],
        rest: '12',
      })
    })
  })

  describe('malformed input', () => {
    it.each([
      ['length is not a number', 'x.nop;'],
      ['length is negative', '-1.nop;'],
      ['separator after value is not , or ;', '3.nop:'],
      ['missing dot after length', '3nop;'],
    ])('rejects when %s', (_label, wire) => {
      expect(() => decodeGuacamoleInstructions(wire)).toThrow(
        GuacamoleParseError,
      )
    })

    it('rejects an absurdly long declared length instead of buffering forever', () => {
      expect(() => decodeGuacamoleInstructions('999999999.x')).toThrow(
        GuacamoleParseError,
      )
    })
  })
})

describe('GuacamoleStreamDecoder', () => {
  it('reassembles instructions split across chunks', () => {
    const decoder = new GuacamoleStreamDecoder()
    expect(decoder.push('6.sel')).toEqual([])
    expect(decoder.push('ect,3.r')).toEqual([])
    expect(decoder.push('dp;')).toEqual([
      { opcode: 'select', args: ['rdp'] },
    ])
  })

  it('emits multiple instructions arriving in one chunk', () => {
    const decoder = new GuacamoleStreamDecoder()
    expect(decoder.push('3.nop;3.nop;')).toHaveLength(2)
  })

  it('keeps a trailing partial instruction for the next chunk', () => {
    const decoder = new GuacamoleStreamDecoder()
    expect(decoder.push('3.nop;4.si')).toEqual([{ opcode: 'nop', args: [] }])
    expect(decoder.push('ze;')).toEqual([{ opcode: 'size', args: [] }])
  })

  it('splits a surrogate pair across chunks without corrupting it', () => {
    const decoder = new GuacamoleStreamDecoder()
    const encoded = encodeGuacamoleInstruction('x', ['😀'])
    const cut = encoded.indexOf('😀') + 1
    expect(decoder.push(encoded.slice(0, cut))).toEqual([])
    expect(decoder.push(encoded.slice(cut))).toEqual([
      { opcode: 'x', args: ['😀'] },
    ])
  })

  it('surfaces malformed input as an error', () => {
    const decoder = new GuacamoleStreamDecoder()
    expect(() => decoder.push('3nop;')).toThrow(GuacamoleParseError)
  })

  it('caps the buffer so a peer cannot exhaust memory', () => {
    // An instruction that is opened and never terminated must not grow forever.
    const decoder = new GuacamoleStreamDecoder({ maxBufferLength: 16 })
    expect(() => decoder.push('900.' + 'x'.repeat(20))).toThrow(
      GuacamoleParseError,
    )
  })

  it('★ accepts a large chunk that decodes fully, even past the buffer cap', () => {
    // The cap bounds what is HELD BACK between chunks, not how much can arrive at
    // once. Applying it to the raw input rejects perfectly valid traffic: guacd
    // routinely sends framebuffer updates far larger than any sane pending-buffer
    // limit, and they decode completely with nothing left over.
    const decoder = new GuacamoleStreamDecoder({ maxBufferLength: 16 })
    const wire = encodeGuacamoleInstruction('blob', ['y'.repeat(200)])
    expect(decoder.push(wire)).toEqual([
      { opcode: 'blob', args: ['y'.repeat(200)] },
    ])
    expect(decoder.bufferedLength).toBe(0)
  })

  it('★ still rejects when the undecoded remainder exceeds the cap', () => {
    const decoder = new GuacamoleStreamDecoder({ maxBufferLength: 16 })
    const complete = encodeGuacamoleInstruction('nop', [])
    // Complete instruction plus a 20-character partial tail.
    expect(() => decoder.push(complete + '900.' + 'z'.repeat(20))).toThrow(
      GuacamoleParseError,
    )
  })

  it('reports how much is still buffered', () => {
    const decoder = new GuacamoleStreamDecoder()
    decoder.push('3.no')
    expect(decoder.bufferedLength).toBe(4)
    decoder.push('p;')
    expect(decoder.bufferedLength).toBe(0)
  })
})
