import { dump } from 'js-yaml'

import { INCLUDE_ROLE_ALLOWED_ROLES, INCLUDE_ROLE_ALLOWED_VARS, ROLE_TARGET_OS, validateAnsibleTasks } from '../../src/server-setup/ansible-task-guard'

const publicVariables = [
  'cloudfront_sync_host_address', 'cloudfront_sync_firewall_backend', 'cloudfront_sync_ports',
  'cloudfront_sync_nginx_enabled', 'cloudfront_sync_nginx_shared_dir', 'cloudfront_sync_nginx_bundles',
  'cloudfront_sync_max_changes', 'cloudfront_sync_min_ratio', 'cloudfront_sync_notify_unit',
  'cloudfront_sync_timer_enabled', 'cloudfront_sync_approve_token',
]

describe('CloudFront synchronization recipe guard', () => {
  it('exposes only the reviewed public parameters as a Linux-only role', () => {
    expect(INCLUDE_ROLE_ALLOWED_ROLES.has('cloudfront_sync')).toBe(true)
    expect([...INCLUDE_ROLE_ALLOWED_VARS.cloudfront_sync].sort()).toEqual(publicVariables.sort())
    expect(ROLE_TARGET_OS.cloudfront_sync).toBe('linux')
  })

  it.each(['ecs', 'resident'] as const)('accepts typed CFSYNC references in %s mode', mode => {
    const result = validateAnsibleTasks(dump([{
      'ansible.builtin.include_role': { name: 'cloudfront_sync' },
      vars: {
        cloudfront_sync_host_address: '{{ CFSYNC_HOST_ADDRESS }}',
        cloudfront_sync_nginx_enabled: '{{ CFSYNC_NGINX_ENABLED | from_json }}',
        cloudfront_sync_nginx_bundles: '{{ CFSYNC_NGINX_BUNDLES | from_json }}',
        cloudfront_sync_timer_enabled: false,
      },
    }]), { mode, targetOs: 'linux' })
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('rejects this role on Windows and rejects non-public role parameters', () => {
    const task = { 'ansible.builtin.include_role': { name: 'cloudfront_sync' } }
    expect(validateAnsibleTasks(dump([task]), { mode: 'ecs', targetOs: 'windows' }).ok).toBe(false)
    expect(validateAnsibleTasks(dump([{ ...task, vars: { cloudfront_sync_script: '/tmp/evil.py' } }]), { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
  })

  it.each(['_cloudfront_sync_parameters', '_cloudfront_sync_future_result'])('rejects writes and references to internal name %s', name => {
    for (const task of [
      { 'ansible.builtin.set_fact': { [name]: 'forged' } },
      { 'ansible.builtin.debug': { msg: 'forged' }, register: name },
      { 'ansible.builtin.debug': { msg: `{{ ${name} }}` } },
    ]) expect(validateAnsibleTasks(dump([task]), { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
  })
})
