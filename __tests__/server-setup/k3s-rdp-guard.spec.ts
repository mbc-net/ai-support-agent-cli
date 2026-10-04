import { validateAnsibleTasks } from '../../src/server-setup/ansible-task-guard'

describe('k3s RDP recipe variables', () => {
  it('accepts RDP opt-in and official guacd image settings', () => {
    const result = validateAnsibleTasks(
      '- ansible.builtin.include_role:\n    name: ai_support_agent_k8s\n  vars:\n    ai_support_agent_k8s_rdp: true\n    ai_support_agent_k8s_guacd_image: guacamole/guacd:1.5.5\n',
      { mode: 'resident', targetOs: 'linux' },
    )
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })
})
