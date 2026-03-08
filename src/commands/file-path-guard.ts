import { resolveAndValidatePath } from '../security'
import type { CommandResult } from '../types'

/**
 * resolveAndValidatePath + typeof チェックの共通ガード
 * ファイルパスの解決・検証を行い、成功時に handler を呼び出す
 */
export async function withValidatedPath(
  payload: { path?: unknown },
  handler: (filePath: string) => Promise<CommandResult>,
  defaultPath?: string,
): Promise<CommandResult> {
  const result = await resolveAndValidatePath(payload, defaultPath)
  if (typeof result !== 'string') return result
  return handler(result)
}
