const mockExec = jest.fn()
jest.mock('child_process', () => ({execFile: (...args: unknown[]) => mockExec(...args)}))

import { selectZabbixController, verifyZabbixController } from '../../src/server-setup/zabbix-controller'

describe('dedicated Zabbix controller', () => {
  const tasks = [{'ansible.builtin.include_role': {name: 'zabbix_agent'}}]
  it('retains the legacy default', () => {
    expect(selectZabbixController(tasks, undefined)).toBe('ansible-playbook')
  })
  it('selects only the fixed administrator profile', () => {
    expect(selectZabbixController(tasks, '2.20')).toBe('/opt/ai-support-zabbix-ansible/bin/ansible-playbook')
    expect(() => selectZabbixController(tasks, '/tmp/evil')).toThrow()
  })
  it('leaves non-Zabbix executions on the legacy controller', () => {
    expect(selectZabbixController([{'ansible.builtin.include_role': {name: 'database'}}], '2.20')).toBe('ansible-playbook')
  })
  it('rejects unvalidated mixed-role recipes rather than changing their controller', () => {
    expect(() => selectZabbixController([...tasks, {'ansible.builtin.include_role': {name: 'database'}}], '2.20')).toThrow('separate recipe')
  })
  it('treats the webhook relay as a Zabbix role (26.04 needs the 2.20 controller)', () => {
    const relay = [{'ansible.builtin.include_role': {name: 'zabbix_webhook_relay'}}]
    expect(selectZabbixController(relay, '2.20')).toBe('/opt/ai-support-zabbix-ansible/bin/ansible-playbook')
    expect(() => selectZabbixController([...relay, {'ansible.builtin.include_role': {name: 'database'}}], '2.20')).toThrow('separate recipe')
  })
  it('handles nested guarded blocks', () => {
    expect(selectZabbixController([{block: tasks}], '2.20')).toContain('/opt/')
  })
})

describe('controller preflight', () => {
  beforeEach(() => mockExec.mockReset())
  it('does not inspect the unchanged legacy default', async () => {
    await verifyZabbixController('ansible-playbook')
    expect(mockExec).not.toHaveBeenCalled()
  })
  it('fails closed before target access if dedicated installation is missing or old', async () => {
    mockExec.mockImplementation((_file, _args, _options, callback) => callback(new Error('missing'), ''))
    await expect(verifyZabbixController('/opt/test')).rejects.toThrow('unavailable')
    mockExec.mockImplementation((_file, _args, _options, callback) => callback(null, 'ansible-playbook [core 2.17.0]'))
    await expect(verifyZabbixController('/opt/test')).rejects.toThrow('incompatible')
  })
  it('accepts only the validated minor series', async () => {
    mockExec.mockImplementation((_file, _args, _options, callback) => callback(null, 'ansible-playbook [core 2.20.11]'))
    await expect(verifyZabbixController('/opt/test')).resolves.toBeUndefined()
  })
})
