"""Unit tests for the bundled `json` stdout callback plugin (json.py).

Focus: `no_log: true` must actually be respected by this plugin's own JSON
output. `result._result` (what `v2_runner_on_*` receives from Ansible's
strategy plugin) is NOT pre-censored by Ansible core — core's censorship
(`TaskResult.clean_copy()`) is used for other internal purposes, not for
what reaches callback plugins — so this plugin must apply its own
censorship, and these tests exist to prove it actually does.

Run with (requires ansible-core installed — see docker/Dockerfile's pinned
`ansible-core>=2.16,<2.18`, or `pip install 'ansible-core>=2.16,<2.18'` into
a local virtualenv):

    python3 ansible/callback_plugins/tests/test_json_callback.py -v

Run as a plain script (NOT via `python3 -m unittest <dotted.path>` from the
repo root, and NOT from inside `ansible/callback_plugins/` itself): this
repo's top-level `ansible/` directory would shadow the real `ansible`
package on `sys.path`, and the plugin under test is itself named `json.py`,
which would shadow the stdlib `json` module if its own directory ended up
on `sys.path`. Running this file directly puts only *this* `tests/`
directory on `sys.path[0]`, avoiding both collisions; `json.py` itself is
loaded by absolute file path via `importlib`, independent of `sys.path`.

Loads json.py directly by file path (rather than relying on package/
collection discovery) since this plugin is only ever auto-discovered by
ansible-core at `ansible-playbook` runtime via the `callback_plugins/`
directory convention, not importable as a regular Python package.
"""
from __future__ import annotations

import importlib.util
import json
import os
import unittest


def _load_callback_module_class():
    plugin_path = os.path.join(os.path.dirname(__file__), "..", "json.py")
    spec = importlib.util.spec_from_file_location("server_setup_json_stdout_callback", plugin_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CallbackModule


class _FakeNamed:
    """Minimal stand-in for anything exposing ansible-core's `get_name()`."""

    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name


class _FakeTask:
    def __init__(self, name, no_log=False):
        self._name = name
        self.no_log = no_log

    def get_name(self):
        return self._name


class _FakeResult:
    """Minimal stand-in for the `TaskResult` ansible-core hands to `v2_runner_on_*`."""

    def __init__(self, host_name, result_dict, task=None, task_name=""):
        self._host = _FakeNamed(host_name)
        self._result = result_dict
        self._task = task
        self.task_name = task_name


class JsonCallbackNoLogTest(unittest.TestCase):
    def setUp(self):
        callback_cls = _load_callback_module_class()
        self.cb = callback_cls()
        self.cb.v2_playbook_on_play_start(_FakeNamed("AI Support Agent server setup"))

    def _host_payload(self, task_index=0, host="203.0.113.10"):
        return self.cb.results["plays"][0]["tasks"][task_index]["hosts"][host]

    def test_task_marked_no_log_is_censored_in_ok_result(self):
        task = _FakeTask("database : Set MySQL root password", no_log=True)
        self.cb.v2_playbook_on_task_start(task, is_conditional=False)

        result = _FakeResult(
            "203.0.113.10",
            {"changed": True, "password": "hunter2", "msg": "ALTER USER root ... IDENTIFIED BY 'hunter2'"},
            task=task,
        )
        self.cb.v2_runner_on_ok(result)

        payload = self._host_payload()
        self.assertEqual(payload, {"censored": True, "changed": True, "failed": False, "skipped": False})

        # (The task *name* legitimately contains the word "password" — that's
        # just a human-readable description, not the secret value itself.)
        dumped = json.dumps(self.cb.results)
        self.assertNotIn("hunter2", dumped)
        self.assertNotIn("IDENTIFIED BY", dumped)

    def test_module_set_ansible_no_log_flag_is_censored_even_if_task_no_log_is_false(self):
        # A module can mark its own result no_log (`_ansible_no_log`) even
        # when the *task* itself wasn't declared `no_log: true` — this must
        # be censored too.
        task = _FakeTask("database : Set MySQL root password", no_log=False)
        self.cb.v2_playbook_on_task_start(task, is_conditional=False)

        result = _FakeResult(
            "203.0.113.10",
            {"changed": True, "_ansible_no_log": True, "password": "hunter2"},
            task=task,
        )
        self.cb.v2_runner_on_ok(result)

        payload = self._host_payload()
        self.assertEqual(payload, {"censored": True, "changed": True, "failed": False, "skipped": False})
        self.assertNotIn("hunter2", json.dumps(self.cb.results))

    def test_no_log_result_is_censored_on_failure_too(self):
        task = _FakeTask("database : Set MySQL root password", no_log=True)
        self.cb.v2_playbook_on_task_start(task, is_conditional=False)

        result = _FakeResult(
            "203.0.113.10",
            {"changed": False, "password": "hunter2", "msg": "Access denied for user 'root'@'localhost' (using password: YES)"},
            task=task,
        )
        self.cb.v2_runner_on_failed(result, ignore_errors=False)

        payload = self._host_payload()
        self.assertEqual(payload, {"censored": True, "changed": False, "failed": True, "skipped": False})
        self.assertNotIn("hunter2", json.dumps(self.cb.results))

    def test_no_log_result_is_censored_on_unreachable_too(self):
        task = _FakeTask("database : Set MySQL root password", no_log=True)
        self.cb.v2_playbook_on_task_start(task, is_conditional=False)

        result = _FakeResult(
            "203.0.113.10",
            {"changed": False, "password": "hunter2"},
            task=task,
        )
        self.cb.v2_runner_on_unreachable(result)

        payload = self._host_payload()
        self.assertEqual(
            payload,
            {"censored": True, "changed": False, "failed": True, "skipped": False, "unreachable": True},
        )
        self.assertNotIn("hunter2", json.dumps(self.cb.results))

    def test_task_without_no_log_is_not_censored(self):
        # Control case: a normal (non-secret) task's result must pass through
        # unmodified, proving the censorship above is targeted rather than
        # blanket-applied.
        task = _FakeTask("os_init : Update apt cache", no_log=False)
        self.cb.v2_playbook_on_task_start(task, is_conditional=False)

        result = _FakeResult("203.0.113.10", {"changed": True, "msg": "cache updated"}, task=task)
        self.cb.v2_runner_on_ok(result)

        payload = self._host_payload()
        self.assertEqual(payload, {"changed": True, "msg": "cache updated", "failed": False, "skipped": False})


if __name__ == "__main__":
    unittest.main()
