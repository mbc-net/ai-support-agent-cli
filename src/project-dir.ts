import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getConfigDir } from './config-manager'
import { logger } from './logger'
import { t } from './i18n'
import type { ProjectRegistration } from './types'

function getDefaultProjectDirTemplate(): string {
  return path.join(getConfigDir(), 'projects', '{projectCode}')
}

const PROJECT_SUBDIRS = ['workspace/repos', 'workspace/docs', 'workspace/artifacts', 'uploads'] as const
const METADATA_DIR = '.ai-support-agent'
const CACHE_DIR = 'cache'
const AWS_DIR = 'aws'

/**
 * Expand ~ and {projectCode} in a path template
 */
export function expandPath(template: string, projectCode: string): string {
  return template
    .replace(/^~(?=$|\/)/, os.homedir())
    .replace(/\{projectCode\}/g, projectCode)
}

/**
 * Parse AI_SUPPORT_AGENT_PROJECT_DIR_MAP env var.
 * Format: "projectCode1=/path1;projectCode2=/path2"
 */
function getContainerProjectDirMap(): Map<string, string> {
  const map = new Map<string, string>()
  const envVal = process.env.AI_SUPPORT_AGENT_PROJECT_DIR_MAP
  if (!envVal) return map
  for (const entry of envVal.split(';')) {
    const eqIdx = entry.indexOf('=')
    if (eqIdx > 0) {
      map.set(entry.substring(0, eqIdx), entry.substring(eqIdx + 1))
    }
  }
  return map
}

/**
 * Resolve the project directory path.
 * Priority: container dir mapping > project.projectDir > defaultProjectDir template > default template
 */
export function resolveProjectDir(
  project: ProjectRegistration,
  defaultProjectDir?: string,
): string {
  // Docker container mapping takes highest priority
  const containerMap = getContainerProjectDirMap()
  const containerDir = containerMap.get(project.projectCode)
  if (containerDir) {
    return containerDir
  }

  if (project.projectDir) {
    return expandPath(project.projectDir, project.projectCode)
  }
  const template = defaultProjectDir ?? getDefaultProjectDirTemplate()
  return expandPath(template, project.projectCode)
}

/**
 * Create project directory structure with proper permissions.
 * Creates: workspace/repos/, workspace/docs/, workspace/artifacts/, uploads/, .ai-support-agent/cache/, .ai-support-agent/aws/
 */
export function ensureProjectDirs(projectDir: string): void {
  // Create project root
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  }

  // Legacy directory migration
  migrateIfNeeded(projectDir, 'metadata', '.ai-support-agent')
  migrateIfNeeded(projectDir, 'repos', path.join('workspace', 'repos'))
  migrateIfNeeded(projectDir, 'docs', path.join('workspace', 'docs'))
  migrateIfNeeded(projectDir, 'artifacts', path.join('workspace', 'artifacts'))

  // Create subdirectories
  for (const subdir of PROJECT_SUBDIRS) {
    const dirPath = path.join(projectDir, subdir)
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  // Create metadata directory
  const metadataDir = path.join(projectDir, METADATA_DIR)
  if (!fs.existsSync(metadataDir)) {
    fs.mkdirSync(metadataDir, { recursive: true, mode: 0o700 })
  }

  // Create cache directory
  const cacheDir = path.join(metadataDir, CACHE_DIR)
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  }

  // Create aws directory
  const awsDir = path.join(metadataDir, AWS_DIR)
  if (!fs.existsSync(awsDir)) {
    fs.mkdirSync(awsDir, { recursive: true, mode: 0o700 })
  }
}

/**
 * Resolve and ensure project directory.
 * Returns the resolved path.
 */
export function initProjectDir(
  project: ProjectRegistration,
  defaultProjectDir?: string,
): string {
  const projectDir = resolveProjectDir(project, defaultProjectDir)
  ensureProjectDirs(projectDir)
  logger.info(t('projectDir.initialized', { projectDir, projectCode: project.projectCode }))
  return projectDir
}

/**
 * Get directories that should be auto-added to Claude Code's --add-dir.
 * Only returns dirs that actually exist.
 */
export function getAutoAddDirs(projectDir: string): string[] {
  const dirs: string[] = []
  for (const subdir of ['workspace/repos', 'workspace/docs'] as const) {
    const dirPath = path.join(projectDir, subdir)
    if (fs.existsSync(dirPath)) {
      dirs.push(dirPath)
    }
  }
  return dirs
}

/**
 * Get workspace directory path
 */
export function getWorkspaceDir(projectDir: string): string {
  return path.join(projectDir, 'workspace')
}

/**
 * Get repos directory path
 */
export function getReposDir(projectDir: string): string {
  return path.join(projectDir, 'workspace', 'repos')
}

/**
 * Get cache directory path
 */
export function getCacheDir(projectDir: string): string {
  return path.join(projectDir, METADATA_DIR, CACHE_DIR)
}

/**
 * Get AWS directory path
 */
export function getAwsDir(projectDir: string): string {
  return path.join(projectDir, METADATA_DIR, AWS_DIR)
}

/**
 * Get metadata directory path
 */
export function getMetadataDir(projectDir: string): string {
  return path.join(projectDir, METADATA_DIR)
}

function migrateIfNeeded(projectDir: string, oldSub: string, newSub: string): void {
  const oldPath = path.join(projectDir, oldSub)
  const newPath = path.join(projectDir, newSub)
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true })
    fs.renameSync(oldPath, newPath)
    logger.info(`Migrated ${oldPath} -> ${newPath}`)
  }
}
