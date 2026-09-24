/**
 * Internal map key that uniquely identifies a project across tenants.
 *
 * Used as the key for every in-process map keyed by project: the child-process
 * table, the config watcher's diff, the docker supervisor's per-project agent
 * ids, and the service installers' collision detection.
 *
 * :::danger
 * **The installer's collision detection depends on producers and consumers
 * agreeing.** `detectInstallCollisions` (wrapper-helpers) builds the map keyed
 * by this value, and the three service installers look entries up with a key
 * they build themselves. If the two ever diverge, `collisions.get(...)` simply
 * misses and **every colliding project installs silently**, overwriting each
 * other's unit file — no error, no log. That is why all of them go through
 * this one function.
 * :::
 *
 * Not to be confused with the `<tenant>#<project>` string in
 * `docker/project-image-builder.ts`: that one only picks a log colour and is
 * deliberately a different shape.
 */
export function projectKey(project: { tenantCode: string; projectCode: string }): string {
  return `${project.tenantCode}/${project.projectCode}`
}
