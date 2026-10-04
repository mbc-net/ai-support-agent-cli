#!/usr/bin/env node
'use strict'

/**
 * npm audit gate with time-boxed, per-advisory exclusions.
 *
 * `npm audit` has no way to exclude a single advisory, so an advisory with no
 * patched version (e.g. GHSA-vfj7-8cjw-p6xm in braces) would keep CI red forever.
 * This script runs `npm audit --json` and fails when any advisory at/above
 * --audit-level is not covered by an ACTIVE exclusion matching both the GHSA id
 * and the package name.
 *
 * Exclusions live in .github/npm-audit-exclusions.json:
 *   [{ "id": "GHSA-xxxx-xxxx-xxxx", "package": "name", "reason": "...", "expires": "YYYY-MM-DD" }]
 *
 * An active exclusion only takes effect while BOTH preconditions still hold; they are
 * checked mechanically, not just stated in `reason`:
 *   - no fixed version is published: among the package's published non-prerelease
 *     versions (`npm view <pkg> versions --json`), none is outside the advisory's
 *     vulnerable `range` while being newer than the lowest version inside it (so a
 *     fix on a maintenance line counts, but versions predating the vulnerability do
 *     not). A range that matches no published stable version fails closed.
 *     npm's `fixAvailable` is deliberately ignored — it reports `true` for braces
 *     although no patched version exists.
 *   - dev-only: the advisory does not appear in `npm audit --omit=dev --json`
 *     (exclusions never cover production dependencies).
 * These extra npm runs happen only when at least one exclusion is in use.
 *
 * Everything fails closed:
 *   - unparseable audit output / npm error JSON / no `vulnerabilities` object
 *   - malformed exclusions file (or an explicitly given one that is missing;
 *     a missing file at the default path is treated as an empty list)
 *   - an expired exclusion (expires < today, UTC) — re-evaluate and renew or remove
 *   - an unused exclusion (matches no current advisory at/above the level) — remove it
 *   - an advisory without a GHSA id in its url can never be excluded
 *   - registry lookup failure / unparseable versions / invalid advisory range
 *   - `npm audit --omit=dev` failure or unparseable output
 *
 * Usage: node .github/scripts/npm-audit-gate.js --audit-level=high [--exclusions=<path>]
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const semver = require('semver')

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical']
const ALLOWED_AUDIT_LEVELS = ['low', 'moderate', 'high', 'critical']
const DEFAULT_EXCLUSIONS = path.join('.github', 'npm-audit-exclusions.json')
const GHSA_ID_PATTERN = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/
const GHSA_URL_PATTERN = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function parseArgs(argv, cwd) {
  let auditLevel
  let exclusions
  for (const arg of argv) {
    if (arg.startsWith('--audit-level=')) {
      auditLevel = arg.slice('--audit-level='.length)
    } else if (arg.startsWith('--exclusions=')) {
      exclusions = arg.slice('--exclusions='.length)
      if (!exclusions) throw new Error('--exclusions requires a path')
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!ALLOWED_AUDIT_LEVELS.includes(auditLevel)) {
    throw new Error(
      `--audit-level must be one of ${ALLOWED_AUDIT_LEVELS.join('|')} (got: ${auditLevel === undefined ? 'none' : JSON.stringify(auditLevel)})`,
    )
  }
  return {
    auditLevel,
    exclusionsPath: path.resolve(cwd, exclusions ?? DEFAULT_EXCLUSIONS),
    exclusionsExplicit: exclusions !== undefined,
  }
}

function parseAuditReport(stdout) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch (e) {
    throw new Error(`Could not parse \`npm audit --json\` output: ${e.message}`)
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('`npm audit --json` output is not a JSON object')
  }
  if (report.error) {
    const err = report.error
    const detail = typeof err === 'object' ? [err.code, err.summary, err.detail].filter(Boolean).join(': ') : String(err)
    throw new Error(`npm audit reported an error: ${detail}`)
  }
  const vulns = report.vulnerabilities
  if (vulns === null || typeof vulns !== 'object' || Array.isArray(vulns)) {
    throw new Error('`npm audit --json` output has no `vulnerabilities` object')
  }
  return report
}

/** Every advisory object found in `vulnerabilities[*].via`, deduplicated. */
function collectAdvisories(report) {
  const seen = new Map()
  for (const vuln of Object.values(report.vulnerabilities)) {
    const via = Array.isArray(vuln && vuln.via) ? vuln.via : []
    for (const entry of via) {
      // String entries only point at another vulnerable package (propagation).
      if (entry === null || typeof entry !== 'object') continue
      const url = typeof entry.url === 'string' ? entry.url : ''
      const match = GHSA_URL_PATTERN.exec(url)
      const advisory = {
        id: match ? match[1] : null,
        name: String(entry.name ?? ''),
        severity: String(entry.severity ?? ''),
        title: String(entry.title ?? ''),
        url,
        range: typeof entry.range === 'string' ? entry.range : '',
      }
      const key = `${advisory.id ?? `source:${entry.source}:${url}`}|${advisory.name}`
      if (!seen.has(key)) seen.set(key, advisory)
    }
  }
  return [...seen.values()]
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function validateExclusions(data) {
  if (!Array.isArray(data)) throw new Error('Exclusions file must contain a JSON array')
  const errors = []
  data.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`[${i}] must be an object`)
      return
    }
    if (typeof entry.id !== 'string' || !GHSA_ID_PATTERN.test(entry.id)) {
      errors.push(`[${i}] id must match ${GHSA_ID_PATTERN} (got ${JSON.stringify(entry.id)})`)
    }
    if (!isNonEmptyString(entry.package)) errors.push(`[${i}] package must be a non-empty string`)
    if (!isNonEmptyString(entry.reason)) errors.push(`[${i}] reason must be a non-empty string`)
    if (!isValidDate(entry.expires)) {
      errors.push(`[${i}] expires must be a valid YYYY-MM-DD date (got ${JSON.stringify(entry.expires)})`)
    }
  })
  if (errors.length > 0) throw new Error(`Invalid exclusions file:\n  ${errors.join('\n  ')}`)
  return data
}

function loadExclusions(filePath, explicit) {
  if (!fs.existsSync(filePath)) {
    if (explicit) throw new Error(`Exclusions file not found: ${filePath}`)
    return []
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    throw new Error(`Could not parse exclusions file ${filePath}: ${e.message}`)
  }
  return validateExclusions(data)
}

function evaluate({ advisories, exclusions, auditLevel, now }) {
  const today = now.toISOString().slice(0, 10)
  const threshold = LEVELS.indexOf(auditLevel)
  const violations = []
  const excluded = []

  const active = []
  for (const ex of exclusions) {
    if (ex.expires < today) {
      violations.push(
        `Exclusion ${ex.id} (${ex.package}) expired on ${ex.expires}. Re-evaluate the advisory: renew the expiry with a reason, or remove the exclusion.`,
      )
    } else {
      active.push(ex)
    }
  }

  const used = new Set()
  for (const adv of advisories) {
    const rank = LEVELS.indexOf(adv.severity)
    // Unknown severities are treated as failing (fail closed).
    if (rank !== -1 && rank < threshold) continue
    const ex = adv.id === null ? undefined : active.find((e) => e.id === adv.id && e.package === adv.name)
    if (ex) {
      used.add(ex)
      excluded.push({ ...adv, expires: ex.expires })
      continue
    }
    violations.push(
      `${adv.id ?? '(no GHSA id; cannot be excluded)'} ${adv.name} [${adv.severity}] ${adv.title} ${adv.url}`,
    )
  }

  for (const ex of active) {
    if (!used.has(ex)) {
      violations.push(
        `Unused exclusion ${ex.id} (${ex.package}): no current advisory at/above "${auditLevel}" matches it. Remove it.`,
      )
    }
  }

  return { excluded, violations }
}

function errorMessage(e) {
  return e && e.message ? e.message : String(e)
}

/**
 * Precondition "no fixed version is published yet". Returns a violation message,
 * or null when no published stable version outside the range is newer than the
 * lowest published stable version inside it. Fails closed when the range matches
 * no published stable version at all.
 */
function checkFixNotPublished(advisory, runRegistryVersions) {
  const label = `${advisory.id} ${advisory.name}`
  const range = semver.validRange(advisory.range)
  if (!advisory.range || range === null) {
    return `${label}: advisory range ${JSON.stringify(advisory.range)} is not a valid semver range; cannot verify that no fix is published.`
  }
  let versions
  try {
    const { stdout, status } = runRegistryVersions(advisory.name)
    if (status !== 0) throw new Error(`npm view exited with status ${status}`)
    const parsed = JSON.parse(stdout)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
      throw new Error(`npm view reported an error: ${JSON.stringify(parsed.error)}`)
    }
    // `npm view <pkg> versions --json` prints a plain string when only one version exists.
    if (typeof parsed === 'string') versions = [parsed]
    else if (Array.isArray(parsed)) versions = parsed
    else throw new Error('npm view output is neither an array nor a string')
  } catch (e) {
    return `${label}: could not look up published versions (${errorMessage(e)}); cannot verify that no fix is published.`
  }
  const stable = versions.filter((v) => typeof v === 'string' && semver.valid(v) && !semver.prerelease(v))
  if (stable.length === 0) {
    return `${label}: no published stable version found; cannot verify that no fix is published.`
  }
  const sorted = semver.sort([...stable])
  // The lowest published stable version inside the range marks where the vulnerability
  // starts; versions below it predate the vulnerability and are not fixes.
  const firstVulnerable = sorted.find((v) => semver.satisfies(v, range))
  if (firstVulnerable === undefined) {
    return `${label}: advisory range ${JSON.stringify(advisory.range)} matches no published stable version; cannot verify that no fix is published.`
  }
  // A fix is any stable version outside the range that is newer than the first
  // vulnerable one — including fixes on a maintenance line below the highest version.
  const fixes = sorted.filter((v) => semver.gt(v, firstVulnerable) && !semver.satisfies(v, range))
  if (fixes.length > 0) {
    return `${label}: a fixed version (${fixes[0]}) is published; update the lockfile and remove the exclusion.`
  }
  return null
}

/**
 * Precondition "dev-only". Returns violations for excluded advisories that also
 * appear in `npm audit --omit=dev --json` (or one violation if that run fails).
 */
function checkDevOnly(excluded, runAuditOmitDev) {
  let prodAdvisories
  try {
    const { stdout } = runAuditOmitDev()
    prodAdvisories = collectAdvisories(parseAuditReport(stdout))
  } catch (e) {
    return [`npm audit --omit=dev failed (${errorMessage(e)}); cannot verify that exclusions are dev-only.`]
  }
  const violations = []
  for (const adv of excluded) {
    if (prodAdvisories.some((p) => p.id === adv.id && p.name === adv.name)) {
      violations.push(`${adv.id} ${adv.name}: reaches production dependencies; exclusions are dev-only.`)
    }
  }
  return violations
}

function spawnNpm(cwd, args) {
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  return { stdout: result.stdout, status: result.status }
}

// npm audit exits non-zero whenever vulnerabilities exist; the JSON decides.
const defaultRunAudit = (cwd) => spawnNpm(cwd, ['audit', '--json'])
const defaultRunAuditOmitDev = (cwd) => spawnNpm(cwd, ['audit', '--omit=dev', '--json'])
const defaultRunRegistryVersions = (cwd, pkg) => spawnNpm(cwd, ['view', pkg, 'versions', '--json'])

function main({
  argv,
  cwd,
  now,
  runAudit,
  runAuditOmitDev,
  runRegistryVersions,
  log = console.log,
  error = console.error,
}) {
  try {
    const args = parseArgs(argv, cwd)
    const exclusions = loadExclusions(args.exclusionsPath, args.exclusionsExplicit)
    const { stdout } = runAudit()
    const report = parseAuditReport(stdout)
    const advisories = collectAdvisories(report)
    const { excluded, violations } = evaluate({
      advisories,
      exclusions,
      auditLevel: args.auditLevel,
      now,
    })
    if (excluded.length > 0) {
      for (const adv of excluded) {
        const v = checkFixNotPublished(adv, runRegistryVersions)
        if (v !== null) violations.push(v)
      }
      violations.push(...checkDevOnly(excluded, runAuditOmitDev))
    }

    log(`npm audit gate (level: ${args.auditLevel}, advisories found: ${advisories.length})`)
    if (excluded.length > 0) {
      log('Excluded advisories (time-boxed):')
      for (const adv of excluded) {
        log(`  - ${adv.id} ${adv.name} [${adv.severity}] ${adv.title} (expires ${adv.expires})`)
      }
    }
    if (violations.length > 0) {
      error(`npm audit gate FAILED (${violations.length} violation(s)):`)
      for (const v of violations) error(`  - ${v}`)
      error(`Exclusions file: ${args.exclusionsPath}`)
      return 1
    }
    log('npm audit gate passed.')
    return 0
  } catch (e) {
    error(`npm audit gate FAILED: ${errorMessage(e)}`)
    return 1
  }
}

module.exports = {
  parseArgs,
  parseAuditReport,
  collectAdvisories,
  validateExclusions,
  loadExclusions,
  evaluate,
  checkFixNotPublished,
  checkDevOnly,
  main,
}

if (require.main === module) {
  const cwd = process.cwd()
  process.exitCode = main({
    argv: process.argv.slice(2),
    cwd,
    now: new Date(),
    runAudit: () => defaultRunAudit(cwd),
    runAuditOmitDev: () => defaultRunAuditOmitDev(cwd),
    runRegistryVersions: (pkg) => defaultRunRegistryVersions(cwd, pkg),
  })
}
