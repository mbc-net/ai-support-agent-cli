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

const PROJECT_SUBDIRS = ['repos', 'docs', 'artifacts', 'uploads'] as const
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
 * Resolve the project directory path.
 * Priority: project.projectDir > defaultProjectDir template > default template
 */
export function resolveProjectDir(
  project: ProjectRegistration,
  defaultProjectDir?: string,
): string {
  if (project.projectDir) {
    return expandPath(project.projectDir, project.projectCode)
  }
  const template = defaultProjectDir ?? getDefaultProjectDirTemplate()
  return expandPath(template, project.projectCode)
}

/**
 * Create project directory structure with proper permissions.
 * Creates: repos/, docs/, artifacts/, uploads/, .ai-support-agent/cache/, .ai-support-agent/aws/
 */
export function ensureProjectDirs(projectDir: string): void {
  // Create project root
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  }

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
  for (const subdir of ['repos', 'docs'] as const) {
    const dirPath = path.join(projectDir, subdir)
    if (fs.existsSync(dirPath)) {
      dirs.push(dirPath)
    }
  }
  return dirs
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
