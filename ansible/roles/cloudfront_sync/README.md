# CloudFront origin-facing range synchronization

This bundled role installs a target-host systemd timer and a root-only synchronization engine. The default invocation installs and prints a plan; it does not apply that plan or enable the timer. It does not change SSH rules, enable UFW, alter UFW defaults, or rewrite nginx bundles.

Provide `cloudfront_sync_host_address` and, when managing nginx, configure and review the shared includes before running the role. Preserve `geo $realip_remote_addr`, `real_ip_header X-Forwarded-For`, `real_ip_recursive off` and each existing origin verification map. Only the two shared range files are managed by the engine. The role accepts Ubuntu 22.04, 24.04 and 26.04; production release still requires the approved disposable-VM checks for each OS.

Use a server's HOST-scoped `CFSYNC_*` variables. Project variables arrive as strings: use `from_json` for JSON booleans, numbers and arrays, rather than registering public `cloudfront_sync_*` names as extra-vars. The public variables and defaults are in `defaults/main.yml`.

## Operations

The engine uses a fixed config (`/etc/cloudfront-sync/config.json`), private state (`/var/lib/cloudfront-sync/private/`, root-only), and public status (`/var/lib/cloudfront-sync/status.json`, no secret configuration). It accepts these commands through reviewed AI Support Agent command tasks:

- `preflight`: check host identity, SSH ports, effective configuration and confirmed state.
- `plan`: fetch AWS data, show additions/deletions and issue an expiring approval token.
- `apply --approve=TOKEN`: apply exactly the plan bound to that host, configuration, live baseline and AWS publication. A subsequent role invocation supplies `cloudfront_sync_approve_token` and does not regenerate the plan first.
- `import-plan --legacy-state /absolute/root-owned/state.json`: verify legacy ranges against the actual UFW and shared nginx configuration. This does not claim every rule on port 443.
- `import --approve=TOKEN`: transfer ownership of exactly those verified existing rules, without rewriting their comments. Import alone does not count as a successful AWS synchronization and cannot enable the timer.
- `sync`: automatic mode; first apply and changes outside the count/per-family ratio limits fail for approval. Default limits are 10 changed CIDRs and ratio 0.8 in each address family.

Arguments use the form `python3 /usr/local/libexec/cloudfront-sync/cloudfront-sync.py --config /etc/cloudfront-sync/config.json COMMAND`. The `--lock-fd` switch is only for the trusted installer holding the same exclusive lock; callers must not invent a descriptor.

Timer enablement requires confirmed initialized state with a successful AWS synchronization. Its schedule is hourly with a random delay up to 15 minutes. A changed configuration or external policy edit fails closed; this release does not automatically rebaseline configuration changes.

## Installation recovery

The installer holds a separate deployment lock, records the prior timer state, disables/stops the timer persistently, waits for a running sync to finish and takes the engine lock. It verifies all assets and preflight before planning or applying. Failed pre-apply updates restore and preflight the previous installation before restoring its timer. Busy sync lock acquisition restores the original timer without touching assets.

A journal marks an apply attempt before launching the engine. If the engine's committed state changed or a runtime journal remains, installation recovery keeps the coherent candidate installation, disables the timer and retains evidence for an operator. It never restores old code/configuration onto newly committed runtime policy. A failed/rejected apply may restore the old installation only when the state hash is unchanged and no runtime transaction remains. Never delete recovery journals merely to clear an alert.

## Monitoring

`files/zabbix-template.json` is a Zabbix 7.0 export for Agent 2 active checks. It is installed at `/usr/share/cloudfront-sync/zabbix-template.json`; import and link it explicitly on the Zabbix server. Import does not register a host or enable AI Support Agent notifications. `{$CFSYNC.MONITORING.ENABLED}` defaults to 0; set it to 1 only after the timer, active checks and problem/recovery routing have been verified. The default success-age threshold is 10800 seconds.

The template monitors unit failure, stale successful synchronization, missing status data, approval waiting and recovery failure. The agent reads only the public status; do not grant it access to private state. Keep existing drift/mail checks until the replacement monitoring, including general UFW/nginx drift checks, is verified.

## Verification

Python transaction tests run with:

```sh
python3 -m unittest discover -s ansible/roles/cloudfront_sync/files/tests -p 'test_*.py' -v
```

The `ansible/molecule/cloudfront_sync` scenario runs against a disposable privileged systemd container. It tests real UFW/nginx/systemd, initial plan-only behavior and idempotence, legacy import, approved apply, additions/deletions, nginx syntax/reload failure, partial firewall mutation/deletion, process-death recovery, rule order, foreign-rule preservation and HTTP service response. AWS fetches are deterministic fixtures only in the fault verifier; role converge uses the fixed AWS HTTPS endpoint.

The verifier requires `/run/cloudfront-sync-disposable-test` and mutates the test host's firewall and nginx. Never run it on an operational server. Container checks do not verify real VM network behavior, CloudFront delivery, or production Zabbix-to-AI notification delivery.

### Real-VM ingress acceptance

After running the isolated transaction fixture on a disposable VM, copy
`ansible/molecule/cloudfront_sync/vm_network_verify.py` to the VM as a root-owned
file and run it with `/usr/bin/python3` under sudo. The existing exact
root-only disposable marker must be present. Do not create that marker on an
operational host. The harness rejects containers and unrecognized bare metal.
It normally uses `systemd-detect-virt --vm`; Ubuntu22.04's older systemd can
instead use the exact Apple VZ DMI vendor/product/BIOS match, after container
rejection. Host-side Lima `vmType=vz` records corroborate that guest evidence.
The report includes `evidence_method` and `virtual_model`.

The harness creates only temporary guest network namespaces/veth interfaces and
one temporary nginx configuration. It checks16 actual IPv4/IPv6 ingress cases:
SSH reachability from allowed and denied sources, CloudFront-fixture source
permission, missing/wrong origin-header rejection, original-peer geo behavior
when X-Forwarded-For changes, and firewall rejection of outside sources even
with spoofed forwarding headers. The header value is a public test fixture.

Traffic uses plain HTTP on TCP443 to test UFW ingress and nginx policy. This is
not TLS certificate validation or delivery through a real CloudFront
distribution. Cleanup removes temporary namespaces/interfaces/configuration and
requires replayed/numbered UFW policy, sshd configuration, nginx configuration,
and synchronization configuration/private state hashes to remain unchanged.
The timer must be stopped and disabled and no synchronization service may be
running. These VM checks do not start production monitoring or update any
registered server.

Harness safety tests run without creating VMs or network interfaces:

```sh
python3 -m unittest discover -s ansible/molecule/cloudfront_sync/tests -v
```

These safety tests run in the CI static job. The VM network harness deliberately
is not part of the container Molecule scenario, since container success cannot
stand in for real-VM ingress evidence. Record per-OS VM results in the release
verification record separately from actual CloudFront/TLS and AI notification
acceptance.
