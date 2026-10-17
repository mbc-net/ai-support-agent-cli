/** Pure generation of server setup plays and their system precheck tasks. */
import { dump } from 'js-yaml'
import type { AnsibleTargetOs } from './ansible-task-guard'
import { inspectSentryTasks } from './sentry-policy'

/**
 * System-generated OS precheck task, prepended to every generated play (before
 * the tenant admin's body tasks). Tagged `always` so it runs regardless of any
 * task-level tags a body task might carry. Ubuntu 22.04/24.04/26.04 LTS is the
 * MVP scope (matching the bundled roles' assumptions) — a fixed allowlist, not
 * a general ">= 22.04" rule, so a future LTS (e.g. 28.04) still needs an
 * explicit addition here before it is accepted.
 */
const PRECHECK_TASK: Record<string, unknown> = {
  name: 'precheck : Verify supported OS',
  'ansible.builtin.fail': {
    msg:
      'Unsupported OS: {{ ansible_distribution }} {{ ansible_distribution_version }}. '
      + 'Only Ubuntu 22.04/24.04/26.04 LTS are supported by server setup execution.',
  },
  when:
    "ansible_distribution != 'Ubuntu' or ansible_distribution_version not in ['22.04', '24.04', '26.04']",
  tags: 'always',
}

/**
 * System-generated task that installs the `acl` package on the target, run as
 * root (it inherits the play's `become: true` — deliberately NOT `become:false`
 * like the no-escalation precheck tasks above) after the NOPASSWD-sudo assert
 * has already proved root escalation is possible.
 *
 * Why this is mandatory: every bundled role that switches to an unprivileged
 * `become_user` different from the SSH connection user
 * (nvm/claude_cli/codex/ai_support_agent/database) triggers Ansible's
 * become-to-unprivileged temp-file handoff, which grants that user access to
 * the AnsiballZ temp files via `setfacl`. `setfacl` ships in the `acl`
 * package, which a fresh Ubuntu host does NOT have installed. Without it —
 * and with no `pipelining`/`allow_world_readable_tmpfiles` fallback configured
 * — the first such task fails with "Failed to set permissions on the temporary
 * files Ansible needs to create when becoming an unprivileged user ... chmod:
 * invalid operator (expected +, -, or =, but found A)" (the `chmod ... A`
 * being Ansible's ACL-style fallback that GNU chmod rejects once setfacl is
 * unavailable). Installing `acl` here — before any body task — is the remedy
 * Ansible's own docs list first for this exact error, and fixes it structurally
 * for every role regardless of which the recipe body includes.
 *
 * Placed after `PRECHECK_TASK` so an unsupported OS fails the run before we
 * attempt apt; `cache_valid_time` avoids a redundant `apt update` when a role
 * (e.g. os_init/nvm) has already refreshed the cache in the same run.
 */
const ENSURE_ACL_TASK: Record<string, unknown> = {
  name: 'precheck : Ensure acl (setfacl) is installed',
  'ansible.builtin.apt': {
    name: 'acl',
    state: 'present',
    update_cache: true,
    cache_valid_time: 3600,
  },
  tags: 'always',
}

/**
 * System-generated fact-gathering task, run explicitly with `become: false`.
 * The play disables the implicit `gather_facts` (see `generatePlaybook`)
 * because that implicit task inherits the play's `become: true` — and the
 * fact-gathering module (`ansible.legacy.setup`) then fails outright on any
 * host whose SSH user lacks NOPASSWD sudo ("interactive authentication is
 * required"), before `PRECHECK_TASK` or any body task ever runs. The facts
 * this runner depends on (`ansible_distribution`/`ansible_distribution_version`,
 * read from `/etc/os-release`) do not require root, so gathering them without
 * privilege escalation is sufficient.
 */
const GATHER_FACTS_TASK: Record<string, unknown> = {
  name: 'precheck : Gather facts (no privilege escalation)',
  'ansible.builtin.setup': {},
  become: false,
  tags: 'always',
}

/**
 * `register` name for `SUDO_PRECHECK_PROBE_TASK`'s result. Ansible's `-e`
 * extra-vars (which is exactly how project `ANSIBLE#` variables reach the
 * play — see `runServerSetup`'s `extra-vars.json` write) **always** win over
 * a `register`ed variable, regardless of evaluation order. If a tenant admin
 * happened to name a project variable the same as this register target, its
 * value would silently shadow the probe result and corrupt
 * `SUDO_PRECHECK_ASSERT_TASK`'s `when` condition. This name is namespaced and
 * long enough to make an accidental collision practically impossible, and
 * `validateNoReservedVariableCollision` rejects the run outright (rather than
 * silently misbehaving) on the astronomically unlikely case a project
 * variable is named exactly this.
 */
export const SUDO_PROBE_REGISTER_VAR = '__ai_support_agent_server_setup_sudo_probe'

/**
 * Probes whether the SSH user can escalate via sudo without a password,
 * without itself escalating (`become: false`) and without failing the play
 * on a non-zero result (`failed_when: false`) — the result is inspected by
 * `SUDO_PRECHECK_ASSERT_TASK` instead, so the failure is reported with a
 * clear, actionable message rather than surfacing as an opaque module
 * execution failure.
 */
const SUDO_PRECHECK_PROBE_TASK: Record<string, unknown> = {
  name: 'precheck : Probe passwordless sudo',
  'ansible.builtin.command': { cmd: 'sudo -n true' },
  become: false,
  changed_when: false,
  failed_when: false,
  register: SUDO_PROBE_REGISTER_VAR,
  tags: 'always',
}

/**
 * Fails the play with an actionable message when `SUDO_PRECHECK_PROBE_TASK`
 * reported a non-zero return code (sudo required a password). Every bundled
 * role runs privileged tasks (apt/user/ufw/etc.), so NOPASSWD sudo is a hard
 * prerequisite for server setup — this is a deliberate design constraint, not
 * a feature this runner supports working around.
 */
const SUDO_PRECHECK_ASSERT_TASK: Record<string, unknown> = {
  name: 'precheck : Verify passwordless sudo',
  'ansible.builtin.fail': {
    msg:
      'Passwordless (NOPASSWD) sudo is required for server setup, but the SSH '
      + "user '{{ ansible_user }}' cannot escalate without a password on "
      + '{{ inventory_hostname }}. Grant NOPASSWD sudo to this user (e.g. a '
      + 'sudoers entry) and retry. Server setup does not support '
      + 'password-based sudo.',
  },
  when: `${SUDO_PROBE_REGISTER_VAR}.rc | default(1) != 0`,
  become: false,
  tags: 'always',
}

/**
 * `register` name for {@link WIN_WHOAMI_PROBE_TASK}'s result. Namespaced for the
 * same reason as {@link SUDO_PROBE_REGISTER_VAR}: extra-vars always outrank a
 * `register`ed variable, so a project (`ANSIBLE#`) variable of this name would
 * silently replace the probe result. Such a variable is rejected up front
 * (`runServerSetup` / the local runner), whatever the target OS.
 */
export const WIN_WHOAMI_REGISTER_VAR = '__ai_support_agent_server_setup_win_whoami'

/**
 * Windows OS precheck (replaces the Ubuntu `PRECHECK_TASK`). Windows Server
 * 2019 / 2022 / 2025 are identified by the build number, the third field of
 * `ansible_distribution_version` (P0 measured `10.0.20348.0` on Server 2022;
 * `ansible_distribution` is English even on the Japanese edition, so the
 * product name is not used). Build 17763 is shared with Windows 10 1809
 * (client), so `ansible_os_installation_type` must also be `Server` or
 * `Server Core` (P0 measured `Server` on Server 2022, admin-docs
 * `server-setup-windows-openssh.md` §10; `Server Core` is admitted because it
 * is common on servers and runs OpenSSH the same way, but was not measured in
 * P0). Placed right after fact gathering so a non-Windows host fails here
 * with a clear message instead of in `win_whoami`.
 */
const WINDOWS_PRECHECK_TASK: Record<string, unknown> = {
  name: 'precheck : Verify supported OS',
  'ansible.builtin.fail': {
    msg:
      'Unsupported OS: {{ ansible_distribution | default(\'unknown\') }} {{ ansible_distribution_version | default(\'\') }} '
      + '(installation type: {{ ansible_os_installation_type | default(\'unknown\') }}). '
      + 'Only Windows Server 2019/2022/2025 (build 17763/20348/26100, installation type Server or Server Core) are supported by server setup '
      + 'execution on Windows hosts; client editions are not supported.',
  },
  when:
    "ansible_os_family != 'Windows' or "
    + "(ansible_os_installation_type | default('')) not in ['Server', 'Server Core'] or "
    + "((ansible_distribution_version | default('')).split('.') | length) < 3 or "
    + "(ansible_distribution_version | default('')).split('.')[2] not in ['17763', '20348', '26100']",
  tags: 'always',
}

/**
 * Reads the connection user's token. Windows plays run with `become: false`
 * (an administrator logging in with a key gets an already-elevated session —
 * confirmed in P0 for both the built-in Administrator and another local
 * administrator), so this replaces the Linux NOPASSWD-sudo probe.
 */
const WIN_WHOAMI_PROBE_TASK: Record<string, unknown> = {
  name: 'precheck : Inspect the connection user token',
  'ansible.windows.win_whoami': {},
  changed_when: false,
  register: WIN_WHOAMI_REGISTER_VAR,
  tags: 'always',
}

/**
 * Fails the play unless the token has the Administrators group
 * (S-1-5-32-544) Enabled and a High Mandatory Level label (S-1-16-12288) —
 * the state P0 observed for administrator key logins. A filtered (UAC) token
 * carries Administrators as deny-only and a Medium label, and would fail here.
 */
const WIN_ELEVATION_ASSERT_TASK: Record<string, unknown> = {
  name: 'precheck : Verify the connection user is an elevated administrator',
  'ansible.builtin.assert': {
    that: [
      `${WIN_WHOAMI_REGISTER_VAR}.groups | selectattr('sid', 'equalto', 'S-1-5-32-544') | selectattr('attributes', 'contains', 'Enabled') | list | length > 0`,
      `${WIN_WHOAMI_REGISTER_VAR}.label.sid == 'S-1-16-12288'`,
    ],
    fail_msg:
      "Server setup on Windows requires the SSH user '{{ ansible_user }}' to log in as an elevated local "
      + 'administrator (Administrators group enabled, High Mandatory Level) on {{ inventory_hostname }}. '
      + 'Add the user to the local Administrators group, register its public key in '
      + 'C:\\ProgramData\\ssh\\administrators_authorized_keys, and keep the default '
      + '"Match Group administrators" block in sshd_config.',
    quiet: true,
  },
  tags: 'always',
}

const SENTRY_SCRIPT = '/usr/local/lib/ai-support-sentry/sentry_setup.py'
const SENTRY_PREFLIGHT_CODE = "import os,subprocess,sys; p='" + SENTRY_SCRIPT + "'; sys.exit(subprocess.call(['/usr/bin/python3',p,'preflight',sys.argv[1]]) if os.path.exists(p) else 0)"
export const SENTRY_STATE_CODE = "import os,subprocess,sys; p='" + SENTRY_SCRIPT + "'; sys.exit(subprocess.call(['/usr/bin/python3',p]+sys.argv[1:]) if os.path.exists(p) else (print('{\"settled\":true,\"phase\":\"absent\"}') or 0))"
export function sentryPreflightTask(operation = 'install'): Record<string, unknown> {
  return { name: 'precheck : Verify Sentry host has no unresolved operation',
    'ansible.builtin.command': {argv: ['/usr/bin/python3', '-c', SENTRY_PREFLIGHT_CODE, operation]}, changed_when: false }
}

/**
 * Windows play (admin-docs `server-setup-windows-openssh.md` §5.4): `become:
 * false`, the same explicit fact gathering, then the Windows OS precheck and
 * the elevated-administrator check — no sudo probe, no Ubuntu precheck, no
 * Sentry preflight (it needs `/usr/bin/python3`) and no `acl` install.
 */
function generateWindowsPlaybook(bodyTasks: readonly Record<string, unknown>[]): string {
  return dump([
    {
      name: 'AI Support Agent server setup',
      hosts: 'all',
      become: false,
      gather_facts: false,
      tasks: [
        GATHER_FACTS_TASK,
        WINDOWS_PRECHECK_TASK,
        WIN_WHOAMI_PROBE_TASK,
        WIN_ELEVATION_ASSERT_TASK,
        ...bodyTasks,
      ],
    },
  ])
}

export function generatePlaybook(
  bodyTasks: readonly Record<string, unknown>[],
  targetOs: AnsibleTargetOs = 'linux',
): string {
  if (targetOs === 'windows') return generateWindowsPlaybook(bodyTasks)
  const sentry = inspectSentryTasks(bodyTasks)
  const recovery = sentry && sentry.operation !== 'install'
  const playbook: Record<string, unknown>[] = [
    {
      name: 'AI Support Agent server setup',
      hosts: 'all',
      become: true,
      // The implicit gather_facts task would inherit become:true and fail on
      // any host lacking NOPASSWD sudo; facts are gathered explicitly instead
      // (see GATHER_FACTS_TASK below).
      gather_facts: false,
      tasks: [
        GATHER_FACTS_TASK,
        SUDO_PRECHECK_PROBE_TASK,
        SUDO_PRECHECK_ASSERT_TASK,
        PRECHECK_TASK,
        sentryPreflightTask(sentry?.operation),
        ...(recovery ? [] : [ENSURE_ACL_TASK]),
        ...bodyTasks,
      ],
    },
  ]
  return dump(playbook)
}

