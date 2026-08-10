/**
 * Token parsing utilities
 *
 * Token format: {tenantCode}:{tokenId}:{rawToken}
 * - tenantCode: identifies the tenant (e.g. "mbc")
 * - tokenId: used as agentId in the API, prevents duplicate entries on container restart
 * - rawToken: the actual authentication token
 */

export interface ParsedToken {
  tenantCode: string
  tokenId: string
  rawToken: string
}

/**
 * Build an HTTP `Authorization` header value for a bearer token.
 * Consolidates the repeated `` `Bearer ${token}` `` template literal.
 */
export function bearerHeader(token: string): string {
  return `Bearer ${token}`
}

/**
 * Parse a token string into its components.
 * Returns null if the token does not match the expected 3-part format.
 */
export function parseToken(token: string): ParsedToken | null {
  const parts = token.split(':')
  if (parts.length !== 3) return null
  const [tenantCode, tokenId, rawToken] = parts
  if (!tenantCode || !tokenId || !rawToken) return null
  return { tenantCode, tokenId, rawToken }
}

/**
 * Extract the tokenId (index[1]) from a token string.
 * Returns undefined if the token does not have exactly 3 colon-separated parts.
 * Note: the tokenId may be an empty string if the middle part is empty.
 */
export function extractTokenId(token: string): string | undefined {
  const parts = token.split(':')
  return parts.length === 3 ? parts[1] : undefined
}

/**
 * Extract the tenantCode (index[0]) from a token string.
 * Returns an empty string if the token does not match the expected format.
 */
export function extractTenantCodeFromToken(token: string): string {
  const parts = token.split(':')
  return parts.length >= 3 ? parts[0] : ''
}

/**
 * Resolution result for a direct `start --token ... [--project ...]` invocation.
 */
export type DirectStartTargetResult =
  | { ok: true; tenantCode: string; projectCode: string }
  | { ok: false; reason: 'invalid-project-format' }
  | { ok: false; reason: 'tenant-mismatch'; tokenTenantCode: string; projectTenantCode: string }

/**
 * Resolve the tenant/project target for a direct `start` without browser OAuth.
 *
 * Both agent tokens and agent-scoped Personal Access Tokens (PAT) share the
 * `{tenantCode}:{tokenId}:{rawToken}` format, so the tenantCode is always derived
 * from the token itself:
 *
 * - Without `--project`: the caller-supplied fallback is used (legacy CLI-direct
 *   mode where the server resolves the project from the token).
 * - With `--project "tenantCode/projectCode"`: tenantCode/projectCode come from the
 *   flag. The flag's tenantCode must match the tenantCode embedded in the token; a
 *   mismatch is rejected so a PAT issued for one tenant cannot be pointed at another.
 *   When the token carries no embedded tenantCode (non-standard token), the flag's
 *   tenantCode is trusted as-is.
 */
export function resolveDirectStartTarget(
  token: string,
  project: string | undefined,
  fallback: { tenantCode: string; projectCode: string },
): DirectStartTargetResult {
  if (!project) {
    return { ok: true, tenantCode: fallback.tenantCode, projectCode: fallback.projectCode }
  }

  const slashIdx = project.indexOf('/')
  // Reject when there is no separator, an empty tenantCode, or an empty projectCode.
  if (slashIdx <= 0 || slashIdx === project.length - 1) {
    return { ok: false, reason: 'invalid-project-format' }
  }

  const projectTenantCode = project.substring(0, slashIdx)
  const projectCode = project.substring(slashIdx + 1)
  const tokenTenantCode = extractTenantCodeFromToken(token)

  if (tokenTenantCode && tokenTenantCode !== projectTenantCode) {
    return { ok: false, reason: 'tenant-mismatch', tokenTenantCode, projectTenantCode }
  }

  return { ok: true, tenantCode: projectTenantCode, projectCode }
}

/**
 * `--project` フラグ等の `"tenantCode/projectCode"` 文字列を最初の `/` で分割する。
 * `/` が無い場合は null を返す（呼び出し元がデフォルト/エラーの分岐を持つ）。
 */
export function splitProjectRef(
  ref: string,
): { tenantCode: string; projectCode: string } | null {
  const slashIdx = ref.indexOf('/')
  if (slashIdx < 0) return null
  return {
    tenantCode: ref.substring(0, slashIdx),
    projectCode: ref.substring(slashIdx + 1),
  }
}
