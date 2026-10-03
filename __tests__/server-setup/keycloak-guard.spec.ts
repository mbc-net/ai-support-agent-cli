import { validateAnsibleTasks } from '../../src/server-setup/ansible-task-guard'

describe('Keycloak recipe boundary', () => {
  it.each(['ecs', 'resident'] as const)('%s accepts the Keycloak recipe with secret references', (mode) => {
    const result = validateAnsibleTasks(`- name: Keycloak
  ansible.builtin.include_role:
    name: keycloak
  vars:
    keycloak_hostname: https://sso.example.com
    keycloak_proxy_headers: xforwarded
    keycloak_proxy_trusted_addresses: [172.18.0.1]
    keycloak_db_password: "{{ DB_PASSWORD }}"
    keycloak_admin_password: "{{ ADMIN_PASSWORD }}"
`, { mode, targetOs: 'linux', secretVarNames: new Set(['DB_PASSWORD', 'ADMIN_PASSWORD']) })
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.normalizedTasks?.[0].no_log).toBe(true)
  })

  it.each(['keycloak_compose_result', 'keycloak_config_result', 'keycloak_public_result', 'keycloak_db_auth_result'])('rejects reading and overwriting %s', (name) => {
    expect(validateAnsibleTasks(`- ansible.builtin.debug:
    msg: "{{ ${name} }}"`, { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
    expect(validateAnsibleTasks(`- ansible.builtin.set_fact:
    ${name}: forged`, { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
    expect(validateAnsibleTasks(`- ansible.builtin.include_role:
    name: keycloak
  vars:
    ${name}: forged`, { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
  })

  it('rejects changing image repositories and host paths', () => {
    for (const name of ['keycloak_image', 'keycloak_install_dir', 'keycloak_compose_command']) {
      expect(validateAnsibleTasks(`- ansible.builtin.include_role:
    name: keycloak
  vars:
    ${name}: malicious`, { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
    }
  })
})
