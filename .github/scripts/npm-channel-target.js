#!/usr/bin/env node
'use strict'

/**
 * Resolves which version a release channel (the GHCR moving image tag
 * `:latest`/`:beta`/`:alpha` and the API's "latest version" for the channel)
 * must point at RIGHT NOW: the version npm's dist-tag currently names.
 *
 * Channel updates are idempotent reconciliation to npm's truth, run under a
 * per-channel lock (job-level `concurrency` in ci-cd.yml). They never "move the
 * channel to this run's version":
 *   - Workflow concurrency is per ref, so runs of different tags are not
 *     serialized. An old tag's re-run could check "still mine", a newer release
 *     could then move npm + `:latest`, and the old run's update would land last and
 *     roll `:latest` back (the default k8s manifests pull `:latest` with
 *     imagePullPolicy Always -> downgrade on restart).
 *   - The per-channel lock serializes check->act, but a GitHub concurrency group
 *     holds one running + ONE pending job: a newly queued job cancels the pending
 *     one. If each job moved the channel to its own version, a cancelled job's
 *     update would simply be lost.
 *   - Reconciling to npm's current holder makes cancellation harmless: whichever
 *     job runs last in the group sets the channel to the current holder, and the
 *     holder's own release always gets a job that runs after its image exists.
 *
 * npm's holder H is monotonic: the dist-tag is only ever written by the publish
 * job's `npm publish --tag <decided tag>`, under the npm channel lock, after
 * npm-publish-tag.js decided that this release is newer than the current holder
 * (an older release is published with `superseded-<channel>` instead). So H only
 * ever moves forward and reconciling to it can never roll a channel back.
 *
 * It must not come from a `publish` job output: "Re-run failed jobs" reuses the
 * successful publish job's old outputs (only the tag-derived version/channel are
 * safe to reuse).
 *
 * H is read with npm-dist-tags.js, the single read path shared with
 * npm-publish-tag.js: the UNCACHED https://registry.npmjs.org/-/package/<pkg>/dist-tags.
 * Never `npm view <pkg> dist-tags`: it reads the packument, which the registry
 * CDN caches for up to 300 s. Because H >= V counts as ready, a cached holder
 * would let a re-run of an older tag, within 300 s after a newer release, read
 * H == its own old V and roll GHCR :latest/:beta and the API back.
 *
 *   holder H = dist-tags[channel] (uncached), this run V
 *     - H == V or H semver-newer than V -> target=H immediately
 *     - H missing or semver-older       -> this run's own publish is not visible
 *                                          yet (expected right after a fresh
 *                                          `npm publish --tag`): query again every
 *                                          intervalMs, up to maxAttempts queries in
 *                                          total; once H >= V -> target=H; still
 *                                          older/missing at the deadline -> FAIL.
 *                                          The wait is only for this; it is NOT
 *                                          meant to absorb a stale (cached) read.
 *     - lookup error (non-200, connection error, timeout) / unparsable body /
 *       non-string holder / invalid semver -> FAIL immediately (never guess).
 *
 * As a CLI it appends `target=<H>` to $GITHUB_OUTPUT. notify-version.js calls
 * resolveTarget() in-process before every attempt.
 *
 * Requires the `semver` package (the workflow installs the version pinned in
 * package-lock.json and exposes it via NODE_PATH; see ci-cd.yml).
 *
 * Usage: node .github/scripts/npm-channel-target.js --package=<name> --version=<x.y.z[-pre]> --channel=<dist-tag>
 * Env:   GITHUB_OUTPUT (required when run as a CLI)
 */

const fs = require('fs')
const semver = require('semver')
const { fetchDistTags, readHolder } = require('./npm-dist-tags.js')

// Exact versions only, same rule as npm-version-published.js.
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// npm dist-tag names as produced by the workflow (latest / beta / alpha).
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/

// 31 queries 10s apart: up to 5 minutes of waiting for this run's own publish to
// become visible on the dist-tags endpoint.
const DEFAULT_MAX_ATTEMPTS = 31
const DEFAULT_INTERVAL_MS = 10_000

function parseArgs(argv) {
  let packageName
  let version
  let channel
  for (const arg of argv) {
    if (arg.startsWith('--package=')) {
      packageName = arg.slice('--package='.length)
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    } else if (arg.startsWith('--channel=')) {
      channel = arg.slice('--channel='.length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!packageName) throw new Error('--package=<name> is required')
  if (version === undefined || !EXACT_VERSION_PATTERN.test(version) || !semver.valid(version)) {
    throw new Error(
      `--version must be an exact semver version (got: ${version === undefined ? 'none' : JSON.stringify(version)})`,
    )
  }
  if (channel === undefined || !CHANNEL_PATTERN.test(channel)) {
    throw new Error(
      `--channel must be an npm dist-tag name such as latest/beta/alpha (got: ${channel === undefined ? 'none' : JSON.stringify(channel)})`,
    )
  }
  return { packageName, version, channel }
}

/**
 * 'ready' (H >= V: reconcile to H) | 'pending' (H missing or older: wait). Throws on
 * an invalid semver holder, or on a holder that differs from version only in build
 * metadata (same precedence, yet a different version string).
 */
function decide(holder, version) {
  if (holder === undefined) return 'pending'
  if (holder === version) return 'ready'
  if (!semver.valid(holder)) {
    throw new Error(`dist-tag holder ${JSON.stringify(holder)} is not a valid semver version`)
  }
  const order = semver.compare(holder, version)
  if (order > 0) return 'ready'
  if (order < 0) return 'pending'
  throw new Error(`dist-tag holder ${holder} has the same precedence as ${version} but is a different version`)
}

// Shared with npm-publish-tag.js (see npm-dist-tags.js).
const defaultFetchDistTags = fetchDistTags

/** Returns the version the channel must point at (H). Throws instead of guessing. */
async function resolveTarget({
  packageName,
  version,
  channel,
  fetchDistTags = defaultFetchDistTags,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const spec = `${packageName}@${version}`
  let holder
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    holder = readHolder(await fetchDistTags(packageName), channel)
    if (decide(holder, version) === 'ready') {
      if (holder === version) {
        log(`${spec}: dist-tag "${channel}" is ${version}; channel target is ${holder}`)
      } else {
        log(
          `::notice::${spec}: dist-tag "${channel}" is held by the newer ${holder}; ` +
            `reconciling the "${channel}" channel to ${holder}, not ${version}.`,
        )
      }
      return holder
    }
    const seen = holder === undefined ? 'does not exist yet' : `is still ${holder}`
    if (attempt < maxAttempts) {
      log(
        `${spec}: dist-tag "${channel}" ${seen} (attempt ${attempt}/${maxAttempts}); ` +
          `waiting ${intervalMs / 1000}s for this release's publish to become visible`,
      )
      await sleep(intervalMs)
    }
  }
  const seen = holder === undefined ? 'still does not exist' : `is still held by the older ${holder}`
  throw new Error(
    `dist-tag "${channel}" ${seen} after ${maxAttempts} queries; cannot tell which version the channel should point at`,
  )
}

async function main({
  argv,
  fetchDistTags = defaultFetchDistTags,
  appendOutput,
  sleep,
  log = console.log,
  error = console.error,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  try {
    const { packageName, version, channel } = parseArgs(argv)
    const target = await resolveTarget({ packageName, version, channel, fetchDistTags, sleep, log, maxAttempts, intervalMs })
    appendOutput(`target=${target}`)
    return 0
  } catch (e) {
    error(`::error::channel target resolution failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

module.exports = {
  parseArgs,
  readHolder,
  decide,
  resolveTarget,
  main,
  defaultFetchDistTags,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_INTERVAL_MS,
}

if (require.main === module) {
  main({
    argv: process.argv.slice(2),
    appendOutput: (line) => {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set')
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then((code) => {
    process.exitCode = code
  })
}
