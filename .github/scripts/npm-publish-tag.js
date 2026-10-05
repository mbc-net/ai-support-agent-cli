#!/usr/bin/env node
'use strict'

/**
 * Decides which dist-tag `npm publish` attaches to <package>@<version>, so that
 * npm's channel dist-tag (latest / beta / alpha) only ever moves FORWARD.
 *
 * Problem it solves: `npm publish --tag <channel>` used to move the channel
 * unconditionally and without a lock. If v0.5.16-beta.0 and beta.1 published
 * concurrently and beta.0's publish completed last, npm's `beta` rolled back to
 * beta.0; the downstream channel jobs (image tag, API notification) then
 * faithfully converged to that wrong holder.
 *
 * The publish job runs this under a per-channel lock (its job-level
 * `concurrency`, see ci-cd.yml), so read->publish of different releases of the
 * same channel cannot interleave. With holder P = dist-tags[channel] and this
 * run's version V:
 *
 *   --published=false (V is about to be published):
 *     - P missing or P < V -> publish_tag=<channel>          (V takes the channel)
 *     - P > V              -> publish_tag=superseded-<channel> (an older release
 *                             never takes the channel; ::notice::)
 *     - P == V             -> FAIL (the pre-check said V is not published, yet the
 *                             channel names it: the registry views disagree)
 *   --published=true (re-run; npm publish is skipped):
 *     - P >= V             -> OK, nothing to do (::notice:: when P > V)
 *     - P missing or P < V -> FAIL with the manual repair command. The locked
 *                             publish set the channel to V (or V was superseded),
 *                             so this means the channel was changed outside this
 *                             workflow.
 *   lookup error / non-200 / unparsable / non-string holder / invalid semver /
 *   same precedence but different version -> FAIL (never guess).
 *
 * The dist-tag is written only by `npm publish` itself (OIDC trusted publishing,
 * which the publish job already uses). `npm dist-tag add` is deliberately not
 * used: with OIDC it needs npm >= 11.21.0 and the package's trusted-publisher
 * setting "Allow npm dist-tag" (off by default) on npmjs.com.
 *
 * The holder is read with npm-dist-tags.js, the single read path shared with
 * npm-channel-target.js: the uncached /-/package/<pkg>/dist-tags endpoint, never
 * `npm view` (whose packument is CDN-cached for up to 300 s and could return the
 * holder from before the previous locked publish).
 *
 * On success (and without --dry-run) it appends `publish_tag=<tag>` to
 * $GITHUB_OUTPUT when --published=false; nothing when --published=true.
 * --dry-run prints the decision instead and writes nothing.
 *
 * Requires the `semver` package: resolved from the repository's node_modules
 * (the publish job runs `npm ci` first; package-lock.json pins it).
 *
 * Usage: node .github/scripts/npm-publish-tag.js --package=<name> --version=<x.y.z[-pre]>
 *          --channel=<dist-tag> --published=<true|false> [--dry-run]
 * Env:   GITHUB_OUTPUT (required when run as a CLI without --dry-run)
 */

const fs = require('fs')
const semver = require('semver')
const { distTagsUrl, fetchDistTags, readHolder, TIMEOUT_MS } = require('./npm-dist-tags.js')

// Same rules as npm-channel-target.js.
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/
// Must not be parseable as a semver range (npm rejects such tags) and must not
// equal a channel name.
const SUPERSEDED_PREFIX = 'superseded-'

function parseArgs(argv) {
  let packageName
  let version
  let channel
  let published
  let dryRun = false
  for (const arg of argv) {
    if (arg.startsWith('--package=')) {
      packageName = arg.slice('--package='.length)
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    } else if (arg.startsWith('--channel=')) {
      channel = arg.slice('--channel='.length)
    } else if (arg.startsWith('--published=')) {
      published = arg.slice('--published='.length)
    } else if (arg === '--dry-run') {
      dryRun = true
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
  if (published !== 'true' && published !== 'false') {
    throw new Error(
      `--published must be true or false (got: ${published === undefined ? 'none' : JSON.stringify(published)})`,
    )
  }
  return { packageName, version, channel, published: published === 'true', dryRun }
}

/** -1 (holder missing or older), 0 (same version), 1 (holder newer). Throws when not comparable. */
function compareHolder(holder, version) {
  if (holder === undefined) return -1
  if (holder === version) return 0
  if (!semver.valid(holder)) {
    throw new Error(`dist-tag holder ${JSON.stringify(holder)} is not a valid semver version`)
  }
  const order = semver.compare(holder, version)
  if (order === 0) {
    throw new Error(`dist-tag holder ${holder} has the same precedence as ${version} but is a different version`)
  }
  return order
}

/**
 * Returns { publishTag?, message }. publishTag is set only when published=false.
 * Throws when the step must fail.
 */
function decide({ holder, version, channel, published }) {
  const order = compareHolder(holder, version)
  const seen = holder === undefined ? `has no "${channel}" dist-tag` : `"${channel}" is held by ${holder}`
  if (!published) {
    if (order < 0) {
      return { publishTag: channel, message: `${seen}; publishing ${version} with --tag ${channel} (it takes the channel)` }
    }
    if (order > 0) {
      const publishTag = `${SUPERSEDED_PREFIX}${channel}`
      return {
        publishTag,
        message:
          `::notice::"${channel}" is held by the newer ${holder}; publishing ${version} with --tag ${publishTag} ` +
          `so that an older release never takes the channel.`,
      }
    }
    throw new Error(
      `"${channel}" already names ${version}, but the pre-check found ${version} unpublished; ` +
        'the registry views disagree. Re-run the job.',
    )
  }
  if (order === 0) return { message: `${seen}; already published, nothing to do` }
  if (order > 0) {
    return { message: `::notice::"${channel}" is held by the newer ${holder}; ${version} stays off the channel` }
  }
  throw new Error(
    `${version} is already published but npm ${seen}. The locked publish job would have set the channel to ` +
      `${version}, so it was changed outside this workflow. Check it, then repair it manually if appropriate.`,
  )
}

// Shared with npm-channel-target.js (see npm-dist-tags.js).
const defaultFetchDistTags = fetchDistTags

async function main({
  argv,
  fetchDistTags = defaultFetchDistTags,
  appendOutput,
  log = console.log,
  error = console.error,
}) {
  let args
  try {
    args = parseArgs(argv)
    const { packageName, version, channel, published, dryRun } = args
    const holder = readHolder(await fetchDistTags(packageName), channel)
    const { publishTag, message } = decide({ holder, version, channel, published })
    // Workflow commands (::notice::) are only recognised at the start of a line.
    const NOTICE = '::notice::'
    log(
      message.startsWith(NOTICE)
        ? `${NOTICE}${packageName}@${version}: ${message.slice(NOTICE.length)}`
        : `${packageName}@${version}: ${message}`,
    )
    if (publishTag !== undefined) {
      if (dryRun) {
        log(`[dry-run] would write publish_tag=${publishTag}`)
      } else {
        appendOutput(`publish_tag=${publishTag}`)
      }
    } else if (dryRun) {
      log('[dry-run] no output (nothing to publish)')
    }
    return 0
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    error(`::error::npm channel dist-tag decision failed: ${msg}`)
    if (args && args.published && /changed outside this workflow/.test(msg)) {
      error(
        `::error::To give the channel back to this release: npm dist-tag add ${args.packageName}@${args.version} ${args.channel}`,
      )
    }
    return 1
  }
}

module.exports = {
  parseArgs,
  distTagsUrl,
  readHolder,
  decide,
  main,
  defaultFetchDistTags,
  SUPERSEDED_PREFIX,
  TIMEOUT_MS,
}

if (require.main === module) {
  main({
    argv: process.argv.slice(2),
    appendOutput: (line) => {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set')
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
    },
  }).then((code) => {
    process.exitCode = code
  })
}
