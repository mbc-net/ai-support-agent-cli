/** Internal map key that uniquely identifies a project across tenants */
export function projectKey(project: { tenantCode: string; projectCode: string }): string {
  return `${project.tenantCode}/${project.projectCode}`
}
