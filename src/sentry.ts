import { AGENT_VERSION } from './constants'
import { maskSecrets } from './logger'

type SentryModule = typeof import('@sentry/node')

let sentry: SentryModule | null = null

/**
 * Sentry を条件付きで初期化する。
 * SENTRY_DSN が設定されていない場合は何もしない（オプトイン方式）。
 */
export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    return
  }

  const Sentry = await import('@sentry/node')
  Sentry.init({
    dsn,
    release: `ai-support-agent-cli@${AGENT_VERSION}`,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.05,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => ({
          ...breadcrumb,
          message: breadcrumb.message ? maskSecrets(breadcrumb.message) : breadcrumb.message,
        }))
      }
      return event
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'http' && breadcrumb.data?.url) {
        breadcrumb.data.url = maskUrlTokens(breadcrumb.data.url as string)
      }
      return breadcrumb
    },
  })
  sentry = Sentry
}

/**
 * 例外を Sentry に報告する。未初期化時は no-op。
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return
  sentry.captureException(error, context ? { extra: context } : undefined)
}

/**
 * Sentry のイベントキューをフラッシュする。プロセス終了前に呼び出す。
 */
export async function flushSentry(): Promise<void> {
  if (!sentry) return
  await sentry.flush(2000)
}

/**
 * URL内のトークンパラメータをマスクする。
 */
function maskUrlTokens(url: string): string {
  return url.replace(
    /([?&](?:token|key|secret|password|authorization|credential)=)[^&]*/gi,
    '$1[Filtered]',
  )
}
