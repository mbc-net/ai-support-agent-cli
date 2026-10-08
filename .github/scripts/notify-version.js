#!/usr/bin/env node
'use strict'

/**
 * Tells the API the current version of a release channel:
 *   PUT $VERSION_API_URL/api/agent/version {"channel": <channel>, "latestVersion": <H>}
 *
 * H is NOT this run's version: before EVERY attempt it is re-resolved from npm's
 * dist-tag with npm-channel-target.js (read from the uncached dist-tags endpoint
 * via npm-dist-tags.js, never the CDN-cached `npm view` packument; H >= this
 * run's version; waits for this release's publish to become visible; fails
 * instead of guessing). So:
 *   - a re-run of an older tag tells the API the newer holder (idempotent
 *     convergence), never rolls it back;
 *   - a retry after a backoff never sends a value that went stale while waiting.
 * The workflow runs this under a per-channel lock (notify_version's job-level
 * concurrency), so check->send of different tags' runs cannot interleave; see
 * npm-channel-target.js for why reconciling to npm makes a cancelled pending job
 * harmless.
 *
 * Retries (MAX_ATTEMPTS, DELAYS_MS backoff) only what can be transient: connection
 * errors/timeouts (TIMEOUT_MS per request, like curl --max-time 30), 5xx, 429, and
 * 403 (CloudFront geo/WAF blocks depend on the runner's egress IP; v0.5.15-beta.0
 * hit exactly that). Other 4xx (bad key, bad payload) fail immediately.
 *
 * Without VERSION_API_URL / VERSION_API_KEY it warns and succeeds (no notification).
 *
 * Usage: node .github/scripts/notify-version.js --package=<name> --version=<x.y.z[-pre]> --channel=<dist-tag>
 * Env:   VERSION_API_URL, VERSION_API_KEY
 */

const channelTarget = require('./npm-channel-target.js')

const MAX_ATTEMPTS = 3
// Backoff before attempt 2 and 3.
const DELAYS_MS = [10_000, 30_000]
const TIMEOUT_MS = 30_000
const GEO_BLOCK_MARKER = 'block access from your country'

function isRetryable({ status, networkError }) {
  if (networkError !== undefined) return true
  return status >= 500 || status === 429 || status === 403
}

async function main({
  argv,
  env,
  resolveTarget = channelTarget.resolveTarget,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  error = console.error,
  maxAttempts = MAX_ATTEMPTS,
  delaysMs = DELAYS_MS,
  timeoutMs = TIMEOUT_MS,
}) {
  let outcome = {}
  let body = ''
  try {
    const { packageName, version, channel } = channelTarget.parseArgs(argv)
    const apiUrl = env.VERSION_API_URL
    const apiKey = env.VERSION_API_KEY
    if (!apiUrl || !apiKey) {
      log('::warning::AGENT_VERSION_API_URL or AGENT_VERSION_API_KEY is not set. Skipping version notification.')
      return 0
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Re-resolved per attempt: the channel may have moved during the backoff.
      const target = await resolveTarget({ packageName, version, channel, log })
      body = ''
      try {
        const res = await fetchImpl(`${apiUrl}/api/agent/version`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          body: JSON.stringify({ channel, latestVersion: target }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        body = await res.text()
        outcome = { status: res.status }
      } catch (e) {
        outcome = { networkError: e }
      }
      const detail =
        outcome.networkError !== undefined
          ? `connection error: ${outcome.networkError instanceof Error ? outcome.networkError.message : String(outcome.networkError)}`
          : `HTTP ${outcome.status}`
      log(`Attempt ${attempt}/${maxAttempts} (${channel} -> ${target}): ${body} (${detail})`)
      if (outcome.networkError === undefined && outcome.status >= 200 && outcome.status < 300) {
        return 0
      }
      if (!isRetryable(outcome) || attempt === maxAttempts) break
      await sleep(delaysMs[attempt - 1])
    }
    if (body.includes(GEO_BLOCK_MARKER)) {
      error(
        "::error::Version notification was blocked by the API's CloudFront geo restriction (the runner's egress IP is outside the allowed countries). npm and the GitHub Release are already published and the image jobs do not depend on this job; re-running only this job is safe.",
      )
    }
    const what =
      outcome.networkError !== undefined
        ? `a connection error (${outcome.networkError instanceof Error ? outcome.networkError.message : String(outcome.networkError)})`
        : `HTTP ${outcome.status}`
    error(`::error::Version notification failed with ${what}`)
    return 1
  } catch (e) {
    error(`::error::version notification failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

module.exports = { main, isRetryable, MAX_ATTEMPTS, DELAYS_MS, TIMEOUT_MS, GEO_BLOCK_MARKER }

if (require.main === module) {
  main({ argv: process.argv.slice(2), env: process.env }).then((code) => {
    process.exitCode = code
  })
}
