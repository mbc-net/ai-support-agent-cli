import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.mock('../../src/api-client')
jest.mock('../../src/config-manager')

import { ApiClient } from '../../src/api-client'
import { runEcsManifest, runK8sManifest } from '../../src/cli/manifest-command'
import { logger } from '../../src/logger'
import { getProjectList, loadConfig } from '../../src/config-manager'

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockGetProjectList = getProjectList as jest.MockedFunction<
  typeof getProjectList
>
const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>

const PROJECT = {
  tenantCode: 'mbc',
  projectCode: 'MBC_01',
  token: 'mbc:tok-1:raw',
  apiUrl: 'https://api.example.com',
}

describe('manifest command', () => {
  let stdout: jest.SpyInstance
  let tmpDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manifest-'))
    mockLoadConfig.mockReturnValue({ projects: [PROJECT] } as never)
    mockGetProjectList.mockReturnValue([PROJECT] as never)
    MockApiClient.prototype.getReplicaLimit = jest
      .fn()
      .mockResolvedValue({ maxReplicas: null })
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdout.mockRestore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const writtenOutput = () => stdout.mock.calls.map((c) => c[0]).join('')

  describe('runK8sManifest', () => {
    it('writes a Deployment with the requested replica count to stdout', async () => {
      await runK8sManifest({ replicas: '3' })

      expect(writtenOutput()).toContain('replicas: 3')
      expect(writtenOutput()).toContain('kind: Deployment')
    })

    it('warns about the embedded token even when printing to stdout', async () => {
      // stdout is the route most likely to end up in a shell history, a terminal
      // scrollback or a CI log — it must not be the only one without a warning.
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)

      await runK8sManifest({ replicas: '1' })

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('not encryption'),
      )
      warn.mockRestore()
    })

    it('defaults to a single replica', async () => {
      await runK8sManifest({})

      expect(writtenOutput()).toContain('replicas: 1')
    })

    it('refuses to generate more replicas than the plan allows', async () => {
      MockApiClient.prototype.getReplicaLimit = jest
        .fn()
        .mockResolvedValue({ maxReplicas: 1 })

      await expect(runK8sManifest({ replicas: '2' })).rejects.toThrow(
        /at most 1/,
      )
      // Nothing is emitted when the limit check fails.
      expect(writtenOutput()).toBe('')
    })

    it('skips the limit lookup with --skip-limit-check', async () => {
      const spy = jest.fn()
      MockApiClient.prototype.getReplicaLimit = spy

      await runK8sManifest({ replicas: '10', skipLimitCheck: true })

      expect(spy).not.toHaveBeenCalled()
      expect(writtenOutput()).toContain('replicas: 10')
    })

    it('rejects a non-positive replica count before any network call', async () => {
      const spy = jest.fn()
      MockApiClient.prototype.getReplicaLimit = spy

      await expect(runK8sManifest({ replicas: '0' })).rejects.toThrow(
        /positive integer/,
      )
      expect(spy).not.toHaveBeenCalled()
    })

    it('writes the manifest with owner-only permissions when --out is given', async () => {
      // fs sync functions cannot be spied on in this project (the module is
      // non-configurable under ts-jest), so assert against a real temp file.
      const outPath = path.join(tmpDir, 'agent.yaml')

      await runK8sManifest({ replicas: '1', out: outPath })

      expect(fs.readFileSync(outPath, 'utf-8')).toContain('kind: Deployment')
      // The manifest embeds the agent token — 0644 would expose it to every
      // local user on a shared build host.
      expect(fs.statSync(outPath).mode & 0o777).toBe(0o600)
    })

    it('overwrites an existing 0644 file and still ends up 0600', async () => {
      // writeFileSync の mode は新規作成時にしか効かない。既存ファイルへの
      // 上書きで 0644 のまま残ると、トークンを含む manifest が他ユーザーから読める。
      const outPath = path.join(tmpDir, 'existing.yaml')
      fs.writeFileSync(outPath, 'stale', { mode: 0o644 })
      expect(fs.statSync(outPath).mode & 0o777).toBe(0o644)

      await runK8sManifest({ replicas: '1', out: outPath })

      expect(fs.statSync(outPath).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(outPath, 'utf-8')).toContain('kind: Deployment')
    })

    it('fails clearly when no configuration exists', async () => {
      mockLoadConfig.mockReturnValue(null as never)

      await expect(runK8sManifest({})).rejects.toThrow(/login/)
    })
  })

  describe('runEcsManifest', () => {
    const ecsOpts = {
      cluster: 'agents',
      subnets: ['subnet-a'],
      securityGroups: ['sg-1'],
    }

    it('emits both a task definition and a service definition', async () => {
      await runEcsManifest({ ...ecsOpts, replicas: '2' })

      const output = writtenOutput()
      expect(output).toContain('# --- task definition ---')
      expect(output).toContain('# --- service definition ---')
      expect(output).toContain('"desiredCount": 2')
    })

    it('refuses to exceed the plan limit', async () => {
      MockApiClient.prototype.getReplicaLimit = jest
        .fn()
        .mockResolvedValue({ maxReplicas: 1 })

      await expect(
        runEcsManifest({ ...ecsOpts, replicas: '5' }),
      ).rejects.toThrow(/at most 1/)
    })

    it('writes two files when --out is given', async () => {
      const prefix = path.join(tmpDir, 'agent')

      await runEcsManifest({ ...ecsOpts, replicas: '1', out: prefix })

      const taskDef = JSON.parse(
        fs.readFileSync(`${prefix}.taskdef.json`, 'utf-8'),
      )
      const service = JSON.parse(
        fs.readFileSync(`${prefix}.service.json`, 'utf-8'),
      )

      expect(taskDef.family).toBe('ai-support-agent')
      expect(service.desiredCount).toBe(1)
      expect(fs.statSync(`${prefix}.taskdef.json`).mode & 0o777).toBe(0o600)
    })
  })
})
