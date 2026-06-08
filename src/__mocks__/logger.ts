export const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  setVerbose: jest.fn(),
}

export const setJsonMode = jest.fn()
export const isJsonMode = jest.fn().mockReturnValue(false)
export const getProjectColor = jest.fn().mockReturnValue('\x1b[36m')
export const resetProjectColors = jest.fn()
export const prefixLines = jest.fn().mockImplementation((text: string) => text)
export const maskSecrets = jest.fn().mockImplementation((text: string) => text)
export const makeLinePrefixer = jest.fn().mockImplementation((_prefix: string, write: (s: string) => void) => (chunk: string) => write(chunk))
export const stripCursorCodes = jest.fn().mockImplementation((text: string) => text)
