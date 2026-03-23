import * as path from 'path'

export function getNodePath(): string {
  return process.execPath
}

export function getCliEntryPoint(): string {
  return path.resolve(__dirname, '..', '..', 'index.js')
}
