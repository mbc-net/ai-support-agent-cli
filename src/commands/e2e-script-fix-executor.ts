/**
 * E2EScriptFixExecutor — uses an LLM to update a failing Playwright script.
 *
 * Receives the current script and a fix instruction from the E2E test editor chat,
 * asks the LLM to produce a revised script, and saves it via the API.
 */

import type { ApiClient } from '../api-client'
import { logger } from '../logger'
import type { AgentChatMode, AgentServerConfig, CommandResult, ProjectConfigResponse } from '../types'
import { errorResult, successResult } from '../types/command'
import { parseString, toErrorMessage } from '../utils'

import { executeChatCommand } from './chat-executor'

export interface E2eScriptFixPayload {
  testCaseId?: unknown
  message?: unknown
  currentScript?: unknown
}

export interface ExecuteE2eScriptFixOptions {
  payload: E2eScriptFixPayload
  client: ApiClient
  tenantCode?: string
  projectCode?: string
  agentId?: string
  commandId?: string
  serverConfig?: AgentServerConfig
  activeChatMode?: AgentChatMode
  availableChatModes?: AgentChatMode[]
  projectDir?: string
  projectConfig?: ProjectConfigResponse
  mcpConfigPath?: string
  browserLocalPort?: number
}

/**
 * Build a prompt that asks the LLM to revise a Playwright script based on the user's instruction.
 */
function buildScriptFixPrompt(currentScript: string, message: string): string {
  return [
    '# Playwright スクリプト修正依頼',
    '',
    '以下の修正指示に従って、Playwright テストスクリプトを修正してください。',
    '',
    '## 修正指示',
    message,
    '',
    '## 現在のスクリプト',
    '```typescript',
    currentScript,
    '```',
    '',
    '## 出力形式',
    '修正後のスクリプト全体を ```typescript...``` コードブロックで囲んで出力してください。',
    '説明や他のテキストは不要です。コードブロックのみを出力してください。',
  ].join('\n')
}

/**
 * Extract a TypeScript/JavaScript code block from an LLM response string.
 * Returns null if no code block is found.
 */
export function extractScriptFromResponse(response: string): string | null {
  // Try to extract from a fenced code block (typescript, javascript, playwright, or bare)
  const codeBlockMatch = response.match(
    /```(?:typescript|javascript|playwright|ts|js)?\n([\s\S]*?)```/,
  )
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim()
  }

  // If the response itself looks like a script, return it
  if (response.includes('await page.')) {
    return response.trim()
  }

  return null
}

/**
 * Execute an E2E script fix command.
 *
 * Combines the current Playwright script with the user's fix instruction,
 * sends it to the LLM, extracts the revised script, and saves it via the API.
 */
export async function executeE2eScriptFix(
  options: ExecuteE2eScriptFixOptions,
): Promise<CommandResult> {
  const { payload, client, tenantCode, agentId } = options
  const projectCode =
    options.projectCode ?? options.projectConfig?.project?.projectCode

  const testCaseId = parseString(payload.testCaseId) ?? undefined
  const message = parseString(payload.message)
  const currentScript = parseString(payload.currentScript)

  if (!message) {
    return errorResult('message is required for e2e_script_fix')
  }
  if (!currentScript) {
    return errorResult('currentScript is required for e2e_script_fix')
  }
  if (!testCaseId) {
    return errorResult('testCaseId is required for e2e_script_fix')
  }

  logger.info(`[e2e_script_fix] Fixing script for testCase=${testCaseId}`)

  const prompt = buildScriptFixPrompt(currentScript, message)

  const commandId = options.commandId ?? `e2e-script-fix-${testCaseId}`

  let chatResult: CommandResult
  try {
    chatResult = await executeChatCommand({
      payload: { message: prompt },
      commandId,
      client,
      serverConfig: options.serverConfig,
      activeChatMode: options.activeChatMode,
      availableChatModes: options.availableChatModes,
      agentId,
      projectDir: options.projectDir,
      projectConfig: options.projectConfig,
      mcpConfigPath: options.mcpConfigPath,
      tenantCode,
      browserLocalPort: options.browserLocalPort,
    })
  } catch (err: unknown) {
    const errorMessage = toErrorMessage(err)
    logger.error(`[e2e_script_fix] Chat execution failed: ${errorMessage}`)
    return errorResult(`Script fix chat failed: ${errorMessage}`)
  }

  if (!chatResult.success) {
    return errorResult(`Script fix chat returned failure: ${chatResult.error}`)
  }

  // Extract the updated script from the LLM response
  const responseText = typeof chatResult.data === 'string' ? chatResult.data : null
  const updatedScript = responseText ? extractScriptFromResponse(responseText) : null

  if (!updatedScript) {
    logger.warn('[e2e_script_fix] Could not extract updated script from LLM response')
    return errorResult('Could not extract updated script from LLM response')
  }

  // Save the updated script via the API
  if (tenantCode && projectCode) {
    try {
      await client.updateE2eTestScript(tenantCode, projectCode, testCaseId, {
        playwrightScript: updatedScript,
        testCaseId,
      })
      logger.info(`[e2e_script_fix] Updated script saved for testCase=${testCaseId}`)
    } catch (err: unknown) {
      logger.warn(`[e2e_script_fix] Failed to save updated script: ${toErrorMessage(err)}`)
      // Return success with the script even if save failed — caller can retry
    }
  } else {
    logger.warn('[e2e_script_fix] tenantCode/projectCode not available, skipping script save')
  }

  return successResult({
    testCaseId,
    updatedScript,
  })
}
