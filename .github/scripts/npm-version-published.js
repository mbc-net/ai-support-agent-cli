#!/usr/bin/env node
'use strict'

/**
 * Decides whether `npm publish` must run for <package>@<version> in this run.
 *
 * `npm publish` can never overwrite a published version (E403), so once a tag
 * run has published, any re-run of the publish job used to fail at the publish
 * step. This makes the publish job re-runnable without ever republishing a
 * version from different source:
 *
 *   GET https://registry.npmjs.org/<package, "/" as %2f>/<version>
 *     - HTTP 404                      -> not published         -> skip=false
 *     - HTTP 200, gitHead == SHA      -> re-run of this commit -> skip=true
 *     - HTTP 200, gitHead != SHA      -> FAIL (never publish a version twice from different commits)
 *     - HTTP 200, no/non-string gitHead,
 *       or a manifest of another version -> FAIL (cannot prove it is the same source)
 *     - any other status, a body that is not a JSON object, a connection error
 *       or a timeout                  -> FAIL (neither "published" nor "not published")
 *
 * Why this endpoint and not `npm view <pkg>@<ver> gitHead`: npm view reads the
 * packument, which the registry CDN caches for up to 300 s. A re-run within
 * 300 s of a publish could then see "not found" and run `npm publish` again
 * (E403), or disagree with the uncached dist-tag read that follows. The
 * per-version manifest is served uncached (cf-cache-status: DYNAMIC). The read
 * lives in npm-dist-tags.js, which hosts all of the release workflow's uncached
 * registry reads; this script does not run the npm CLI at all.
 *
 * Why gitHead is a valid identity check: when `npm publish` runs inside a git
 * checkout, npm records the checkout's HEAD commit as `gitHead` in the published
 * manifest. The publish job publishes from `actions/checkout` of the tag, whose
 * HEAD is $GITHUB_SHA, and `npm version --no-git-tag-version` only edits
 * package.json without moving HEAD. (Verified: 0.5.15-beta.0 and 0.5.13 both
 * carry their tag commit as gitHead.)
 *
 * It deliberately does NOT deal with the release channel: "Re-run failed jobs"
 * reuses this job's outputs, so a channel decision exported from here would go
 * stale. npm's channel dist-tag is decided under the npm channel lock right
 * before publishing by npm-publish-tag.js, and the downstream jobs (GHCR
 * `:latest`, the API's latest version) resolve the channel's current holder
 * right before acting with npm-channel-target.js.
 *
 * On success it appends `skip=true|false` to $GITHUB_OUTPUT.
 *
 * Usage: node .github/scripts/npm-version-published.js --package=<name> --version=<x.y.z[-pre]>
 * Env:   GITHUB_SHA (required), GITHUB_OUTPUT (required when run as a CLI)
 */

const fs = require('fs')
const { fetchVersionManifest } = require('./npm-dist-tags.js')

// Exact versions only: a dist-tag ("beta") or a range would make the registry
// resolve some other version and compare against the wrong gitHead.
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA_PATTERN = /^[0-9a-f]{40}$/i

function parseArgs(argv) {
  let packageName
  let version
  for (const arg of argv) {
    if (arg.startsWith('--package=')) {
      packageName = arg.slice('--package='.length)
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!packageName) throw new Error('--package=<name> is required')
  if (version === undefined || !EXACT_VERSION_PATTERN.test(version)) {
    throw new Error(
      `--version must be an exact semver version (got: ${version === undefined ? 'none' : JSON.stringify(version)})`,
    )
  }
  return { packageName, version }
}

function truncate(text) {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

/**
 * Interprets the per-version manifest response ({ status, body }).
 * Returns { skip, reason } or throws when the outcome must fail the step.
 */
function classify(result, version, expectedSha) {
  const body = String(result.body ?? '').trim()
  if (result.status === 404) {
    return { skip: false, reason: 'not published yet (HTTP 404)' }
  }
  if (result.status !== 200) {
    throw new Error(
      `registry returned HTTP ${result.status}; cannot tell whether the version is published (body: ${truncate(body)})`,
    )
  }
  let manifest
  try {
    manifest = JSON.parse(body)
  } catch {
    throw new Error(`unexpected registry response; expected a JSON object (body: ${truncate(body)})`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`unexpected registry response; expected a JSON object (body: ${truncate(body)})`)
  }
  if (manifest.version !== version) {
    throw new Error(
      `registry returned the manifest of version ${JSON.stringify(manifest.version)} instead of ${version}`,
    )
  }
  if (typeof manifest.gitHead !== 'string' || manifest.gitHead.trim() === '') {
    throw new Error(
      `version is published but has no gitHead (got: ${JSON.stringify(manifest.gitHead)}); ` +
        'cannot verify it was published from this commit',
    )
  }
  const gitHead = manifest.gitHead.trim().toLowerCase()
  if (gitHead !== expectedSha.toLowerCase()) {
    throw new Error(
      `version is already published from commit ${gitHead}, but this run is ${expectedSha}. ` +
        'A version must never be republished from a different commit; bump the version instead.',
    )
  }
  return { skip: true, reason: `already published from this commit (${gitHead}); skipping npm publish (re-run)` }
}

async function main({
  argv,
  env,
  fetchVersionManifest: fetchManifest = fetchVersionManifest,
  appendOutput,
  log = console.log,
  error = console.error,
}) {
  try {
    const { packageName, version } = parseArgs(argv)
    const sha = env.GITHUB_SHA
    if (!sha || !SHA_PATTERN.test(sha)) {
      throw new Error(`GITHUB_SHA must be a 40-character commit SHA (got: ${JSON.stringify(sha)})`)
    }
    const { skip, reason } = classify(await fetchManifest(packageName, version), version, sha)
    log(`${packageName}@${version}: ${reason}`)
    appendOutput(`skip=${skip}`)
    return 0
  } catch (e) {
    const detail = e instanceof Error ? `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}` : String(e)
    error(`::error::npm publish pre-check failed: ${detail}`)
    return 1
  }
}

module.exports = { parseArgs, classify, main, defaultFetchVersionManifest: fetchVersionManifest }

if (require.main === module) {
  main({
    argv: process.argv.slice(2),
    env: process.env,
    appendOutput: (line) => {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set')
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
    },
  }).then((code) => {
    process.exitCode = code
  })
}
