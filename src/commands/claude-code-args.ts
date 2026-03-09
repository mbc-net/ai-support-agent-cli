import os from 'os'

/** CLAUDECODE / CLAUDE_CODE_* 環境変数を除外した env を構築
 *  ただし CLAUDE_CODE_OAUTH_TOKEN は認証に必要なため保持する
 *  プロセス生存中は結果不変のためキャッシュする */
let cachedCleanEnv: Record<string, string> | null = null

export function buildCleanEnv(): Record<string, string> {
  if (cachedCleanEnv) return { ...cachedCleanEnv }
  const cleanEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN')) continue
    if (value !== undefined) cleanEnv[key] = value
  }
  cachedCleanEnv = cleanEnv
  return { ...cleanEnv }
}

/** テスト用のキャッシュリセット */
export function _resetCleanEnvCache(): void {
  cachedCleanEnv = null
}

/** Claude CLI の引数配列を構築 */
export function buildClaudeArgs(
  message: string,
  options?: {
    allowedTools?: string[]
    addDirs?: string[]
    locale?: string
    mcpConfigPath?: string
    systemPrompt?: string
  },
): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (options?.allowedTools?.length) {
    for (const tool of options.allowedTools) {
      args.push('--allowedTools', tool)
    }
  }
  if (options?.addDirs?.length) {
    for (const dir of options.addDirs) {
      const resolved = dir.replace(/^~/, os.homedir())
      args.push('--add-dir', resolved)
    }
  }
  if (options?.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath)
  }
  // システムプロンプトを構築: 言語設定 + サーバー設定 + file_upload 指示
  const promptParts: string[] = []
  if (options?.locale) {
    promptParts.push(options.locale === 'ja'
      ? 'Always respond in Japanese. Use Japanese for all explanations and communications.'
      : 'Always respond in English. Use English for all explanations and communications.')
  }
  if (options?.systemPrompt) {
    promptParts.push(options.systemPrompt)
  }
  if (options?.mcpConfigPath) {
    promptParts.push([
      'CRITICAL FILE DELIVERY RULE:',
      'When you create or modify a file using the Write tool, the user CANNOT see or download the file unless you upload it.',
      'You MUST call the mcp__ai-support-agent__file_upload tool AFTER every Write tool call.',
      'Required parameters for file_upload:',
      '- filePath: the absolute path of the file you just wrote',
      '- filename: the display name (e.g., "mbc-logo.svg")',
      '- conversationId: from <message_metadata> in the user message',
      '- messageId: from <message_metadata> in the user message',
      '- projectCode: from <message_metadata> in the user message',
      'If you skip the upload, the file is invisible to the user. Always upload.',
    ].join('\n'))
  }
  if (promptParts.length > 0) {
    args.push('--append-system-prompt', promptParts.join('\n\n'))
  }
  args.push(message)
  return args
}
