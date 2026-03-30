import * as fs from 'fs'
import * as path from 'path'

import type { ApiClient } from './api-client'
import { logger } from './logger'
import type { ProjectConfigResponse, SshCredentials } from './types'
import { getErrorMessage } from './utils'
import { normalizePemKey } from './utils/pem-key'

const MANAGED_BLOCK_BEGIN = '# BEGIN ai-support-agent managed'
const MANAGED_BLOCK_END = '# END ai-support-agent managed'
const KEY_FILE_PREFIX = 'ai-support-agent-'

type SshHost = NonNullable<ProjectConfigResponse['ssh']>['hosts'][number]

/**
 * Set up SSH config and private key files for the given SSH hosts.
 * Files are written to sshDir (project-scoped directory, not ~/.ssh).
 * Fetches credentials from the API, writes key files, and updates sshDir/config.
 */
export async function setupSshConfig(
  client: ApiClient,
  sshConfig: { hosts: SshHost[] },
  sshDir: string,
): Promise<void> {
  // Ensure SSH directory exists (project-scoped, not ~/.ssh)
  if (!fs.existsSync(sshDir)) {
    try {
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 })
      logger.info(`[ssh] Created SSH directory: ${sshDir}`)
    } catch (error) {
      throw new Error(`Cannot create SSH directory ${sshDir}: ${getErrorMessage(error)}`)
    }
  }

  const configEntries: Array<{
    hostId: string
    hostname: string
    port: number
    username: string
  }> = []

  for (const host of sshConfig.hosts) {
    try {
      const credentials = await client.getSshCredentials(host.hostId)
      writeKeyFile(sshDir, credentials)
      configEntries.push({
        hostId: credentials.hostId,
        hostname: credentials.hostname,
        port: credentials.port,
        username: credentials.username,
      })
      logger.info(`[ssh] Key file written for host: ${host.hostId} (${host.name})`)
    } catch (error) {
      logger.warn(`[ssh] Failed to set up SSH for host ${host.hostId} (${host.name}): ${getErrorMessage(error)}`)
    }
  }

  if (configEntries.length > 0) {
    try {
      writeSshConfig(sshDir, configEntries)
      logger.info(`[ssh] SSH config updated with ${configEntries.length} host(s) at ${sshDir}`)
    } catch (error) {
      logger.warn(`[ssh] Failed to write SSH config: ${getErrorMessage(error)}`)
    }
  }
}

/**
 * Write a private key file to {sshDir}/ai-support-agent-{hostId}
 */
function writeKeyFile(sshDir: string, credentials: SshCredentials): void {
  const keyPath = path.join(sshDir, `${KEY_FILE_PREFIX}${credentials.hostId}`)
  const normalizedKey = normalizePemKey(credentials.privateKey)
  fs.writeFileSync(keyPath, normalizedKey, { mode: 0o600 })
}

/**
 * Write/update the managed block in {sshDir}/config.
 * Preserves any existing content outside the managed block.
 */
function writeSshConfig(
  sshDir: string,
  entries: Array<{ hostId: string; hostname: string; port: number; username: string }>,
): void {
  const configPath = path.join(sshDir, 'config')

  // Read existing config
  let existingContent = ''
  if (fs.existsSync(configPath)) {
    existingContent = fs.readFileSync(configPath, 'utf-8')
  }

  // Remove old managed block
  const contentOutside = removeManagedBlock(existingContent)

  // Build new managed block (use absolute paths for IdentityFile)
  const managedBlock = buildManagedBlock(sshDir, entries)

  // Combine: existing content + managed block
  const trimmed = contentOutside.trimEnd()
  const newContent = trimmed.length > 0
    ? trimmed + '\n\n' + managedBlock + '\n'
    : managedBlock + '\n'

  fs.writeFileSync(configPath, newContent, { mode: 0o600 })
}

/**
 * Build the managed block content for SSH config.
 * Uses absolute paths for IdentityFile to work regardless of CWD.
 */
export function buildManagedBlock(
  sshDir: string,
  entries: Array<{ hostId: string; hostname: string; port: number; username: string }>,
): string {
  const hostBlocks = entries.map((entry) =>
    `Host ai-agent-${entry.hostId}\n` +
    `    HostName ${entry.hostname}\n` +
    `    Port ${entry.port}\n` +
    `    User ${entry.username}\n` +
    `    IdentityFile ${path.join(sshDir, KEY_FILE_PREFIX + entry.hostId)}\n` +
    `    StrictHostKeyChecking no\n` +
    `    UserKnownHostsFile /dev/null`,
  )

  return [
    MANAGED_BLOCK_BEGIN,
    ...hostBlocks.map((block, i) => i < hostBlocks.length - 1 ? block + '\n' : block),
    MANAGED_BLOCK_END,
  ].join('\n')
}

/**
 * Remove the managed block from SSH config content.
 * Returns the content outside the managed block.
 */
export function removeManagedBlock(content: string): string {
  const beginIndex = content.indexOf(MANAGED_BLOCK_BEGIN)
  if (beginIndex === -1) return content

  const endIndex = content.indexOf(MANAGED_BLOCK_END)
  if (endIndex === -1) return content

  const before = content.substring(0, beginIndex)
  const after = content.substring(endIndex + MANAGED_BLOCK_END.length)

  return (before + after).replace(/\n{3,}/g, '\n\n')
}

/**
 * Clean up all SSH config and key files managed by ai-support-agent.
 * Removes the managed block from {sshDir}/config and deletes key files.
 */
export function cleanupSshConfig(sshDir: string): void {
  const configPath = path.join(sshDir, 'config')

  // Remove managed block from config
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8')
      const cleaned = removeManagedBlock(content).trimEnd()
      fs.writeFileSync(configPath, cleaned.length > 0 ? cleaned + '\n' : '', { mode: 0o600 })
      logger.info(`[ssh] Removed managed block from ${configPath}`)
    } catch (error) {
      logger.warn(`[ssh] Failed to clean up SSH config: ${getErrorMessage(error)}`)
    }
  }

  // Remove key files
  if (fs.existsSync(sshDir)) {
    try {
      const files = fs.readdirSync(sshDir)
      for (const file of files) {
        if (file.startsWith(KEY_FILE_PREFIX)) {
          try {
            fs.unlinkSync(path.join(sshDir, file))
            logger.info(`[ssh] Removed key file: ${file}`)
          } catch (error) {
            logger.warn(`[ssh] Failed to remove key file ${file}: ${getErrorMessage(error)}`)
          }
        }
      }
    } catch (error) {
      logger.warn(`[ssh] Failed to list SSH directory: ${getErrorMessage(error)}`)
    }
  }
}
