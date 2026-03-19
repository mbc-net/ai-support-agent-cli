import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * Create a temporary file with secure permissions.
 * Returns the file path. Caller is responsible for cleanup.
 */
export function createSecureTempFile(content: string, prefix: string): string {
  const filename = `${prefix}-${crypto.randomBytes(16).toString('hex')}`
  const filepath = path.join(os.tmpdir(), filename)
  fs.writeFileSync(filepath, content, { mode: 0o600 })
  return filepath
}
