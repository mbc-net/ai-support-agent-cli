import { MIN_INTERVAL, MAX_INTERVAL } from '../constants'
import { t } from '../i18n'
import type { ReleaseChannel } from '../types'
import { exitWithError } from '../utils'

export function parseIntervalOrExit(value: string, name: string): number {
  const parsed = parseInt(value, 10)
  if (isNaN(parsed) || parsed < MIN_INTERVAL || parsed > MAX_INTERVAL) {
    exitWithError(t('config.invalidInterval', { name, value, min: MIN_INTERVAL, max: MAX_INTERVAL }))
  }
  return parsed
}

const VALID_CHANNELS: readonly string[] = ['latest', 'beta', 'alpha']

export function validateUpdateChannel(channel: string | undefined): ReleaseChannel | undefined {
  if (!channel) return undefined
  if (!VALID_CHANNELS.includes(channel)) {
    exitWithError(`Invalid update channel: ${channel}. Must be one of: ${VALID_CHANNELS.join(', ')}`)
  }
  return channel as ReleaseChannel
}
