/**
 * Cross-checks docker/Dockerfile's `COPY docker/...` sources against
 * src/docker/dockerfile-sync.ts's OPTIONAL_DOCKER_ASSETS.
 *
 * syncDockerfileToConfigDir() only copies files listed in
 * OPTIONAL_DOCKER_ASSETS into the user's config dir before `docker build`
 * runs against that dir as its build context (see dockerfile-path.ts's
 * resolveDockerfile()). Any `COPY docker/...` source in the Dockerfile that
 * is missing from OPTIONAL_DOCKER_ASSETS breaks `docker build` for every
 * user on their next build with a "file not found in build context" error —
 * this is not a hypothetical: it happened for docker/starship.toml (added
 * alongside a tmux.conf/starship prompt fix without updating this list).
 *
 * This test reads the real, committed docker/Dockerfile (no mocking) so it
 * catches the drift regardless of which future asset introduces it.
 */

import * as fs from 'fs'
import * as path from 'path'
import { OPTIONAL_DOCKER_ASSETS } from '../../src/docker/dockerfile-sync'

const DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')

/** docker/entrypoint.sh is COPYed to /entrypoint.sh, not under docker/ in the image, but its SOURCE is docker/entrypoint.sh. */
describe('docker/Dockerfile COPY sources are all registered for config-dir sync', () => {
  it('every "COPY docker/..." source in the Dockerfile is listed in OPTIONAL_DOCKER_ASSETS', () => {
    const dockerfileContent = fs.readFileSync(DOCKERFILE, 'utf-8')
    const copySources = [...dockerfileContent.matchAll(/^COPY\s+(docker\/\S+)\s+\S+/gm)].map(
      (m) => m[1],
    )

    // Sanity check: the Dockerfile does actually COPY files from docker/ —
    // if this becomes empty the regex above stopped matching (e.g. Dockerfile
    // switched to a different COPY style) and the test below would pass
    // vacuously without checking anything.
    expect(copySources.length).toBeGreaterThan(0)

    const registered = new Set(OPTIONAL_DOCKER_ASSETS.map((p) => p.split(path.sep).join('/')))
    const unregistered = copySources.filter((src) => !registered.has(src))

    expect(unregistered).toEqual([])
  })
})
