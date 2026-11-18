import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import * as path from 'path'

import { load } from 'js-yaml'

const role = path.join(__dirname, '../../ansible/roles/cloudfront_sync')

/** Runtime installer failures run as Python tests; YAML assertions only check wiring. */
describe('cloudfront_sync bundled role', () => {
  it('runs update safety and rollback tests', () => {
    expect(() => execFileSync(process.env.PYTHON ?? 'python3', [
      '-m', 'unittest', 'discover', '-s', path.join(role, 'files/tests'),
      '-p', 'test_install_cloudfront_sync.py',
    ], { encoding: 'utf8', stdio: 'pipe' })).not.toThrow()
  })

  it('defaults to plan-only and no timer, and exposes only the approved variables', () => {
    const defaults = load(readFileSync(path.join(role, 'defaults/main.yml'), 'utf8')) as Record<string, unknown>
    expect(defaults.cloudfront_sync_timer_enabled).toBe(false)
    expect(defaults.cloudfront_sync_approve_token).toBe('')
    expect(defaults.cloudfront_sync_ports).toEqual([443])
    expect(Object.keys(defaults)).toHaveLength(11)
    expect(Object.keys(defaults).every(key => key.startsWith('cloudfront_sync_'))).toBe(true)
  })

  it('uses one trusted installer and passes approvals on stdin, never in a shell', () => {
    const source = readFileSync(path.join(role, 'tasks/main.yml'), 'utf8')
    const tasks = load(source) as Record<string, unknown>[]
    expect(tasks[0]['ansible.builtin.assert']).toBeDefined()
    expect(tasks[0].when).toBeUndefined()
    expect(source).toContain('install_cloudfront_sync.py')
    expect(source).toContain('stdin:')
    expect(source).not.toContain('ansible.builtin.shell')
    expect(source).toContain('not ansible_check_mode')
  })

  it('ships randomized persistent hourly scheduling and root-only service execution', () => {
    const timer = readFileSync(path.join(role, 'templates/cloudfront-sync.timer.j2'), 'utf8')
    const service = readFileSync(path.join(role, 'templates/cloudfront-sync.service.j2'), 'utf8')
    expect(timer).toContain('OnCalendar=hourly')
    expect(timer).toContain('RandomizedDelaySec=15min')
    expect(timer).toContain('Persistent=true')
    expect(service).toContain('User=root')
    expect(service).toContain('UMask=0077')
    expect(service).toContain('--config /etc/cloudfront-sync/config.json sync')
  })

  it('ships opt-in Zabbix monitoring without exposing private state', () => {
    const template = JSON.parse(readFileSync(path.join(role, 'files/zabbix-template.json'), 'utf8'))
    const text = JSON.stringify(template)
    expect(text).toContain('/var/lib/cloudfront-sync/status.json')
    expect(text).not.toContain('/private/')
    expect(template.zabbix_export.triggers).toHaveLength(5)
    const uuids = Array.from(text.matchAll(/\"uuid\":\"([0-9a-f]+)\"/g), match => match[1])
    expect(uuids.length).toBeGreaterThan(10)
    expect(uuids.every(value => /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(value))).toBe(true)
    expect(template.zabbix_export.templates[0].macros[0].value).toBe('0')
  })
})
