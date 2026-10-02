import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  DEFAULT_GUACD_IMAGE,
  ensureProjectGuacdContainer,
  extractGuacdSystemCaBundle,
  removeProjectGuacdNetwork,
  resolveProjectGuacdIdentity,
  stopProjectGuacdContainer,
} from '../../src/rdp/guacd-container'
import { RdpTrustedCaStore } from '../../src/rdp/rdp-trusted-ca'
import { TEST_CA_PEM } from '../fixtures/rdp-trusted-ca-pems'

/**
 * Docker 形態のプロジェクト別 guacd と信頼ストアを、**実際の** guacd イメージで確かめる。
 *
 * ユニットテストは docker CLI をモックしているため、イメージの中に標準バンドルが
 * あるか・`:ro` の信頼ストアを guacd から読めるかは実物でしか分からない。
 *
 * Docker とイメージが必要。amd64 のイメージを前提とするため、amd64 以外の
 * ホスト（エミュレーションでは guacd が起動しない）では**スキップし、その理由を stderr に出す**
 * （guacd-handshake-docker.integration.spec.ts と同じく、黙って緑にしない）。
 * FreeRDP が実際に登録 CA で証明書を検証できるかは RDP サーバーが要るため対象外。
 */

function availability(): { ok: true } | { ok: false; reason: string } {
  if (process.arch !== 'x64') {
    return { ok: false, reason: `this check runs ${DEFAULT_GUACD_IMAGE} on amd64 hosts only (this host is ${process.arch})` }
  }
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 })
  } catch {
    return { ok: false, reason: 'docker is not available' }
  }
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_GUACD_IMAGE], { stdio: 'ignore', timeout: 15_000 })
  } catch {
    try {
      execFileSync('docker', ['pull', DEFAULT_GUACD_IMAGE], { stdio: 'ignore', timeout: 300_000 })
    } catch {
      return { ok: false, reason: `${DEFAULT_GUACD_IMAGE} is not present and could not be pulled` }
    }
  }
  return { ok: true }
}

const state = availability()
if (!state.ok) {
  process.stderr.write(
    `[guacd-trusted-ca-docker] SKIPPED: ${state.reason}. The trust store was NOT checked against a real guacd.\n`,
  )
}
const describeWithDocker = state.ok ? describe : describe.skip

describeWithDocker(`project guacd trust store against a real ${DEFAULT_GUACD_IMAGE}`, () => {
  jest.setTimeout(120_000)

  // describe.skip でも describe の本体は実行されるため、一時ディレクトリは beforeAll で作る
  // （スキップ時に残さない）。
  let configDir: string
  let id: ReturnType<typeof resolveProjectGuacdIdentity>

  beforeAll(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-guacd-ca-it-'))
    id = resolveProjectGuacdIdentity(
      { tenantCode: 'it', projectCode: `P_${randomBytes(4).toString('hex')}` },
      'integration-test',
      configDir,
    )
  })

  afterAll(() => {
    stopProjectGuacdContainer(id)
    removeProjectGuacdNetwork(id)
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('★ 標準バンドルを取り出し、guacd が SSL_CERT_FILE の bundle.pem を読める', () => {
    ensureProjectGuacdContainer(id)
    extractGuacdSystemCaBundle(id)
    const system = fs.readFileSync(path.join(id.caHostDir, 'system-ca.pem'), 'utf8')
    expect(system.match(/BEGIN CERTIFICATE/g)?.length ?? 0).toBeGreaterThan(10)

    new RdpTrustedCaStore(() => id.caHostDir).apply([TEST_CA_PEM])

    const seen = execFileSync(
      'docker',
      ['exec', id.containerName, 'sh', '-c', 'echo "$SSL_CERT_FILE"; cat "$SSL_CERT_FILE"'],
      { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    )
    expect(seen.startsWith('/run/ais-rdp-ca/bundle.pem\n')).toBe(true)
    expect(seen).toContain(TEST_CA_PEM.trim())
  })

  it('★ 一致する構成なら再利用する（コンテナ ID が変わらない）', () => {
    const before = execFileSync('docker', ['inspect', '-f', '{{.Id}}', id.containerName], { encoding: 'utf-8' })
    ensureProjectGuacdContainer(id)
    const after = execFileSync('docker', ['inspect', '-f', '{{.Id}}', id.containerName], { encoding: 'utf-8' })
    expect(after).toBe(before)
  })
})
