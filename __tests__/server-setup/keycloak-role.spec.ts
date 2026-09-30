import { readFileSync } from 'fs'
import { join } from 'path'
import { load } from 'js-yaml'

type Task = Record<string, unknown> & {
  name?: string
  register?: string
  'ansible.builtin.import_role'?: { name: string }
  'ansible.builtin.template'?: { mode: string }
  'ansible.builtin.uri'?: { validate_certs: boolean }
}

const role = join(__dirname, '../../ansible/roles/keycloak')
const read = (file: string) => readFileSync(join(role, file), 'utf8')

describe('Keycloak deployment safeguards', () => {
  it('keeps PostgreSQL private, persistent and healthy before starting Keycloak', () => {
    const template = read('templates/compose.yml.j2')
    expect(template).toContain('127.0.0.1:')
    expect(template).toContain('postgres-data:/var/lib/postgresql/data')
    expect(template).toContain('condition: service_healthy')
    const postgres = template.split('  postgres:')[1].split('  keycloak:')[0]
    expect(postgres).not.toContain('ports:')
    expect(template).toContain('/health/ready')
    expect(template).toContain('KC_PROXY_TRUSTED_ADDRESSES')
    expect(template).toContain('KCRAW_DB_PASSWORD:')
    expect(template).toContain('KCRAW_BOOTSTRAP_ADMIN_PASSWORD:')
    expect(template).not.toContain('      KC_DB_PASSWORD:')
    expect(template).not.toContain('start-dev')
  })

  it('validates before installing Docker and protects secret files', () => {
    const tasks = load(read('tasks/main.yml')) as Task[]
    expect(tasks[0]['ansible.builtin.assert']).toBeDefined()
    const install = tasks.findIndex(t => t['ansible.builtin.import_role']?.name === 'docker')
    expect(install).toBeGreaterThan(0)
    const config = tasks.find(t => t['ansible.builtin.template'])!
    expect(config['ansible.builtin.template']?.mode).toBe('0600')
    expect(config.no_log).toBe(true)
    expect(config.diff).toBe(false)
    const databaseCheck = tasks.find(t => t.name === 'keycloak : Verify database credentials')!
    expect(databaseCheck).toBeDefined()
    expect(JSON.stringify(databaseCheck)).toContain('--host=postgres')
    expect(JSON.stringify(databaseCheck)).not.toContain('--host=127.0.0.1')
    const publicCheck = tasks.find(t => t.register === 'keycloak_public_result')!
    expect(publicCheck['ansible.builtin.uri']?.validate_certs).toBe(true)
    expect(read('tasks/main.yml')).not.toContain('down --volumes')
  })
})
