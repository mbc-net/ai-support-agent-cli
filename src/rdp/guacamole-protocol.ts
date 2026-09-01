/**
 * Guacamole protocol codec.
 *
 * Wire format:
 *
 * ```text
 * LENGTH.VALUE,LENGTH.VALUE,...;
 * 6.select,3.rdp;
 * ```
 *
 * The first element is the opcode; the rest are arguments. The length prefix is
 * what makes the format unambiguous, so values are NEVER escaped — a value may
 * legally contain `,` and `;`.
 *
 * LENGTH counts **UTF-16 code units** (`String.prototype.length`), not bytes and
 * not code points. guacamole-common-js, which renders this stream in the browser,
 * measures the same way. Counting differently desynchronises the stream at the
 * first non-BMP character and wedges the session with no useful error.
 */

/** Raised for input that cannot be a valid Guacamole stream. */
export class GuacamoleParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuacamoleParseError'
  }
}

/** A decoded instruction. */
export interface GuacamoleInstruction {
  opcode: string
  args: string[]
}

/**
 * Upper bound for a single declared element length.
 *
 * guacd never sends elements near this size. Without a cap, a peer can declare a
 * huge length and make the decoder buffer indefinitely while it waits for data
 * that never arrives.
 */
const MAX_ELEMENT_LENGTH = 1024 * 1024

/** Default cap for the stream decoder's pending buffer. */
const DEFAULT_MAX_BUFFER_LENGTH = 4 * 1024 * 1024

/** ASCII digit test. Avoids `isNaN`, which accepts whitespace and signs. */
function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

/** Encode one instruction for the wire. */
export function encodeGuacamoleInstruction(
  opcode: string,
  args: readonly string[],
): string {
  if (opcode === '') {
    throw new GuacamoleParseError('opcode must not be empty')
  }
  return (
    [opcode, ...args].map((value) => `${value.length}.${value}`).join(',') + ';'
  )
}

/** Result of decoding whatever complete instructions a buffer holds. */
export interface GuacamoleDecodeResult {
  instructions: GuacamoleInstruction[]
  /** Trailing bytes belonging to an instruction that is not complete yet. */
  rest: string
}

/**
 * Decode every complete instruction in `buffer`.
 *
 * An incomplete trailing instruction is returned in `rest` rather than raising —
 * TCP delivers arbitrary chunks, so "not complete yet" is the normal case, not an
 * error. Only input that can never become valid raises.
 */
export function decodeGuacamoleInstructions(
  buffer: string,
): GuacamoleDecodeResult {
  const instructions: GuacamoleInstruction[] = []
  let cursor = 0

  // Start of the instruction being read. On an incomplete read we rewind here so
  // the caller can retry once more data arrives.
  let instructionStart = 0
  let elements: string[] = []

  while (cursor < buffer.length) {
    // Scan the digit run rather than searching for the next '.', so that input
    // which can never become a valid prefix (`3nop;`) fails now instead of being
    // mistaken for a chunk boundary and buffered until some later '.' arrives.
    let digitsEnd = cursor
    while (digitsEnd < buffer.length && isAsciiDigit(buffer[digitsEnd])) {
      digitsEnd++
    }

    if (digitsEnd === buffer.length) {
      // All digits so far; the '.' may still be coming.
      break
    }

    const lengthText = buffer.slice(cursor, digitsEnd)
    if (lengthText === '' || buffer[digitsEnd] !== '.') {
      throw new GuacamoleParseError(
        `expected a numeric length prefix followed by "." but found ${JSON.stringify(
          buffer.slice(cursor, digitsEnd + 1),
        )}`,
      )
    }

    const dot = digitsEnd
    const length = Number(lengthText)
    if (length > MAX_ELEMENT_LENGTH) {
      throw new GuacamoleParseError(
        `declared element length ${length} exceeds the ${MAX_ELEMENT_LENGTH} limit`,
      )
    }

    const valueStart = dot + 1
    const valueEnd = valueStart + length
    // The separator sits one position past the value, so both must be present.
    if (valueEnd >= buffer.length) {
      break
    }

    const value = buffer.slice(valueStart, valueEnd)
    const separator = buffer[valueEnd]

    if (separator === ',') {
      elements.push(value)
      cursor = valueEnd + 1
      continue
    }

    if (separator === ';') {
      elements.push(value)
      const [opcode, ...args] = elements
      instructions.push({ opcode, args })
      elements = []
      cursor = valueEnd + 1
      instructionStart = cursor
      continue
    }

    throw new GuacamoleParseError(
      `expected "," or ";" after an element but found ${JSON.stringify(separator)}`,
    )
  }

  return { instructions, rest: buffer.slice(instructionStart) }
}

/** Options for {@link GuacamoleStreamDecoder}. */
export interface GuacamoleStreamDecoderOptions {
  /**
   * Cap on buffered-but-undecoded characters. Reaching it raises instead of
   * growing without bound, so a peer that opens an instruction and never closes
   * it cannot exhaust memory.
   */
  maxBufferLength?: number
}

/**
 * Stateful decoder for a chunked stream.
 *
 * Holds the incomplete tail between chunks, so an instruction split anywhere —
 * including in the middle of a surrogate pair — reassembles correctly.
 */
export class GuacamoleStreamDecoder {
  private buffer = ''
  private readonly maxBufferLength: number

  constructor(options: GuacamoleStreamDecoderOptions = {}) {
    this.maxBufferLength = options.maxBufferLength ?? DEFAULT_MAX_BUFFER_LENGTH
  }

  /** Characters held back waiting for the rest of an instruction. */
  get bufferedLength(): number {
    return this.buffer.length
  }

  /** Feed a chunk and get whatever instructions became complete. */
  push(chunk: string): GuacamoleInstruction[] {
    const { instructions, rest } = decodeGuacamoleInstructions(
      this.buffer + chunk,
    )

    // The cap bounds what is HELD BACK between chunks, so it is checked against
    // the undecoded remainder — not against the raw input. guacd routinely sends
    // framebuffer updates larger than any sane pending-buffer limit; those decode
    // completely and leave nothing behind, and rejecting them would break normal
    // sessions while doing nothing about the case the cap exists for (a peer that
    // opens an instruction and never terminates it).
    if (rest.length > this.maxBufferLength) {
      this.buffer = ''
      throw new GuacamoleParseError(
        `pending buffer exceeded ${this.maxBufferLength} characters without a complete instruction`,
      )
    }

    this.buffer = rest
    return instructions
  }
}
