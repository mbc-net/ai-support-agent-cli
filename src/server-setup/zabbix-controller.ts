import { execFile } from 'child_process'

import { ENV_VARS } from '../constants'
const CONTROLLER = '/opt/ai-support-zabbix-ansible/bin/ansible-playbook'
const ROLES = new Set(['zabbix_agent', 'zabbix_server', 'zabbix_web', 'zabbix_webhook_relay'])

/** Called only with guard-normalized tasks. Never accepts a caller-supplied path. */
export function selectZabbixController(tasks: Record<string, unknown>[], profile: string | undefined): string {
  if (!profile) return 'ansible-playbook'
  if (profile !== '2.20') throw new Error(`${ENV_VARS.ZABBIX_CONTROLLER} must be 2.20 or unset`)
  const includedRoles: string[] = []
  const collectRoles = (items: Record<string, unknown>[]): void => {
    for (const task of items) {
      const role = task['ansible.builtin.include_role'] ?? task.include_role
      if (role && typeof role === 'object') includedRoles.push(String((role as {name?: unknown}).name))
      for (const key of ['block', 'rescue', 'always']) {
        if (Array.isArray(task[key])) collectRoles(task[key] as Record<string, unknown>[])
      }
    }
  }
  collectRoles(tasks)
  if (!includedRoles.some(role => ROLES.has(role))) return 'ansible-playbook'
  if (includedRoles.some(role => !ROLES.has(role))) {
    throw new Error('Dedicated Zabbix controller requires a separate recipe without other bundled roles')
  }
  return CONTROLLER
}

/** Verify before any SSH/fact gathering; fixed profile must never silently fall back. */
export function verifyZabbixController(executable: string): Promise<void> {
  if (executable === 'ansible-playbook') return Promise.resolve()
  return new Promise((resolve, reject) => {
    execFile(executable, ['--version'], {timeout: 10000, maxBuffer: 65536}, (error, stdout) => {
      if (error || !/^ansible-playbook \[core 2\.20\.\d+\]/m.test(String(stdout))) {
        reject(new Error('Dedicated Zabbix Ansible 2.20 controller is unavailable or incompatible; install the administrator profile before execution'))
      } else resolve()
    })
  })
}
