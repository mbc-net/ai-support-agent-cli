/**
 * Pins the runtime facts of the agent image after the move from
 * `node:24-slim` (Debian 12, Python 3.11, ansible-core 2.16/2.17) to
 * `ubuntu:26.04` (Python 3.14, ansible-core 2.20).
 *
 * Reads the committed docker/Dockerfile and package.json (no fs mocking).
 * Each assertion guards a fact that was verified against a real image build;
 * a silent revert of any of them breaks the image at runtime rather than at
 * build time (wrong HOME user, unauthenticated Node download, playwright deps
 * that refuse the distribution, an ansible-core that does not support the
 * image's Python, ...).
 */

import * as fs from 'fs'
import * as path from 'path'

const DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')
const PACKAGE_JSON = path.resolve(__dirname, '../../package.json')

/** Dockerfile with comment lines removed and line continuations joined. */
function normalizedCode(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

describe('docker/Dockerfile — Ubuntu 26.04 base', () => {
  let content: string
  let code: string

  beforeAll(() => {
    content = fs.readFileSync(DOCKERFILE, 'utf-8')
    code = normalizedCode(content)
  })

  it('builds FROM ubuntu:26.04 (the only FROM in the file)', () => {
    const froms = content.split('\n').filter((line) => /^FROM\s/.test(line))
    expect(froms).toEqual(['FROM ubuntu:26.04'])
  })

  describe('Node.js runtime (replaces the node:24 base image)', () => {
    it('pins Node 24 to an exact version', () => {
      expect(content).toMatch(/^ARG NODE_VERSION=24\.\d+\.\d+$/m)
    })

    it('pins a SHA-256 per architecture and verifies the tarball before extracting it', () => {
      expect(content).toMatch(/^ARG NODE_SHA256_X64=[0-9a-f]{64}$/m)
      expect(content).toMatch(/^ARG NODE_SHA256_ARM64=[0-9a-f]{64}$/m)
      const verify = code.indexOf('echo "${NODE_SHA256} /tmp/node.tar.xz" | sha256sum -c -')
      const extract = code.indexOf('tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1')
      expect(verify).toBeGreaterThan(-1)
      expect(extract).toBeGreaterThan(verify)
    })

    it('downloads the official nodejs.org release tarball (Ubuntu 26.04 only packages Node 22)', () => {
      expect(code).toContain(
        'curl -fSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"',
      )
      expect(code).toMatch(/amd64\) NODE_ARCH="x64"; NODE_SHA256="\$NODE_SHA256_X64"/)
      expect(code).toMatch(/arm64\) NODE_ARCH="arm64"; NODE_SHA256="\$NODE_SHA256_ARM64"/)
    })

    it('fails the build on an unsupported architecture instead of guessing one', () => {
      expect(code).toMatch(/\*\) echo "ERROR: unsupported architecture for Node\.js: \$ARCH" >&2; exit 1 ;;/)
    })

    it('installs into /usr/local so npm\'s global prefix stays /usr/local (docker-utils.ts mounts into /usr/local/lib/node_modules/@ai-support-agent/cli)', () => {
      expect(code).toContain('-C /usr/local --strip-components=1')
      expect(code).toContain('[ "$(node --version)" = "v${NODE_VERSION}" ]')
    })

    it('keeps Yarn classic like the node:24 images did', () => {
      expect(content).toMatch(/^ARG YARN_VERSION=1\.\d+\.\d+$/m)
      expect(code).toContain('npm install -g "yarn@${YARN_VERSION}"')
    })

    it('declares no CMD: setting ENTRYPOINT already discarded the base image CMD, so the node:24-slim-based image had none either', () => {
      expect(content).not.toMatch(/^CMD\s/m)
      expect(content.trimEnd().split('\n').pop()).toBe('ENTRYPOINT ["/entrypoint.sh"]')
    })
  })

  describe('`node` user (CONTAINER_HOME=/home/node)', () => {
    it('renames ubuntu:26.04\'s uid-1000 `ubuntu` user to `node` with HOME /home/node and verifies the result', () => {
      expect(code).toContain('usermod -l node -d /home/node -m -c \'\' ubuntu')
      expect(code).toContain('groupmod -n node ubuntu')
      expect(code).toContain('[ "$(getent passwd node)" = "node:x:1000:1000::/home/node:/bin/bash" ]')
      expect(code).toContain('[ "$(getent group node)" = "node:x:1000:" ]')
    })

    it('matches CONTAINER_HOME in src/constants.ts', () => {
      const constants = fs.readFileSync(path.resolve(__dirname, '../../src/constants.ts'), 'utf-8')
      expect(constants).toMatch(/export const CONTAINER_HOME = '\/home\/node'/)
    })
  })

  describe('Ubuntu 26.04 package names', () => {
    it('installs bind9-dnsutils (Ubuntu 26.04 has no dnsutils package)', () => {
      expect(code).toMatch(/\bbind9-dnsutils\b/)
      expect(code).not.toMatch(/(?<![\w-])dnsutils\b/)
    })

    it('installs xz-utils (for the Node tarball) and tzdata (for the forwarded TZ), which ubuntu:26.04 lacks', () => {
      expect(code).toMatch(/apt-get install -y --no-install-recommends[^&]*\bxz-utils\b[^&]*\btzdata\b/)
    })

    it('generates and verifies the en_US.UTF-8 locale', () => {
      expect(code).toContain("locale-gen en_US.UTF-8 && locale -a | grep -qx 'en_US.utf8'")
      expect(content).toMatch(/^ENV LANG=en_US\.UTF-8 LC_ALL=en_US\.UTF-8$/m)
    })

    it('keeps DEBIAN_FRONTEND build-only (ARG, never ENV)', () => {
      expect(content).toMatch(/^ARG DEBIAN_FRONTEND=noninteractive$/m)
      expect(content).not.toMatch(/^ENV .*DEBIAN_FRONTEND/m)
    })

    it('uses Microsoft\'s Ubuntu 26.04 repository with the 2025 signing key, failing on HTTP errors', () => {
      expect(code).toContain('curl -fsSL https://packages.microsoft.com/keys/microsoft-2025.asc | gpg --dearmor')
      expect(code).toContain('https://packages.microsoft.com/ubuntu/26.04/prod resolute main')
      expect(code).not.toMatch(/packages\.microsoft\.com\/debian/)
    })

    it('no longer references the Debian base (debian-archive-keyring / bookworm repositories)', () => {
      expect(code).not.toMatch(/debian-archive-keyring/)
      expect(code).not.toMatch(/\bbookworm\b/)
    })
  })

  describe('Python 3.14 / ansible-core 2.20', () => {
    it('pins ansible-core to the 2.20 line (first line supporting Python 3.14 as controller)', () => {
      const pins = code.match(/'ansible-core[^']*'/g)
      expect(pins).toEqual(["'ansible-core>=2.20,<2.21'"])
    })

    it('uses lxml 6 (lxml 5 has no CPython 3.14 wheel and fails to build)', () => {
      expect(code).toMatch(/\blxml==6\.\*/)
      expect(code).not.toMatch(/\blxml==5\./)
    })

    it('installs Python packages system-wide with --break-system-packages (PEP 668 on Ubuntu 26.04)', () => {
      expect(code).toContain('pip3 install --no-cache-dir --break-system-packages')
    })

    it('CI installs the same ansible-core range on the same Python as the image', () => {
      const workflows = ['ansible-roles.yml', 'ci-cd.yml'].map((name) =>
        fs.readFileSync(path.resolve(__dirname, '../../.github/workflows', name), 'utf-8'),
      )
      const ciSpecs = workflows.flatMap((wf) => wf.match(/ansible-core>=[\d.]+,<[\d.]+/g) ?? [])
      expect(ciSpecs.length).toBeGreaterThanOrEqual(2)
      expect(new Set(ciSpecs)).toEqual(new Set(['ansible-core>=2.20,<2.21']))

      const pythonVersions = workflows.flatMap((wf) =>
        [...wf.matchAll(/python-version:\s*['"]?([\d.]+)['"]?/g)].map((m) => m[1]),
      )
      expect(pythonVersions.length).toBeGreaterThanOrEqual(3)
      expect(new Set(pythonVersions)).toEqual(new Set(['3.14']))
    })

    it('every test image under ansible/tests pins the same ansible-core range as the image', () => {
      const testDockerfiles = fs
        .readdirSync(path.resolve(__dirname, '../../ansible/tests'))
        .filter((name) => name.startsWith('Dockerfile'))
      expect(testDockerfiles.length).toBeGreaterThan(0)
      for (const name of testDockerfiles) {
        const content = fs.readFileSync(path.resolve(__dirname, '../../ansible/tests', name), 'utf-8')
        const specs = content.match(/ansible-core[<>=!~][^'"\s]*/g) ?? []
        expect({name, specs: [...new Set(specs)]}).toEqual({name, specs: specs.length ? ['ansible-core>=2.20,<2.21'] : []})
      }
    })
  })

  describe('Playwright OS dependencies', () => {
    let deps: string

    beforeAll(() => {
      const match = content.match(/^ARG PLAYWRIGHT_DEPS_VERSION=(\d+\.\d+\.\d+)$/m)
      expect(match).not.toBeNull()
      deps = match![1]
    })

    it('runs install-deps with the pinned playwright, not whatever `npx playwright` resolves to', () => {
      expect(code).toContain('npx --yes "playwright@${PLAYWRIGHT_DEPS_VERSION}" install-deps chromium')
      expect(code).not.toMatch(/npx --yes playwright install-deps/)
    })

    it('pins a playwright that supports ubuntu26.04 in install-deps (>= 1.62)', () => {
      expect(compareSemver(deps, '1.62.0')).toBeGreaterThanOrEqual(0)
    })

    it('is not older than the floor of package.json\'s playwright range (the version Layer 6 installs)', () => {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'))
      const ranges = [pkg.optionalDependencies?.playwright, pkg.devDependencies?.['@playwright/test'], pkg.optionalDependencies?.['@playwright/test']]
        .filter((range): range is string => typeof range === 'string')
      expect(ranges.length).toBeGreaterThan(0)
      for (const range of ranges) {
        const floor = range.match(/^\^(\d+\.\d+\.\d+)$/)
        expect(floor).not.toBeNull()
        expect(compareSemver(floor![1], '1.62.0')).toBeGreaterThanOrEqual(0)
        expect(compareSemver(deps, floor![1])).toBeGreaterThanOrEqual(0)
      }
    })
  })
})
