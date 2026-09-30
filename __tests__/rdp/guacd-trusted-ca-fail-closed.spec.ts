import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { resolveProjectGuacdIdentity } from '../../src/rdp/guacd-container'
import { buildGuacdDockerArgs } from '../../src/rdp/guacd-runtime'
import { RdpTrustedCaStore, resolveRdpTrustedCaDir } from '../../src/rdp/rdp-trusted-ca'
import { TEST_CA_PEM } from '../fixtures/rdp-trusted-ca-pems'

jest.mock('../../src/logger')
jest.mock('child_process', () => ({ execFileSync: jest.fn() }))
jest.mock('../../src/docker/docker-utils', () => ({ getDockerPath: () => '/usr/bin/docker' }))
const mockConfigDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ais-rdp-fail-closed-'))
jest.mock('../../src/config-manager', () => ({ getConfigDir: () => mockConfigDir }))

/**
 * 標準 CA の取り出しに失敗したときに、削除済みの CA を信頼し続けないこと（fail-closed）。
 *
 * guacd は `SSL_CERT_FILE=bundle.pem` で動き続けており、ホスト側の信頼ストアには
 * 前回エージェントが書いた登録 CA 入りの bundle.pem が残っている。取り出しに
 * 失敗した回はエージェントへ信頼ストアを渡さない（`rdpTrustedCa` を申告しない）ため、
 * その後に管理者が CA を全件削除しても、エージェントは bundle.pem を書き直さない。
 * 古い bundle.pem を残すと、削除済みの CA で証明書検証が通ってしまう。
 */

const exec = execFileSync as jest.Mock
const SYSTEM_BUNDLE = '-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----\n'
const project = { tenantCode: 'mbc', projectCode: 'MBC_01' }
const id = resolveProjectGuacdIdentity(project, 'agent-1')

/** 稼働中で構成が一致する guacd として inspect に答える。exec は `execResult` に従う。 */
function stubDocker(execResult: () => string): void {
  exec.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'inspect') {
      return JSON.stringify({
        State: { Running: true },
        Config: {
          Labels: {
            'ai-support-agent.rdp.project': 'mbc/MBC_01',
            'ai-support-agent.rdp.layout': 'project-v1',
          },
          Env: ['SSL_CERT_FILE=/run/ais-rdp-ca/bundle.pem'],
        },
        Mounts: [{ Source: id.caHostDir, Destination: '/run/ais-rdp-ca' }],
      })
    }
    if (args[0] === 'exec') return execResult()
    return ''
  })
}

afterAll(() => {
  fs.rmSync(mockConfigDir, { recursive: true, force: true })
})

it('★ 既存バンドルあり → 取り出し失敗 → CA 全件削除 でも、削除済みの CA を信頼しない', () => {
  // 1. 初回起動: 取り出しに成功し、エージェントが登録 CA 入りの bundle.pem を書く。
  stubDocker(() => SYSTEM_BUNDLE)
  const first = buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')
  expect(first).toContain('AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR=/run/ais-rdp-ca')
  new RdpTrustedCaStore(() => id.caHostDir).apply([TEST_CA_PEM])
  const bundle = path.join(id.caHostDir, 'bundle.pem')
  expect(fs.readFileSync(bundle, 'utf8')).toContain(TEST_CA_PEM.trim())

  // 2. 再起動: 取り出しに失敗する（guacd は動き続けて bundle.pem を読んでいる）。
  stubDocker(() => {
    throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' })
  })
  const second = buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')
  expect(second.join(' ')).not.toContain('RDP_TRUSTED_CA_DIR')

  // 3. 管理者が CA を全件削除 → エージェントには信頼ストアが無いので apply([]) は何もしない。
  const agentEnv = { AI_SUPPORT_AGENT_IN_DOCKER: '1' }
  expect(resolveRdpTrustedCaDir(agentEnv)).toBeUndefined()
  new RdpTrustedCaStore(() => resolveRdpTrustedCaDir(agentEnv)).apply([])

  // guacd が読む bundle.pem に削除済みの CA が残っていないこと。
  const remaining = fs.existsSync(bundle) ? fs.readFileSync(bundle, 'utf8') : ''
  expect(remaining).not.toContain(TEST_CA_PEM.trim())
})
