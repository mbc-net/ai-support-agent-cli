import os from 'os'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

import { CHAT_SIGKILL_DELAY, CHAT_TIMEOUT, ERR_CODEX_CLI_NOT_FOUND, LOG_DEBUG_LIMIT } from '../constants'
import { logger } from '../logger'
import type { ChatChunkType } from '../types'
import { createActivityTimeout } from '../utils/activity-timeout'
import { StreamLineParser } from '../utils/stream-parser'
import { isErrnoException } from '../utils'

import { buildCleanEnv } from './claude-code-args'
import { resolveCodexInvocation } from './codex-command'
import type { PolicyContext } from './claude-code-runner'

export interface CodexResult {
  text: string
  metadata: {
    args: string[]
    exitCode: number | null
    hasStderr: boolean
    durationMs: number
  }
}

export interface CodexHandle {
  result: Promise<CodexResult>
  cancel: () => void
}

export interface RunCodexOptions {
  message: string
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>
  addDirs?: string[]
  locale?: string
  awsEnv?: Record<string, string>
  cwd?: string
  systemPrompt?: string
  model?: string
  policyContext?: PolicyContext
  envVarsOverride?: Record<string, string>
}

export function buildCodexArgs(
  message: string,
  options?: {
    addDirs?: string[]
    locale?: string
    cwd?: string
    systemPrompt?: string
    model?: string
    outputLastMessagePath?: string
  },
): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write']
  if (options?.cwd) args.push('--cd', options.cwd)
  if (options?.model?.trim()) args.push('--model', options.model.trim())
  if (options?.outputLastMessagePath) args.push('--output-last-message', options.outputLastMessagePath)
  if (options?.addDirs?.length) {
    for (const dir of options.addDirs) {
      args.push('--add-dir', dir.replace(/^~/, os.homedir()))
    }
  }
  args.push(buildCodexPrompt(message, options?.locale, options?.systemPrompt))
  return args
}

function buildCodexPrompt(message: string, locale?: string, systemPrompt?: string): string {
  const promptParts: string[] = []
  if (locale) {
    promptParts.push(locale === 'ja'
      ? 'Always respond in Japanese. Use Japanese for all explanations and communications.'
      : 'Always respond in English. Use English for all explanations and communications.')
  }
  if (systemPrompt) promptParts.push(systemPrompt)
  promptParts.push(message)
  return promptParts.join('\n\n')
}

export function runCodex(options: RunCodexOptions): CodexHandle {
  const { message, sendChunk, addDirs, locale, awsEnv, cwd, systemPrompt, model, policyContext, envVarsOverride } = options
  let killFn: () => void = () => { /* noop until child is spawned */ }

  const result = new Promise<CodexResult>((resolve, reject) => {
    const startTime = Date.now()
    const cleanEnv = buildCleanEnv()
    const env: Record<string, string> = awsEnv ? { ...cleanEnv, ...awsEnv } : { ...cleanEnv }

    if (policyContext) {
      if (policyContext.tenantCode) env.AI_SUPPORT_TENANT_CODE = policyContext.tenantCode
      if (policyContext.projectCode) env.AI_SUPPORT_PROJECT_CODE = policyContext.projectCode
      if (policyContext.conversationId) env.AI_SUPPORT_CONVERSATION_ID = policyContext.conversationId
      if (policyContext.browserSessionId) env.AI_SUPPORT_BROWSER_SESSION_ID = policyContext.browserSessionId
      if (policyContext.browserLocalPort) env.AI_SUPPORT_BROWSER_LOCAL_PORT = String(policyContext.browserLocalPort)
      if (policyContext.e2eExecutionId) env.AI_SUPPORT_E2E_EXECUTION_ID = policyContext.e2eExecutionId
      if (policyContext.e2eTestCaseId) env.AI_SUPPORT_E2E_TEST_CASE_ID = policyContext.e2eTestCaseId
    }

    if (envVarsOverride) {
      for (const [key, value] of Object.entries(envVarsOverride)) {
        if (typeof value !== 'string' || value === '') continue
        env[key] = value
      }
    }

    const resolvedModel = model?.trim() || env.OPENAI_MODEL?.trim() || undefined
    const outputLastMessagePath = createOutputLastMessagePath()
    const codexInvocation = resolveCodexInvocation()
    const codexArgs = buildCodexArgs(message, { addDirs, locale, cwd, systemPrompt, model: resolvedModel, outputLastMessagePath })
    const args = [...codexInvocation.argsPrefix, ...codexArgs]
    logger.debug(`[chat] Spawning codex CLI: codex ${args.slice(0, -1).join(' ')}`)

    const child = spawn(codexInvocation.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...(cwd ? { cwd } : {}),
    })

    killFn = () => {
      if (child.killed) return
      logger.info(`[chat] Killing codex CLI process (pid=${child.pid})`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) {
          logger.warn(`[chat] codex CLI still running after SIGTERM, sending SIGKILL (pid=${child.pid})`)
          child.kill('SIGKILL')
        }
      }, CHAT_SIGKILL_DELAY)
    }

    let resultText = ''
    let sentTextLength = 0
    let hasStderr = false
    let sigkillTimer: NodeJS.Timeout | undefined
    const streamParser = new StreamLineParser()
    const activityTimeout = createActivityTimeout(CHAT_TIMEOUT, () => {
      logger.warn(`[chat] codex CLI timed out (pid=${child.pid}), sending SIGTERM`)
      child.kill('SIGTERM')
      sigkillTimer = setTimeout(() => {
        if (!child.killed) {
          logger.warn(`[chat] codex CLI still running after SIGTERM, sending SIGKILL (pid=${child.pid})`)
          child.kill('SIGKILL')
        }
      }, CHAT_SIGKILL_DELAY)
    })

    const updateText = (nextText: string): void => {
      if (nextText.length <= sentTextLength) {
        resultText = nextText || resultText
        return
      }
      const delta = nextText.slice(sentTextLength)
      sentTextLength = nextText.length
      resultText = nextText
      void sendChunk('delta', delta)
    }

    const appendDelta = (delta: string): void => {
      if (!delta) return
      resultText += delta
      sentTextLength = resultText.length
      void sendChunk('delta', delta)
    }

    child.stdout.on('data', (data: Buffer) => {
      activityTimeout.reset()
      streamParser.push(data.toString(), (line) => {
        const event = parseCodexEvent(line)
        if (!event) return
        const textEvent = extractCodexText(event)
        if (!textEvent) return
        if (textEvent.kind === 'delta') appendDelta(textEvent.text)
        else updateText(textEvent.text)
      })
    })

    child.stderr.on('data', (data: Buffer) => {
      hasStderr = true
      logger.debug(`[chat] codex CLI stderr: ${data.toString().substring(0, LOG_DEBUG_LIMIT)}`)
    })

    child.on('error', (error) => {
      activityTimeout.clear()
      if (sigkillTimer) clearTimeout(sigkillTimer)
      cleanupOutputLastMessage(outputLastMessagePath)
      if (isErrnoException(error, 'ENOENT')) {
        reject(new Error(ERR_CODEX_CLI_NOT_FOUND))
      } else {
        reject(error)
      }
    })

    child.on('close', (code) => {
      activityTimeout.clear()
      if (sigkillTimer) clearTimeout(sigkillTimer)
      const durationMs = Date.now() - startTime
      const metadataArgs = args.slice(0, -1)
      const finalText = readOutputLastMessage(outputLastMessagePath)
      if (finalText && finalText !== resultText) {
        updateText(finalText)
      }
      cleanupOutputLastMessage(outputLastMessagePath)
      logger.debug(`[chat] codex CLI exited (pid=${child.pid}, code=${code}, duration=${durationMs}ms)`)
      if (code === 0) {
        resolve({
          text: resultText,
          metadata: {
            args: metadataArgs,
            exitCode: code,
            hasStderr,
            durationMs,
          },
        })
      } else {
        reject(new Error(`codex CLI がコード ${code} で終了しました`))
      }
    })
  })

  return { result, cancel: () => killFn() }
}

function createOutputLastMessagePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-support-agent-codex-'))
  return path.join(dir, 'last-message.txt')
}

function readOutputLastMessage(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined
    return fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    logger.debug(`[chat] Failed to read codex last message: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function cleanupOutputLastMessage(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true })
  } catch (error) {
    logger.debug(`[chat] Failed to remove codex last message temp dir: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseCodexEvent(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    logger.debug(`[chat] Ignoring non-JSON codex output: ${line.substring(0, LOG_DEBUG_LIMIT)}`)
    return undefined
  }
}

function extractCodexText(event: Record<string, unknown>): { kind: 'delta' | 'full'; text: string } | undefined {
  const direct = pickText(event)
  if (direct && isAssistantTextEvent(event)) return direct

  const item = event.item
  if (item && typeof item === 'object') {
    const itemText = pickText(item as Record<string, unknown>)
    if (itemText && isAssistantTextEvent(item as Record<string, unknown>)) return itemText
  }

  const msg = event.msg
  if (msg && typeof msg === 'object') {
    const msgText = pickText(msg as Record<string, unknown>)
    if (msgText && isAssistantTextEvent(msg as Record<string, unknown>)) return msgText
  }

  return undefined
}

function pickText(value: Record<string, unknown>): { kind: 'delta' | 'full'; text: string } | undefined {
  const delta = value.delta
  if (typeof delta === 'string') return { kind: 'delta', text: delta }
  for (const key of ['message', 'content', 'text']) {
    const candidate = value[key]
    if (typeof candidate === 'string') return { kind: 'full', text: candidate }
  }
  return undefined
}

function isAssistantTextEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === 'string' ? event.type : ''
  const role = typeof event.role === 'string' ? event.role : ''
  if (role && role !== 'assistant') return false
  if (!type) return true
  return type.includes('message') || type.includes('delta') || type.includes('response') || type.includes('output')
}
