import { inspectSentryTasks, SENTRY_CAPABILITY } from '../../src/server-setup/sentry-policy'
import { load } from 'js-yaml'
const parse = (body: string) => load(body) as Record<string, unknown>[]
describe('Sentry execution policy', () => {
  it('does not mistake comments or task names for a Sentry role', () => {
    expect(inspectSentryTasks(parse('- name: sentry\n  debug: {msg: sentry}'))).toBeNull()
  })
  it('identifies the literal role and defaults to install', () => {
    expect(inspectSentryTasks(parse('- include_role: {name: sentry}'))).toEqual({operation: 'install'})
    expect(SENTRY_CAPABILITY).toBe('server_setup_sentry_v1')
  })
  it('requires recovery to run alone before other host mutations', () => {
    expect(() => inspectSentryTasks(parse('- include_role: {name: docker}\n- include_role: {name: sentry}\n  vars: {sentry_operation: diagnose}'))).toThrow(/alone/)
  })
  it('rejects templated operations and duplicate installs', () => {
    expect(() => inspectSentryTasks(parse('- include_role: {name: sentry}\n  vars: {sentry_operation: "{{ OP }}"}'))).toThrow(/literal/)
    expect(() => inspectSentryTasks(parse('- include_role: {name: sentry}\n- include_role: {name: sentry}'))).toThrow(/once/)
  })
})
