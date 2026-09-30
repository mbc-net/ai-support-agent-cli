# Keycloak server setup

This bundled role installs Docker Engine/Compose and runs a single Keycloak
instance with PostgreSQL. It supports Ubuntu 22.04/24.04 on amd64/arm64.
The initial versions are Keycloak 26.7.4 and PostgreSQL 16.15. Image repositories,
installation directory (`/opt/ai-support-keycloak`), Compose project
(`ai-support-keycloak`), database name/user and volume identity are fixed.
Only one deployment per host is supported. This role does not configure realms,
OIDC clients, application login, clustering or a new HTTPS reverse proxy.

## Prerequisites and example

Before running, prepare DNS and a trusted TLS certificate for the public URL.
Configure an existing **host** reverse proxy to forward to `127.0.0.1:8080`
(or the configured `keycloak_http_port`). Use the origin only, without a trailing
slash, URL path, query or credentials. The proxy must **overwrite**, rather than
append to or pass through, client-supplied forwarding headers. Host proxies
must run in the host network namespace; an ordinary bridge-network proxy cannot
connect to this loopback listener.

For nginx, the existing HTTPS virtual host's location can contain:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

If the external HTTPS port is not 443, set the correct forwarding port and
include it in `keycloak_hostname`. Configure restricted administration access
in the existing proxy as appropriate for the deployment.

The trusted proxy address is the source IP **as seen by the container**. With a
host proxy, Docker may translate this to the frontend network's bridge gateway.
After networks exist, obtain that address without inspecting environment values:

```sh
docker network inspect ai-support-keycloak_frontend --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Use the actual gateway IP or narrow trusted CIDR in the recipe; `172.18.0.1`
below is an example, not a universal default. IPv4/IPv6 addresses and CIDRs are
accepted; empty lists, invalid addresses and `/0` are rejected. Restrict the
trusted addresses to your proxy. A wrong value can cause login/origin failures
even if discovery is reachable. Network creation may finish before a failed
first public-URL check; correct the trusted address and rerun without deleting
the project or volume.

Create two project variables with `ANSIBLE#` names, mark them secret and select
the corresponding reference from the variable insertion menu. Both passwords
must have at least 12 characters, with no control characters or leading/trailing
whitespace. Dollar signs and quotes are preserved through Compose escaping and
Keycloak KCRAW_ settings; multiline passwords are rejected before installation
because they fail JDBC authentication. Keycloak versions older than 26.7.4 are
rejected to keep the tested raw-secret configuration supported.

```yaml
- name: Keycloak
  ansible.builtin.include_role:
    name: keycloak
  vars:
    keycloak_hostname: https://sso.example.com
    keycloak_proxy_headers: xforwarded
    keycloak_proxy_trusted_addresses:
      - 172.18.0.1
    keycloak_admin_username: bootstrap-admin
    keycloak_admin_password: "{{ KEYCLOAK_ADMIN_PASSWORD }}"
    keycloak_db_password: "{{ KEYCLOAK_DB_PASSWORD }}"
```

`forwarded` is also supported when the proxy overwrites the RFC Forwarded header
instead of `X-Forwarded-*`. The role verifies certificate trust and the issuer
in the public master-realm OIDC discovery document from the target host. DNS,
proxy or certificate failures fail the execution, retaining the running services
and database. The target host's system certificate trust must include the CA;
certificate checking cannot be disabled by recipe variables.

| Variable | Default | Meaning |
|---|---|---|
| `keycloak_version` | `26.7.4` | Explicit Keycloak 26.x.y tag, at least 26.7.4 |
| `keycloak_postgres_version` | `16.15` | Explicit PostgreSQL 16.x tag |
| `keycloak_hostname` | empty, required | Public HTTPS origin |
| `keycloak_http_port` | `8080` | Host loopback port, 1024–65535 |
| `keycloak_proxy_headers` | `xforwarded` | `forwarded` or `xforwarded` |
| `keycloak_proxy_trusted_addresses` | empty, required | Proxy IP/CIDR list |
| `keycloak_admin_username` | `bootstrap-admin` | First-bootstrap username |
| `keycloak_admin_password` | empty, required | First-bootstrap secret |
| `keycloak_db_password` | empty, required | PostgreSQL authentication secret |
| `keycloak_start_timeout` | `300` | Each Compose wait timeout, 30–1800 seconds |

## Secrets, persistence and reruns

Configuration is root-owned mode `0600` in a root-owned `0700` directory.
Tasks that process secret values suppress logs and diffs. Role result variables
are reserved by the API and Agent guards, preventing subsequent recipe tasks
from reading or forging their values. Host root and Docker administrators can
still access container environment variables; these are trusted operators.
Do not publish `docker inspect`, `docker compose config` or environment dumps.

PostgreSQL has no host port and uses a private internal network and named volume
`ai-support-keycloak_postgres-data`. Management port 9000 is not published.
The role waits for PostgreSQL, checks TCP password authentication against the PostgreSQL service network
address (loopback may use trust authentication) with
`SELECT 1`, and only then starts/recreates Keycloak. It then waits for readiness
and verifies the public HTTPS discovery document and expected issuer.

Identical reruns do not recreate healthy containers. Restart policies restore
services when Docker restarts; the database volume survives container recreation.
Do not use `down --volumes` or remove the named volume to retry a failure.
Back up the database before version changes, and follow Keycloak's upgrade guide.
PostgreSQL major upgrades are intentionally rejected by this role.

### Database password changes

`POSTGRES_PASSWORD` only initializes a new database. Changing the project secret
alone does not update the persisted database user's password. The role detects
the mismatch and fails **before recreating Keycloak**; existing data is retained.
The new configuration may already be written and PostgreSQL recreated, so restore
the previous secret and rerun to return the configuration to its previous value.

For planned rotation, use a maintenance window:

1. Stop Keycloak using the fixed Compose file/project to avoid repeated failed
   logins during rotation. Do not remove PostgreSQL or its volume.
2. Open an interactive local PostgreSQL session:
   `sudo docker compose -p ai-support-keycloak -f /opt/ai-support-keycloak/compose.yml exec postgres psql -U keycloak -d keycloak`.
3. Run `\password keycloak` and enter the new password at the prompts, avoiding
   password values in command lines, SQL history or shared logs.
4. Update the secret project variable to the same value and rerun the recipe.
   The TCP authentication check must pass before Keycloak restarts.

### Bootstrap administrator changes

The bootstrap settings create a temporary administrator **only when the database
has not been initialized**. Changing those values and rerunning does not reset an
existing account. Complete initial setup by creating a permanent administrator
and deleting the temporary bootstrap account in Keycloak. Manage existing account
passwords through the Admin Console or supported admin recovery procedure.
This role never deletes realms, users or database data to re-bootstrap.

## Verification

```sh
npm test -- --selectProjects unit --runInBand --runTestsByPath __tests__/server-setup/keycloak-guard.spec.ts __tests__/server-setup/keycloak-role.spec.ts __tests__/server-setup/include-role-vars-allowlist.spec.ts
ANSIBLE_PLAYBOOK=/path/to/ansible-playbook python3 __tests__/server-setup/keycloak-validation.py
ANSIBLE_PLAYBOOK=/path/to/ansible-playbook /path/to/python-with-pyyaml __tests__/server-setup/keycloak-live.py
```

The live test uses real PostgreSQL/Keycloak and a disposable local TLS proxy.
It skips Docker provisioning, rewrites fixed paths/project names, assigns files
to the test user and trusts its own fixture CA. It checks secret escaping,
initial administrator login, identical reruns, restart persistence, bootstrap
password changes, DB-password mismatch, HTTPS outage and certificate mismatch.
Only this test's isolated project and volume are removed during cleanup.
Docker provisioning and the actual target host's proxy/DNS remain deployment
prerequisites and are not established by this fixture.

Official references:
[containers](https://www.keycloak.org/server/containers),
[reverse proxy](https://www.keycloak.org/server/reverseproxy),
[health checks](https://www.keycloak.org/observability/health),
[Keycloak 26.7.4](https://www.keycloak.org/2026/09/keycloak-2674-released),
[PostgreSQL 16.15](https://www.postgresql.org/docs/16/release-16-15.html).

## Implementation verification record (2026-09-30)

Work was isolated on `feature/keycloak-server-setup` in the sibling
`agent-worktrees/keycloak-server-setup`, `api-worktrees/keycloak-server-setup`
and `web-worktrees/keycloak-server-setup` directories. The existing API
`prisma/dynamodbs/cqrs.json` edit was preserved in the original checkout.
No commit or deployment was performed.

TDD red checks before implementation:

- Agent: `npm test -- --selectProjects unit --runInBand --runTestsByPath __tests__/server-setup/keycloak-guard.spec.ts __tests__/server-setup/keycloak-role.spec.ts`.
  Eight tests failed because the role files were missing, the role was not allowed,
  and its result-variable names were not protected.
- API: `npm run test:unit -- --runInBand --runTestsByPath src/server-setup/__tests__/keycloak-guard.spec.ts`.
  Six tests failed for the absent role allowance and result-variable protections.
- Web: `npm test -- --runInBand --runTestsByPath src/lib/server-setup/__tests__/keycloak-snippet.test.ts`.
  Failed because the Keycloak snippet did not exist.

Green checks:

- Agent unit suite: 302 suites / 8,026 tests passed. Explicit server-setup-only
  rerun (`--runTestsByPath __tests__/server-setup/*.spec.ts`): 23 suites / 868 tests
  passed. Role safety/allowlist tests also passed after the final corrections.
- API guard tests: 202 passed; `npm run build:prod` passed.
- Web snippet/stack/editor tests: 210 passed; `npm run typecheck` and
  `npm run build` passed. Targeted ESLint for the new snippet/test passed.
- Agent `npm run build`, Ansible input-validation tests, yamllint,
  ansible-lint (including syntax checks) and `git diff --check` passed.
- API and Agent public/internal Keycloak variable lists were compared and match.

API ESLint's standard configuration reports 20 pre-existing Prettier errors in
`ansible-task-guard.ts`; the exact same errors were reproduced with the HEAD
version through `--stdin --stdin-filename`. No broad formatting change was made.
Targeted API lint excluding that existing formatting rule passed. Ansible lint
reports only naming warnings under the existing repository configuration.

Review corrections included raw secret preservation and rejection of unsupported
multiline secrets; genuine DB password authentication through the service network
instead of loopback trust; and rejection of invalid HTTPS origin ports. The live
regression test exposed the loopback authentication problem before completion.

Fresh Ubuntu Docker provisioning, actual production DNS/proxy/certificate setup,
and browser E2E were not executed. The Docker provisioning role is reused
unchanged; editor/menu behavior was covered by component tests. Real database and
Keycloak tests use the isolated fixture described above rather than production.

The final live Docker/Ansible regression test passed (253.991 seconds): initial
login with dollar/expression/quote passwords, unchanged reruns, restart data
persistence, unchanged existing administrator after bootstrap-setting changes,
DB-password mismatch stopping before Keycloak recreation, public HTTPS outage,
certificate hostname mismatch and subsequent recovery. Its containers, networks
and database volume were removed by the fixture's successful cleanup.

Three review rounds were completed (initial review, correction review, final
recheck). Final result: no outstanding CRITICAL/HIGH or new validation failures.
The existing formatting diagnostics and deployment prerequisites above remain.
