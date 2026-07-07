import { execFile } from 'child_process'

import { CLAUDE_DETECT_TIMEOUT_MS, CODEX_DETECT_TIMEOUT_MS } from './constants'
import { logger } from './logger'
import type { AgentChatMode } from './types'
import { resolveCodexInvocation } from './commands/codex-command'

/**
 * 利用可能なチャットモードを検出する
 * - claude CLI の存在確認（5秒タイムアウト）
 * - codex CLI の存在確認（5秒タイムアウト）
 * - ANTHROPIC_API_KEY 環境変数の存在確認
 */
export async function detectAvailableChatModes(): Promise<AgentChatMode[]> {
  const modes: AgentChatMode[] = []

  // Claude Code CLI の検出
  const claudeAvailable = await isClaudeCodeAvailable()
  if (claudeAvailable) {
    modes.push('claude_code')
  }

  // Codex CLI の検出
  const codexAvailable = await isCodexAvailable()
  if (codexAvailable) {
    modes.push('codex')
  }

  // Anthropic API Key の検出
  if (process.env.ANTHROPIC_API_KEY) {
    modes.push('api')
  }

  logger.debug(`[chat-mode-detector] Available modes: ${JSON.stringify(modes)}`)
  return modes
}

/**
 * アクティブなチャットモードを決定する
 *
 * 優先順位:
 * 1. ローカル設定（config.json の agentChatMode）
 * 2. サーバー設定（defaultAgentChatMode）
 * 3. 自動検出（claude_code → codex 優先）
 *
 * 指定されたモードが利用不可の場合は利用可能なモードにフォールバック
 */
export function resolveActiveChatMode(
  available: AgentChatMode[],
  localOverride?: AgentChatMode,
  serverDefault?: AgentChatMode,
): AgentChatMode | undefined {
  if (available.length === 0) {
    logger.warn('[chat-mode-detector] No chat modes available')
    return undefined
  }

  // 1. ローカル設定
  if (localOverride && available.includes(localOverride)) {
    logger.debug(`[chat-mode-detector] Using local override: ${localOverride}`)
    return localOverride
  }
  if (localOverride) {
    logger.warn(
      `[chat-mode-detector] Local override "${localOverride}" not available, falling back`,
    )
  }

  // 2. サーバー設定
  if (serverDefault && available.includes(serverDefault)) {
    logger.debug(`[chat-mode-detector] Using server default: ${serverDefault}`)
    return serverDefault
  }
  if (serverDefault) {
    logger.warn(
      `[chat-mode-detector] Server default "${serverDefault}" not available, falling back`,
    )
  }

  // 3. 自動検出（既存互換のため claude_code を最優先し、次に codex）
  const resolved = available.includes('claude_code')
    ? 'claude_code'
    : (available.includes('codex') ? 'codex' : available[0])
  logger.debug(`[chat-mode-detector] Auto-detected: ${resolved}`)
  return resolved
}

/**
 * Claude Code CLI が利用可能かチェックする
 */
async function isClaudeCodeAvailable(): Promise<boolean> {
  return isCommandAvailable('claude', ['--version'], CLAUDE_DETECT_TIMEOUT_MS)
}

/**
 * Codex CLI が利用可能かチェックする
 */
async function isCodexAvailable(): Promise<boolean> {
  const invocation = resolveCodexInvocation()
  return isCommandAvailable(invocation.command, [...invocation.argsPrefix, '--version'], CODEX_DETECT_TIMEOUT_MS)
}

async function isCommandAvailable(command: string, args: string[], timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = execFile(
        command,
        args,
        { timeout },
        (error) => {
          resolve(!error)
        },
      )
      child.on('error', () => {
        resolve(false)
      })
    } catch {
      resolve(false)
    }
  })
}
