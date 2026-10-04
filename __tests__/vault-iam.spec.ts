import { workloadProof } from '../src/vault/iam'
jest.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: () => async () => ({ accessKeyId: 'synthetic-key', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session' }) }))
it('signs a short-lived regional STS proof with an environment audience', async () => {
  const proof = await workloadProof({ tenantCode: 'tenant', projectCode: 'project', serviceCode: 'api', environment: 'production' }, 'ap-northeast-1')
  const url = new URL(Buffer.from(proof.slice('vault-iam-v1:'.length), 'base64url').toString())
  expect(url.hostname).toBe('sts.ap-northeast-1.amazonaws.com')
  expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;x-vault-scope')
  expect(url.searchParams.get('Action')).toBe('GetCallerIdentity')
  expect(url.searchParams.get('X-Amz-Security-Token')).toBe('synthetic-session')
})
