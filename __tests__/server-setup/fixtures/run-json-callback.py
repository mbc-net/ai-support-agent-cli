"""Test harness that drives ansible/callback_plugins/json.py without Ansible.

WHY: the bundled `json` stdout callback is the only place that knows when an
Ansible task starts and finishes, so it is where incremental progress is
emitted from. Installing ansible-core just to assert that behavior would make
the test un-runnable on a plain dev machine, so this harness stubs the single
Ansible symbol the plugin imports (`ansible.plugins.callback.CallbackBase`)
and replays a scripted sequence of callback hooks against it.

Usage: python3 run-json-callback.py <scenario.json>

The scenario file is `{"progressFile": <path|null>, "events": [...]}` where
each event is one of:
  {"type": "play_start", "name": ...}
  {"type": "task_start", "name": ..., "no_log": bool}
  {"type": "ok"|"failed"|"skipped"|"unreachable",
   "host": ..., "result": {...}, "no_log": bool}
  {"type": "stats"}

Whatever the plugin writes to its `_display` is printed on stdout, so the
caller can assert the end-of-run JSON contract is unchanged.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import types


def install_ansible_stub() -> None:
    """Register a minimal fake `ansible.plugins.callback` in sys.modules."""

    class _Display:
        def display(self, msg):
            print(msg)

    class CallbackBase:
        def __init__(self, *args, **kwargs):
            self._display = _Display()

    ansible = types.ModuleType("ansible")
    plugins = types.ModuleType("ansible.plugins")
    callback = types.ModuleType("ansible.plugins.callback")
    callback.CallbackBase = CallbackBase
    plugins.callback = callback
    ansible.plugins = plugins
    sys.modules["ansible"] = ansible
    sys.modules["ansible.plugins"] = plugins
    sys.modules["ansible.plugins.callback"] = callback


class FakeHost:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name


class FakeTask:
    def __init__(self, name, no_log=False):
        self._name = name
        self.no_log = no_log

    def get_name(self):
        return self._name


class FakeResult:
    def __init__(self, host, task, result):
        self._host = FakeHost(host)
        self._task = task
        self._result = result


class FakePlay:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name


def load_plugin():
    here = os.path.dirname(os.path.abspath(__file__))
    plugin_path = os.path.join(
        here, "..", "..", "..", "ansible", "callback_plugins", "json.py"
    )
    spec = importlib.util.spec_from_file_location(
        "bundled_json_callback", os.path.normpath(plugin_path)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CallbackModule


def main() -> None:
    scenario = json.load(open(sys.argv[1], encoding="utf-8"))
    progress_file = scenario.get("progressFile")
    if progress_file:
        os.environ["AI_SUPPORT_AGENT_PROGRESS_FILE"] = progress_file
    else:
        os.environ.pop("AI_SUPPORT_AGENT_PROGRESS_FILE", None)

    install_ansible_stub()
    callback = load_plugin()()

    current_task = FakeTask("")
    for event in scenario["events"]:
        kind = event["type"]
        if kind == "play_start":
            callback.v2_playbook_on_play_start(FakePlay(event["name"]))
        elif kind == "task_start":
            current_task = FakeTask(event["name"], event.get("no_log", False))
            callback.v2_playbook_on_task_start(current_task, False)
        elif kind == "handler_task_start":
            current_task = FakeTask(event["name"], event.get("no_log", False))
            callback.v2_playbook_on_handler_task_start(current_task)
        elif kind == "stats":
            callback.v2_playbook_on_stats(object())
        else:
            task = current_task
            if "no_log" in event:
                task = FakeTask(task.get_name(), event["no_log"])
            result = FakeResult(event["host"], task, dict(event.get("result", {})))
            if kind == "ok":
                callback.v2_runner_on_ok(result)
            elif kind == "failed":
                callback.v2_runner_on_failed(result, event.get("ignoreErrors", False))
            elif kind == "skipped":
                callback.v2_runner_on_skipped(result)
            elif kind == "unreachable":
                callback.v2_runner_on_unreachable(result)
            else:
                raise SystemExit(f"unknown event type: {kind}")


if __name__ == "__main__":
    main()
