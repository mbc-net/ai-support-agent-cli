import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { load, dump } from 'js-yaml'
import { validateAnsibleTasks as validate, INCLUDE_ROLE_ALLOWED_VARS } from '../../src/server-setup/ansible-task-guard'

const roleDir = path.join(__dirname, '../../ansible/roles')

const validateAnsibleTasks = (tasks: unknown[], options: { mode: 'resident' }) => validate(dump(tasks), options)

describe('Zabbix server and web roles', () => {
  it.each(['zabbix_server', 'zabbix_web'])('%s accepts its public configuration and rejects private overrides', (role) => {
    expect(validateAnsibleTasks([{ 'ansible.builtin.include_role': { name: role }, vars: { [`${role}_db_password`]: '{{ ZABBIX_DB_PASSWORD }}' } }], { mode: 'resident' }).ok).toBe(true)
    expect(INCLUDE_ROLE_ALLOWED_VARS[role]).toBeDefined()
    expect(validateAnsibleTasks([{ 'ansible.builtin.include_role': { name: role }, vars: { [`${role}_repo_pkg`]: { changed: false } } }], { mode: 'resident' }).ok).toBe(false)
    expect(existsSync(path.join(roleDir, role, 'tasks/main.yml'))).toBe(true)
  })

  it.each(['zabbix_server_db_result', 'zabbix_web_health', 'zabbix_server_db_credentials'])('rejects reading or overwriting %s from recipe tasks', (name) => {
    expect(validateAnsibleTasks([{ 'ansible.builtin.debug': { msg: `{{ ${name} }}` } }], { mode: 'resident' }).ok).toBe(false)
    expect(validateAnsibleTasks([{ 'ansible.builtin.set_fact': { [name]: 'fake' } }], { mode: 'resident' }).ok).toBe(false)
  })

  it('requires local/external database validation before provisioning', () => {
    const tasks = load(readFileSync(path.join(roleDir, 'zabbix_server/tasks/main.yml'), 'utf8')) as Array<Record<string, any>>
    expect(tasks[0]['ansible.builtin.assert']).toBeDefined()
    expect(tasks[0].when).toBeUndefined()
    expect(JSON.stringify(tasks[0])).toContain("['local', 'external']")
  })
})
