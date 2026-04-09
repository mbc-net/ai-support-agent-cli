import type { ProjectRegistration } from './types'

/** Internal map key that uniquely identifies a project across tenants */
export function projectKey(project: ProjectRegistration): string {
  return `${project.tenantCode}/${project.projectCode}`
}
