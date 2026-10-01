import { execFileSync } from 'child_process'
import { join } from 'path'
import { validateAnsibleTasks } from '../../src/server-setup/ansible-task-guard'

describe('HAProxy setup', () => {
  it('verifies transaction failures, recovery and idempotence', () => {
    execFileSync('python3', [join(__dirname, 'haproxy-transaction.py')], { stdio: 'pipe' })
  })
  it('allows the public parameters through the strict execution guard', () => {
    const result = validateAnsibleTasks(`- name: HAProxy
  ansible.builtin.include_role:
    name: haproxy
  vars:
    haproxy_mode: http
    haproxy_bind_address: 127.0.0.1
    haproxy_bind_port: 8080
    haproxy_backends:
      - name: app
        address: 127.0.0.1
        port: 9001
`, { mode: 'ecs' })
    expect(result.ok).toBe(true)
  })
  it('rejects overriding internal transaction results', () => {
    expect(validateAnsibleTasks(`- name: HAProxy
  ansible.builtin.include_role:
    name: haproxy
  vars:
    haproxy_apply_result: { stdout: '{"changed":false}' }
`, { mode: 'ecs' }).ok).toBe(false)
  })
})
