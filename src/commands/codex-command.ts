import fs from 'fs'
import path from 'path'

export interface CodexInvocation {
  command: string
  argsPrefix: string[]
  displayCommand: string
}

export function resolveCodexInvocation(): CodexInvocation {
  const bundledBin = resolveBundledCodexBin()
  if (bundledBin) {
    return {
      command: process.execPath,
      argsPrefix: [bundledBin],
      displayCommand: 'codex',
    }
  }
  return {
    command: 'codex',
    argsPrefix: [],
    displayCommand: 'codex',
  }
}

function resolveBundledCodexBin(): string | undefined {
  try {
    const packageJsonPath = require.resolve('@openai/codex/package.json')
    const binPath = path.join(path.dirname(packageJsonPath), 'bin', 'codex.js')
    return fs.existsSync(binPath) ? binPath : undefined
  } catch {
    return undefined
  }
}
