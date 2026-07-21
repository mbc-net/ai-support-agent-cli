"""Bundled `ANSIBLE_STDOUT_CALLBACK=json` stdout callback.

WHY THIS FILE EXISTS: ansible-core does not ship a `json` stdout callback
plugin (confirmed absent from `ansible-core`'s bundled `callback_plugins/`
directory across the 2.x line at the time this file was written — see
`ansible-doc -t callback -l`, which does not list one). Before this file was
added, `src/server-setup/server-setup-runner.ts` set
`ANSIBLE_STDOUT_CALLBACK=json` and got no matching plugin, silently falling
back to the human-readable `default` callback; `parseStepResults()` would
then fail to `JSON.parse` that output and report *every* requested step as
"skipped" regardless of what actually happened on the target host.

HOW ANSIBLE FINDS THIS FILE: the runner generates its playbook into a
per-run temp directory (not this `ansible/` directory), so Ansible's
"callback_plugins/ next to the running playbook" auto-discovery does NOT
pick this file up. `src/server-setup/server-setup-runner.ts` therefore
points `ANSIBLE_CALLBACK_PLUGINS` explicitly at this directory (via
`resolveCallbackPluginsPath()`, mirroring how `ANSIBLE_ROLES_PATH` exposes
the bundled `roles/`). Do NOT remove that env var: without it Ansible cannot
load this callback and aborts every run with
`ERROR! Invalid callback for stdout specified: json`.
(Historical note: an earlier revision ran `ansible/playbook.yml` directly
from this directory, where adjacent auto-discovery worked; that is no longer
the execution path.)

OUTPUT CONTRACT: emits exactly one line of JSON at the end of the run,
shaped as
    {"plays": [{"task": {"name": <task name>},
                 "hosts": {<hostname>: {"changed":, "failed":, "skipped":,
                                          "msg":, ...other module fields}}}]}
matching the `AnsibleJsonOutput` shape parsed by
`parseStepResults()` in `src/server-setup/server-setup-runner.ts`. Task
names in the bundled roles are prefixed `"<stepType> : <description>"`, and
`parseStepResults()` groups task outcomes back to a step by taking the text
before the first `:` in the task name.
"""
from __future__ import annotations

import json

from ansible.plugins.callback import CallbackBase

DOCUMENTATION = r"""
    callback: json
    type: stdout
    short_description: Bundled JSON stdout callback for server-setup-exec
    description:
      - Emits a single JSON document at the end of the run grouping
        per-task, per-host results, consumed by the agent CLI's
        server_setup_exec command (src/server-setup/server-setup-runner.ts).
      - Bundled here because ansible-core does not ship a `json` stdout
        callback plugin out of the box.
"""


class CallbackModule(CallbackBase):
    """Accumulate per-task/per-host results and dump them as one JSON blob."""

    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = 'stdout'
    CALLBACK_NAME = 'json'

    def __init__(self):
        super().__init__()
        self.results = {"plays": []}
        self._current_play = None
        self._current_task = None

    def _new_task_entry(self, task_name):
        entry = {"task": {"name": task_name}, "hosts": {}}
        if self._current_play is not None:
            self._current_play["tasks"].append(entry)
        return entry

    def v2_playbook_on_play_start(self, play):
        self._current_play = {"play": {"name": play.get_name()}, "tasks": []}
        self.results["plays"].append(self._current_play)

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._current_task = self._new_task_entry(task.get_name())

    def v2_playbook_on_handler_task_start(self, task):
        self._current_task = self._new_task_entry(task.get_name())

    @staticmethod
    def _is_no_log(result, raw_result):
        """True if this result must be censored because of `no_log: true`.

        IMPORTANT: `result._result` (the raw dict callbacks receive via
        `v2_runner_on_*`) is NOT pre-censored by Ansible core. Core's
        censorship logic lives in `TaskResult.clean_copy()`
        (ansible/executor/task_result.py), but the strategy plugin
        (ansible/plugins/strategy/__init__.py) passes the *original*,
        uncensored `TaskResult` to `send_callback()` — `clean_copy()` is used
        for other internal purposes (e.g. the `ansible_failed_result`
        rescue/always fact), not for what reaches stdout callback plugins.
        A callback plugin that assumes core already censored `_result` (as
        this one previously did) will leak whatever `no_log: true` was
        meant to hide — e.g. `db_root_password` from
        ansible/roles/database/tasks/main.yml's `mysql_user`/
        `postgresql_user` tasks — straight into this plugin's JSON output.
        So this plugin must replicate (a minimal version of) that censorship
        itself, checking both the task's own `no_log` flag and the
        `_ansible_no_log` flag a module can set on its own result.
        """
        task = getattr(result, "_task", None)
        task_no_log = bool(getattr(task, "no_log", False)) if task is not None else False
        result_no_log = bool(raw_result.get("_ansible_no_log", False)) if isinstance(raw_result, dict) else False
        return task_no_log or result_no_log

    def _record(self, result, *, failed, skipped):
        host = result._host.get_name()
        raw_result = dict(result._result)
        if self._is_no_log(result, raw_result):
            # Minimal, non-secret summary only — no module fields (which may
            # include the no_log'd value or closely related data) are
            # forwarded.
            payload = {"censored": True, "changed": raw_result.get("changed", False)}
        else:
            payload = raw_result
        payload["failed"] = failed
        payload["skipped"] = skipped
        payload.setdefault("changed", False)
        if self._current_task is None:
            # Defensive: a result arrived with no preceding task-start event.
            self._current_task = self._new_task_entry(getattr(result, "task_name", "") or "")
        self._current_task["hosts"][host] = payload

    def v2_runner_on_ok(self, result):
        self._record(result, failed=False, skipped=False)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._record(result, failed=True, skipped=False)

    def v2_runner_on_skipped(self, result):
        self._record(result, failed=False, skipped=True)

    def v2_runner_on_unreachable(self, result):
        host = result._host.get_name()
        raw_result = dict(result._result)
        if self._is_no_log(result, raw_result):
            payload = {"censored": True, "changed": raw_result.get("changed", False)}
        else:
            payload = raw_result
        payload["unreachable"] = True
        payload["failed"] = True
        payload["skipped"] = False
        payload.setdefault("changed", False)
        if self._current_task is None:
            self._current_task = self._new_task_entry(getattr(result, "task_name", "") or "")
        self._current_task["hosts"][host] = payload

    def v2_playbook_on_stats(self, stats):
        self._display.display(json.dumps(self.results))
