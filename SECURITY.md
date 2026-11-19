# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.0.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please use [GitHub Security Advisories](https://github.com/mbc-net/ai-support-agent-client/security/advisories/new) to report vulnerabilities privately.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: within 48 hours of report
- **Initial assessment**: within 5 business days
- **Fix target**: patch release within 30 days for confirmed vulnerabilities

## Scope

### In Scope

- Authentication bypass or token leakage
- Command injection
- Path traversal
- Sensitive data exposure
- Dependency vulnerabilities with exploitable impact

### Out of Scope

- Denial of service attacks
- Social engineering
- Issues in dependencies without a demonstrated exploit path
- Issues requiring physical access to the user's machine

## Disclosure

We follow coordinated disclosure. We will work with you to understand and address the issue before any public disclosure.

## Dependency mitigation: picomatch (2026-11-18)

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
reports exponential backtracking in repeated extglobs. No patched stable
picomatch release was available when this mitigation was prepared.

Production Glob and Grep use minimatch 11's non-regex matcher instead of
picomatch. The existing Worker isolation and timeout remain in place for
untrusted search inputs. Production dependencies contain no picomatch.

Jest/ts-jest still depend on picomatch for development-time test discovery.
The exception in `.github/npm-audit-exclusions.json` is limited to this advisory
and expires on 2026-12-18. The unchanged audit gate checks on every run that no
patched stable release exists and that the advisory is absent from production
dependencies; it fails if either condition changes. Remove the exception and
update the test dependencies when a patched release becomes available.

Validation: `node .github/scripts/npm-audit-gate.js --audit-level=high`,
`npm audit --omit=dev`, and the Glob/Grep security and compatibility tests.
This mitigation does not claim that all lower-severity development or production
dependency advisories have been resolved.

## SSH host-key pins and local browser IPC

The ssh2 command, database tunnel, and SSH-backed RDP paths require a trusted
`hostKeyFingerprint` in OpenSSH `SHA256:` format. Configure this value from the
server console or another authenticated management channel before upgrading.
Missing, malformed, or changed pins refuse the connection before authentication;
never copy a fingerprint learned from an unverified connection. Rotate the stored
pin explicitly when the server host key changes. OpenSSH-based interactive terminal
and server setup paths continue using their existing persistent known_hosts policy.

The browser IPC listener binds to loopback and requires a random bearer token.
The agent supplies it to its MCP clients through protected configuration and child
environment (`AI_SUPPORT_BROWSER_LOCAL_TOKEN`). Direct integrations must supply
that token; a local port number alone no longer authorizes browser operations.
Browser-origin requests are rejected and request bodies are limited to 1 MiB.
