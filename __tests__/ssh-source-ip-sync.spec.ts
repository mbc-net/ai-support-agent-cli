import { validateSyncPayload, verifyReceipt, runSshSourceIpSync } from '../src/server-setup/ssh-source-ip-sync'

const payload = { attemptId: 'attempt', policyId: 'policy', policyVersion: 1, definitionVersion: 2, sshHostId: 'host', cidrs: ['192.0.2.1/32'], release: false, keyOnly: true, manageSources: true, expectedHostKeySha256: 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, ''), expectedRemovedRules: [] }

describe('SSH source policy dedicated runner', () => {
  it('rejects missing pinned host key, invalid IDs and a scope-free restriction', () => {
    for (const change of [{expectedHostKeySha256:''},{attemptId:'../bad'},{cidrs:[]},{policyVersion:0}]) {
      expect(() => validateSyncPayload({...payload,...change})).toThrow()
    }
    expect(validateSyncPayload(payload)).toEqual(payload)
    expect(validateSyncPayload({...payload,cidrs:[]},true)).toMatchObject({cidrs:[]})
    expect(validateSyncPayload({...payload,manageSources:false,cidrs:[]})).toMatchObject({manageSources:false})
  })
  it('rejects a foreign or old receipt', () => {
    const receipt = {...payload,status:'succeeded'}
    expect(() => verifyReceipt(receipt,payload)).not.toThrow()
    expect(() => verifyReceipt({...receipt,policyVersion:2},payload)).toThrow()
    expect(() => verifyReceipt({...receipt,sshHostId:'other'},payload)).toThrow()
  })
  it('refuses oneshot before fetching credentials or touching SSH', async () => {
    const original = process.env.AGENT_MODE
    process.env.AGENT_MODE = 'oneshot'
    const client = {getSshSourceIpCredential: jest.fn()}
    try {
      const result = await runSshSourceIpSync(payload, {commandId:'command',agentId:'agent',client:client as never})
      expect(result.success).toBe(false)
      expect(client.getSshSourceIpCredential).not.toHaveBeenCalled()
    } finally {
      if (original === undefined) delete process.env.AGENT_MODE
      else process.env.AGENT_MODE = original
    }
  })
})
