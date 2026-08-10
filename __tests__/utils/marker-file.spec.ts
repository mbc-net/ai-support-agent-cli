import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readMarkerFile } from '../../src/utils/marker-file'

describe('readMarkerFile', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-file-test-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns the trimmed file contents', () => {
    const p = path.join(dir, 'marker')
    fs.writeFileSync(p, '  abc123\n')
    expect(readMarkerFile(p)).toBe('abc123')
  })

  it('returns an empty string (not undefined) for a whitespace-only file', () => {
    const p = path.join(dir, 'blank')
    fs.writeFileSync(p, '   \n')
    expect(readMarkerFile(p)).toBe('')
  })

  it('returns undefined when the file does not exist', () => {
    expect(readMarkerFile(path.join(dir, 'missing'))).toBeUndefined()
  })

  it('returns undefined when the path is a directory (read error)', () => {
    // reading a directory as a file throws EISDIR → treated as absent
    expect(readMarkerFile(dir)).toBeUndefined()
  })
})
