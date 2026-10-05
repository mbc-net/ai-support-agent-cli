'use strict'

/**
 * The uncached npm registry reads used by the release workflow. Nothing in the
 * release path reads npm through `npm view`: that reads the packument, which the
 * registry CDN caches for up to 300 s (cache-control: max-age=300). Both
 * endpoints read here are served uncached (cf-cache-status: DYNAMIC, measured
 * 2026-10-05).
 *
 * 1. npm's channel holder (dist-tags[channel]): the single read path, used by
 *    npm-publish-tag.js (the publish job's dist-tag decision) and by
 *    npm-channel-target.js (the target that move_channel_tag and, through
 *    notify-version.js, notify_version reconcile to).
 *    Reads https://registry.npmjs.org/-/package/<pkg>/dist-tags. A stale holder
 *    is dangerous in both places:
 *      - publish: the decision could be made against the holder from before the
 *        previous locked publish;
 *      - channel target: within 300 s after a newer release, a re-run of an older
 *        tag could read a cached holder == its own (old) version, treat it as
 *        ready and roll GHCR :latest/:beta and the API back.
 *
 * 2. The per-version manifest, used by npm-version-published.js (is
 *    <pkg>@<version> already published, and from which commit?).
 *    Reads https://registry.npmjs.org/<pkg>/<version>. A cached packument would
 *    still say "not found" for up to 300 s after a publish, so an immediate
 *    re-run would try `npm publish` again (E403) or disagree with the uncached
 *    dist-tag read.
 *
 * Scoped names have their "/" encoded as %2f; the version is encoded as one path
 * segment.
 *
 * Fail-closed: the fetch helpers reject on connection errors and on timeout
 * (TIMEOUT_MS) and return { status, body } otherwise; the interpreting callers
 * throw on any status or body they do not expect. Nobody guesses.
 */

const REGISTRY = 'https://registry.npmjs.org'
const TIMEOUT_MS = 30_000

function encodePackageName(packageName) {
  return packageName.replace('/', '%2f')
}

function distTagsUrl(packageName) {
  return `${REGISTRY}/-/package/${encodePackageName(packageName)}/dist-tags`
}

function versionManifestUrl(packageName, version) {
  return `${REGISTRY}/${encodePackageName(packageName)}/${encodeURIComponent(version)}`
}

/**
 * GETs url. Returns { status, body }; rejects on connection errors and on
 * timeout. fetchImpl defaults to globalThis.fetch at call time.
 */
async function getText(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: res.status, body: await res.text() }
}

/** GETs the dist-tags endpoint (see getText). */
async function fetchDistTags(packageName, options) {
  return getText(distTagsUrl(packageName), options)
}

/** GETs the per-version manifest (see getText). 404 = that version is not published. */
async function fetchVersionManifest(packageName, version, options) {
  return getText(versionManifestUrl(packageName, version), options)
}

/** Returns dist-tags[channel] (trimmed) or undefined. Throws on an untrustworthy result. */
function readHolder(result, channel) {
  const body = String(result.body ?? '').trim()
  if (result.status !== 200) {
    throw new Error(`dist-tags lookup returned HTTP ${result.status}; cannot tell which version holds "${channel}" (body: ${body})`)
  }
  let value
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error(`unexpected dist-tags response; expected a JSON object (body: ${body})`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unexpected dist-tags response; expected a JSON object (body: ${body})`)
  }
  const holder = value[channel]
  if (holder === undefined) return undefined
  if (typeof holder !== 'string') {
    throw new Error(`unexpected dist-tag "${channel}" value ${JSON.stringify(holder)}`)
  }
  return holder.trim()
}

module.exports = {
  REGISTRY,
  TIMEOUT_MS,
  distTagsUrl,
  fetchDistTags,
  readHolder,
  versionManifestUrl,
  fetchVersionManifest,
}
