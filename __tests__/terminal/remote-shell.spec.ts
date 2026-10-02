import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  REMOTE_DIR_ENV_NAME,
  buildRemoteShellPlan,
  materializeRemoteShell,
} from '../../src/terminal/remote-shell'
import type { SshCredentials } from '../../src/types'

/**
 * Builds the command a terminal PTY runs when the session targets a registered
 * host instead of the agent's own shell.
 *
 * The plan is pure data (script text + files to materialize) so the dangerous
 * parts are testable without touching the filesystem:
 *
 * 1. **Secrets live in files, never in the script's argv.** A password on the
 *    command line is visible in `ps` output to every process on the host.
 * 2. **Every interpolated value is shell-quoted.** The script is shell text; an
 *    unquoted hostname containing `;` executes arbitrary commands as the agent.
 * 3. **Host key checking stays on** (TOFU via a persistent known_hosts). Turning
 *    it off would accept a changed host key silently after a DNS/route hijack.
 * 4. **An unsupported route or authType is an error, never a fallback** to the
 *    key path (フォールバック禁止).
 */

const KNOWN_HOSTS = '/config/known-hosts/mbc__web-1'

const plain = (overrides: Partial<SshCredentials> = {}): SshCredentials =>
  ({
    hostId: 'web-1',
    hostname: '10.0.0.1',
    port: 2222,
    username: 'deploy',
    authType: 'privateKey',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    connectionType: 'ssh',
    ...overrides,
  }) as SshCredentials

const build = (credentials: SshCredentials) =>
  buildRemoteShellPlan(credentials, { knownHostsPath: KNOWN_HOSTS })

describe('buildRemoteShellPlan', () => {
  describe('plain ssh', () => {
    it('runs ssh against the host with the resolved port and user', () => {
      const plan = build(plain())

      expect(plan.script).toContain('exec ssh')
      expect(plan.script).toContain("-p '2222'")
      expect(plan.script).toContain("'deploy@10.0.0.1'")
    })

    it('defaults to port 22 when the host has no port', () => {
      const plan = build(plain({ port: undefined }))
      expect(plan.script).toContain("-p '22'")
    })

    it('writes the private key to a 0600 file and points ssh at it', () => {
      const plan = build(plain())

      const key = plan.files.find((f) => f.name === 'remote-key')
      expect(key?.mode).toBe(0o600)
      expect(key?.content).toContain('BEGIN OPENSSH PRIVATE KEY')
      expect(plan.script).toContain("-i '${AIS_REMOTE_DIR}/remote-key'")
    })

    it('terminates the key file with a newline', () => {
      // OpenSSH rejects a key whose final line has no terminator with an opaque
      // "error in libcrypto"; the agent hit this before.
      const plan = build(plain())
      const key = plan.files.find((f) => f.name === 'remote-key')
      expect(key?.content.endsWith('\n')).toBe(true)
    })

    it('keeps host key checking on with the persistent known_hosts', () => {
      const plan = build(plain())

      expect(plan.script).toContain('StrictHostKeyChecking=accept-new')
      expect(plan.script).toContain(`UserKnownHostsFile=${"'" + KNOWN_HOSTS + "'"}`)
      expect(plan.script).not.toContain('StrictHostKeyChecking=no')
      expect(plan.script).not.toContain('/dev/null')
    })

    it('uses only the supplied identity (no agent forwarding, no other keys)', () => {
      // Without IdentitiesOnly, ssh offers every key it can find; the session
      // would silently succeed with a credential the project never configured.
      const plan = build(plain())
      expect(plan.script).toContain('IdentitiesOnly=yes')
    })

    it('never puts key material in the script text', () => {
      const plan = build(plain())
      expect(plan.script).not.toContain('BEGIN OPENSSH PRIVATE KEY')
      expect(plan.script).not.toContain('abc')
    })

    /**
     * Checking the script *text* for quotes proves nothing about how a shell
     * splits it. This runs the real script with `ssh` stubbed out and asserts
     * (a) the destination arrives as ONE argv entry and (b) the injected
     * command never executed.
     */
    it('a hostile hostname stays one argument when the script actually runs', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-remote-shell-'))
      try {
        const marker = path.join(dir, 'pwned')
        const plan = build(
          plain({
            hostname: `10.0.0.1; touch ${marker}`,
            username: 'de;ploy',
          }),
        )

        // Stub `ssh` with a recorder earlier on PATH than any real binary.
        const binDir = path.join(dir, 'bin')
        fs.mkdirSync(binDir)
        const argvFile = path.join(dir, 'argv')
        fs.writeFileSync(
          path.join(binDir, 'ssh'),
          `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${argvFile}; done\n`,
          { mode: 0o700 },
        )

        const scriptPath = path.join(dir, 'run.sh')
        fs.writeFileSync(scriptPath, plan.script, { mode: 0o700 })
        for (const file of plan.files) {
          fs.writeFileSync(path.join(dir, file.name), file.content, {
            mode: file.mode,
          })
        }

        const result = spawnSync('/bin/sh', [scriptPath], {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            AIS_REMOTE_DIR: dir,
          },
          encoding: 'utf-8',
        })
        expect(result.status).toBe(0)

        const argv = fs.readFileSync(argvFile, 'utf-8').split('\n').filter(Boolean)
        expect(argv).toContain(`de;ploy@10.0.0.1; touch ${marker}`)
        // The injected command must not have run.
        expect(fs.existsSync(marker)).toBe(false)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('password authentication', () => {
    it('reads the password from a 0600 file via sshpass', () => {
      const plan = build(plain({ authType: 'password', privateKey: 's3cret' }))

      const pass = plan.files.find((f) => f.name === 'remote-pass')
      expect(pass?.mode).toBe(0o600)
      expect(pass?.content).toBe('s3cret\n')
      expect(plan.script).toContain("sshpass -f '${AIS_REMOTE_DIR}/remote-pass'")
    })

    it('never puts the password in the script text', () => {
      // A password in argv shows up in `ps` for every user on the host.
      const plan = build(plain({ authType: 'password', privateKey: 's3cret' }))
      expect(plan.script).not.toContain('s3cret')
    })

    it('forces password authentication and does not offer keys', () => {
      const plan = build(plain({ authType: 'password', privateKey: 's3cret' }))
      expect(plan.script).toContain('PreferredAuthentications=password')
      expect(plan.script).toContain('PubkeyAuthentication=no')
    })

    it('does not write a key file', () => {
      const plan = build(plain({ authType: 'password', privateKey: 's3cret' }))
      expect(plan.files.some((f) => f.name === 'remote-key')).toBe(false)
    })
  })

  describe('ssm', () => {
    const ssm = (): SshCredentials =>
      ({
        hostId: 'ssm-1',
        connectionType: 'ssm',
        instanceId: 'i-0123456789abcdef0',
        region: 'ap-northeast-1',
        awsCredentials: {
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'shh',
          sessionToken: 'tok',
        },
      }) as unknown as SshCredentials

    it('starts an SSM session against the instance', () => {
      const plan = build(ssm())

      expect(plan.script).toContain('exec aws ssm start-session')
      expect(plan.script).toContain("--target 'i-0123456789abcdef0'")
      expect(plan.script).toContain("--region 'ap-northeast-1'")
    })

    it('passes AWS credentials through the environment, not the command line', () => {
      const plan = build(ssm())

      expect(plan.env).toMatchObject({
        AWS_ACCESS_KEY_ID: 'AKIA_TEST',
        AWS_SECRET_ACCESS_KEY: 'shh',
        AWS_SESSION_TOKEN: 'tok',
        AWS_REGION: 'ap-northeast-1',
      })
      expect(plan.script).not.toContain('shh')
      expect(plan.script).not.toContain('AKIA_TEST')
    })

    it('does not fall back to ssh', () => {
      expect(build(ssm()).script).not.toContain('exec ssh')
    })
  })

  describe('rejections', () => {
    it('rejects the tailscale route (sidecar-dependent, not supported here)', () => {
      expect(() =>
        build(plain({ connectionType: 'tailscale' } as Partial<SshCredentials>)),
      ).toThrow(/tailscale/i)
    })

    it('rejects an unknown authType instead of treating it as a key', () => {
      expect(() =>
        build(plain({ authType: 'kerberos' } as unknown as Partial<SshCredentials>)),
      ).toThrow()
    })

    it('rejects missing connection fields', () => {
      expect(() => build(plain({ hostname: '' }))).toThrow()
      expect(() => build(plain({ username: '' }))).toThrow()
      expect(() => build(plain({ privateKey: '' }))).toThrow()
    })

    it('rejects an ssm credential without an instance id or region', () => {
      expect(() =>
        build({
          hostId: 'ssm-1',
          connectionType: 'ssm',
          region: 'ap-northeast-1',
          awsCredentials: { accessKeyId: 'a', secretAccessKey: 'b' },
        } as unknown as SshCredentials),
      ).toThrow()
    })
  })
})

describe('materializeRemoteShell', () => {
  /**
   * Writes the plan into a real directory. Uses an actual tmpdir rather than
   * spying on `fs`: the agent's sync `fs` calls resist module-level spies, and
   * the file modes are the point of the exercise.
   */
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-materialize-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const plan = {
    script: '#!/bin/sh\nexec true\n',
    files: [{ name: 'remote-key', content: 'KEY\n', mode: 0o600 }],
    env: { AWS_REGION: 'ap-northeast-1' },
  }

  it('writes the script as an executable and returns it as the command', () => {
    const result = materializeRemoteShell(plan, dir)

    expect(result.command).toBe(path.join(dir, 'remote-shell'))
    expect(fs.readFileSync(result.command, 'utf-8')).toBe(plan.script)
    expect(fs.statSync(result.command).mode & 0o777).toBe(0o700)
  })

  it('writes secret files with the mode the plan asked for', () => {
    // A key readable by other users on the host is the whole risk here.
    materializeRemoteShell(plan, dir)

    const keyPath = path.join(dir, 'remote-key')
    expect(fs.readFileSync(keyPath, 'utf-8')).toBe('KEY\n')
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)
  })

  it('exports the directory so the script can reference its files', () => {
    const result = materializeRemoteShell(plan, dir)
    expect(result.env[REMOTE_DIR_ENV_NAME]).toBe(dir)
  })

  it('carries the plan environment through', () => {
    const result = materializeRemoteShell(plan, dir)
    expect(result.env.AWS_REGION).toBe('ap-northeast-1')
  })
})
