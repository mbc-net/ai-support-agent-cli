import { execFile } from 'child_process'

/**
 * open package compatibility tests.
 *
 * index.ts uses: const open = (await import('open')).default
 *
 * 'open' is an ESM-only package that cannot be directly imported in Jest's
 * CJS environment. Instead, we spawn a Node subprocess with --input-type=module
 * to verify the package's API shape in a real ESM context.
 */

function runEsmScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: __dirname + '/..', timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\nstderr: ${stderr}`))
        } else {
          resolve(stdout.trim())
        }
      },
    )
    child.stdin?.end()
  })
}

describe('open package compatibility', () => {
  it('should be dynamically importable with default function export', async () => {
    const result = await runEsmScript(`
      const mod = await import('open');
      console.log(typeof mod.default);
    `)
    expect(result).toBe('function')
  })

  it('should export apps object', async () => {
    const result = await runEsmScript(`
      const mod = await import('open');
      console.log(typeof mod.apps);
    `)
    expect(result).toBe('object')
  })

  it('should have default export named "open"', async () => {
    const result = await runEsmScript(`
      const mod = await import('open');
      console.log(mod.default.name);
    `)
    expect(result).toBe('open')
  })
})
