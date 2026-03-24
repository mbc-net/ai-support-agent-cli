/**
 * BrowserScriptExecutor — parses and executes Playwright scripts line-by-line.
 *
 * Supports a subset of Playwright commands that can be deterministically parsed
 * from generated scripts. Unsupported lines cause a parse failure, signaling
 * the caller to fall back to AI-based execution.
 */

import { logger } from '../logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserSession = any

export interface ScriptStepResult {
  line: string
  success: boolean
  error?: string
}

export interface ScriptExecutionResult {
  success: boolean
  completedSteps: number
  totalSteps: number
  results: ScriptStepResult[]
  failedLine?: string
  /** True when a line could not be parsed — caller should fall back to chat AI */
  fallbackToChat?: boolean
}

interface ParsedStep {
  type: 'goto' | 'click' | 'fill' | 'innerText' | 'type' | 'press' | 'scroll' | 'variable' | 'comment' | 'wait'
  raw: string
  args: Record<string, string>
}

/**
 * Parse a single script line into a structured step.
 * Returns null if the line cannot be parsed.
 */
function parseLine(line: string): ParsedStep | null {
  const trimmed = line.trim()

  // Empty lines and comments
  if (!trimmed || trimmed.startsWith('//')) {
    return { type: 'comment', raw: trimmed, args: {} }
  }

  // await page.goto('url'...)
  const gotoMatch = trimmed.match(/^await\s+page\.goto\(\s*'([^']+)'/m)
  if (gotoMatch) {
    return { type: 'goto', raw: trimmed, args: { url: gotoMatch[1] } }
  }

  // await page.click('selector')
  const clickMatch = trimmed.match(/^await\s+page\.click\(\s*'([^']+)'\s*\)/)
  if (clickMatch) {
    return { type: 'click', raw: trimmed, args: { selector: clickMatch[1] } }
  }

  // await page.fill('selector', 'value')
  const fillMatch = trimmed.match(/^await\s+page\.fill\(\s*'([^']+)'\s*,\s*'([^']*)'\s*\)/)
  if (fillMatch) {
    return { type: 'fill', raw: trimmed, args: { selector: fillMatch[1], value: fillMatch[2] } }
  }

  // const x = await page.locator('selector').innerText()
  const innerTextMatch = trimmed.match(/^const\s+(\S+)\s*=\s*await\s+page\.locator\(\s*'([^']+)'\s*\)\.innerText\(\s*\)/)
  if (innerTextMatch) {
    return { type: 'innerText', raw: trimmed, args: { variableName: innerTextMatch[1], selector: innerTextMatch[2] } }
  }

  // await page.keyboard.type('text')
  const typeMatch = trimmed.match(/^await\s+page\.keyboard\.type\(\s*'([^']*)'\s*\)/)
  if (typeMatch) {
    return { type: 'type', raw: trimmed, args: { text: typeMatch[1] } }
  }

  // await page.keyboard.press('key')
  const pressMatch = trimmed.match(/^await\s+page\.keyboard\.press\(\s*'([^']+)'\s*\)/)
  if (pressMatch) {
    return { type: 'press', raw: trimmed, args: { key: pressMatch[1] } }
  }

  // await page.mouse.wheel(deltaX, deltaY)
  const scrollMatch = trimmed.match(/^await\s+page\.mouse\.wheel\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/)
  if (scrollMatch) {
    return { type: 'scroll', raw: trimmed, args: { deltaX: scrollMatch[1], deltaY: scrollMatch[2] } }
  }

  // const x = 'value'
  const varMatch = trimmed.match(/^const\s+(\S+)\s*=\s*'([^']*)'/)
  if (varMatch) {
    return { type: 'variable', raw: trimmed, args: { name: varMatch[1], value: varMatch[2] } }
  }

  // await page.waitForTimeout(ms)
  const waitMatch = trimmed.match(/^await\s+page\.waitForTimeout\(\s*(\d+)\s*\)/)
  if (waitMatch) {
    return { type: 'wait', raw: trimmed, args: { ms: waitMatch[1] } }
  }

  // Unrecognized line
  return null
}

/**
 * Execute a Playwright script against a browser session.
 */
export async function executePlaywrightScript(
  session: BrowserSession,
  script: string,
  onStepComplete?: (step: number, total: number, line: string) => void,
): Promise<ScriptExecutionResult> {
  const lines = script.split('\n').filter((l) => l.trim().length > 0)
  const results: ScriptStepResult[] = []

  // Parse all lines first to detect unsupported commands
  const steps: (ParsedStep | null)[] = lines.map(parseLine)

  // Check for unparseable lines first
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] === null) {
      const executableSteps = steps.filter((s) => s !== null && s.type !== 'comment')
      return {
        success: false,
        completedSteps: 0,
        totalSteps: executableSteps.length,
        results: [],
        failedLine: lines[i],
        fallbackToChat: true,
      }
    }
  }

  // Filter out comments for step counting
  const executableSteps = steps.filter((s) => s !== null && s.type !== 'comment')
  const totalSteps = executableSteps.length

  if (totalSteps === 0) {
    return { success: true, completedSteps: 0, totalSteps: 0, results: [] }
  }

  let completedSteps = 0
  const page = await session.getPage()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!

    if (step.type === 'comment') {
      continue
    }

    try {
      switch (step.type) {
        case 'goto':
          await page.goto(step.args.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
          session.actionLog.add('chat', 'navigate', step.args.url)
          break
        case 'click':
          await page.click(step.args.selector, { timeout: 10000 })
          session.actionLog.add('chat', 'click', step.args.selector)
          break
        case 'fill':
          await page.fill(step.args.selector, step.args.value, { timeout: 10000 })
          session.actionLog.add('chat', 'fill', `${step.args.selector} "${step.args.value}"`)
          break
        case 'innerText': {
          const text: string = await page.locator(step.args.selector).innerText({ timeout: 10000 })
          session.variables.set(step.args.variableName, text)
          const preview = text.replace(/\s+/g, ' ').trim()
          const previewText = preview.length > 100 ? preview.substring(0, 100) + '…' : preview
          session.actionLog.add('chat', 'extract', `${step.args.variableName} "${step.args.selector}" → "${previewText}"`)
          break
        }
        case 'type':
          await page.keyboard.type(step.args.text)
          session.actionLog.add('chat', 'type', step.args.text)
          break
        case 'press':
          await page.keyboard.press(step.args.key)
          session.actionLog.add('chat', 'press', step.args.key)
          break
        case 'scroll':
          await page.mouse.wheel(parseInt(step.args.deltaX, 10), parseInt(step.args.deltaY, 10))
          session.actionLog.add('chat', 'scroll', `deltaX=${step.args.deltaX} deltaY=${step.args.deltaY}`)
          break
        case 'variable':
          session.variables.set(step.args.name, step.args.value)
          session.actionLog.add('chat', 'set_variable', `${step.args.name} "${step.args.value}"`)
          break
        case 'wait': {
          const ms = Math.min(parseInt(step.args.ms, 10), 10000)
          await page.waitForTimeout(ms)
          break
        }
      }

      completedSteps++
      results.push({ line: step.raw, success: true })
      onStepComplete?.(completedSteps, totalSteps, step.raw)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.warn(`[script-executor] Step failed: ${step.raw} — ${errorMessage}`)
      results.push({ line: step.raw, success: false, error: errorMessage })

      return {
        success: false,
        completedSteps,
        totalSteps,
        results,
        failedLine: step.raw,
      }
    }
  }

  return {
    success: true,
    completedSteps,
    totalSteps,
    results,
  }
}
