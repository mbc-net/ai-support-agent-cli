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
