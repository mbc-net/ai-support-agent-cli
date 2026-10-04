import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { VaultScope } from './runtime'

export async function workloadProof(scope: VaultScope, region: string): Promise<string> {
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error('Invalid workload identity region')
  const hostname = `sts.${region}.amazonaws.com`
  const signer = new SignatureV4({ credentials: fromNodeProviderChain(), region, service: 'sts', sha256: Sha256 })
  const request = await signer.presign(new HttpRequest({ protocol: 'https:', hostname, method: 'GET', path: '/', headers: { host: hostname, 'x-vault-scope': [scope.tenantCode, scope.projectCode, scope.serviceCode, scope.environment].join('/') }, query: { Action: 'GetCallerIdentity', Version: '2011-06-15' } }), { expiresIn: 60 })
  const url = new URL(`https://${hostname}/`)
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item)
    else if (value !== null && value !== undefined) url.searchParams.set(key, value)
  }
  return 'vault-iam-v1:' + Buffer.from(url.href).toString('base64url')
}
