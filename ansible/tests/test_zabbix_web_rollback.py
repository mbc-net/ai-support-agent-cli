"""Integration tests for an isolated, provisioned Ubuntu PostgreSQL/nginx host.

Run with Docker access and PyYAML: python ansible/tests/test_zabbix_web_rollback.py
The fixture container must be running and serve zabbix.test on port 8080.
"""
import os
from pathlib import Path
import subprocess
import unittest


CONTAINER = "zabbix-native-test-pg-isolated"
ROOT = Path(__file__).resolve().parents[1]
PATHS = [
    "/etc/zabbix/web/zabbix.conf.php",
    "/etc/php/8.3/fpm/pool.d/ai-support-zabbix.conf",
    "/etc/nginx/conf.d/ai-support-zabbix.conf",
]


def execute(*args, input=None, check=True):
    return subprocess.run(
        ["docker", "exec", "-i", CONTAINER, *args], input=input,
        capture_output=True, check=check,
    )


def write(path, data):
    execute(
        "python3", "-c",
        "import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())",
        path, input=data,
    )


def login_available():
    result = execute("python3", "-c", r'''
import urllib.request
request = urllib.request.Request(
    "http://127.0.0.1:8080/index.php", headers={"Host": "zabbix.test"})
response = urllib.request.urlopen(request, timeout=5)
print(b'name="password"' in response.read())
''')
    return result.stdout.strip() == b"True"


@unittest.skipUnless(
    __name__ == "__main__" or os.environ.get("ZABBIX_TEST_WEB_ROLLBACK") == "1",
    "requires an explicitly selected, provisioned Docker fixture",
)
class WebRollbackTest(unittest.TestCase):
    def check_failure(self, *, invalid_vhost, busy_port=False):
        import yaml

        originals = {path: execute("cat", path).stdout for path in PATHS}
        permissions = {path: execute("stat", "-c", "%a:%u:%g", path).stdout for path in PATHS}
        self.assertTrue(login_available(), "fixture must have a working login")
        try:
            tasks = yaml.safe_load((ROOT / "roles/zabbix_web/tasks/main.yml").read_text())
            start = next(i for i, task in enumerate(tasks)
                         if "Prepare frontend rollback" in task["name"])
            serialized = yaml.safe_dump(tasks[start:]).replace(
                "{{ zabbix_web_type }}.conf.j2",
                "/work/roles/zabbix_web/templates/{{ zabbix_web_type }}.conf.j2",
            )
            write("/tmp/review-rollback-tasks.yml", serialized.encode())
            variables = yaml.safe_load((ROOT / "roles/zabbix_web/defaults/main.yml").read_text())
            variables.update(
                zabbix_web_php_version="8.3", zabbix_web_db_type="postgresql",
                zabbix_web_db_password="review-wrong-password",
                zabbix_web_server_name="changed.zabbix.test",
                zabbix_web_listen_port=8081, zabbix_web_php_timezone="UTC",
            )
            play = [{
                "hosts": "localhost", "connection": "local", "gather_facts": False,
                "vars": variables,
                "handlers": yaml.safe_load((ROOT / "roles/zabbix_web/handlers/main.yml").read_text()),
                "tasks": [{"ansible.builtin.include_tasks": "/tmp/review-rollback-tasks.yml"}],
            }]
            write("/tmp/review-rollback.yml", yaml.safe_dump(play).encode())
            if invalid_vhost:
                write("/etc/nginx/conf.d/review-invalid.conf", b"invalid_review_directive;\n")
            if busy_port:
                execute("systemctl", "disable", "--now", "php8.3-fpm", "nginx")
                execute("python3", "-c", """
import pathlib, socket, subprocess, sys, time
process = subprocess.Popen([sys.executable, '-m', 'http.server', '8081', '--bind', '127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pathlib.Path('/tmp/review-port-owner.pid').write_text(str(process.pid))
for attempt in range(50):
    try:
        socket.create_connection(('127.0.0.1', 8081), timeout=0.1).close()
        break
    except OSError:
        time.sleep(0.05)
else:
    raise RuntimeError('test listener did not start')
""")
            result = execute(
                "/opt/ansible/bin/ansible-playbook", "/tmp/review-rollback.yml", check=False,
            )
            self.assertEqual(result.returncode, 2, "setup must report the expected failure")
            output = result.stdout.decode()
            expected = ("Enable and start the selected web server" if busy_port else
                        "Validate the complete web server configuration" if invalid_vhost else
                        "Verify the login page")
            self.assertIn(expected, output)
            for path, original in originals.items():
                self.assertTrue(execute("cat", path).stdout == original, path + " was not restored")
                self.assertEqual(execute("stat", "-c", "%a:%u:%g", path).stdout, permissions[path])
            if busy_port:
                self.assertNotIn("TASK [zabbix_web : Verify the login page", output)
                for service in ["php8.3-fpm", "nginx"]:
                    # systemd keeps a failed-start diagnostic even after the service is stopped.
                    state = execute("systemctl", "is-active", service, check=False)
                    self.assertNotEqual(state.returncode, 0)
                    self.assertIn(state.stdout.strip(), [b"inactive", b"failed"])
                    self.assertEqual(execute("systemctl", "is-enabled", service, check=False).stdout.strip(), b"disabled")
            else:
                self.assertTrue(login_available(), "existing login must survive failed setup")
            remaining = execute(
                "python3", "-c",
                'import glob; print(glob.glob("/tmp/ai-support-zabbix-web-rollback-*"))',
            )
            self.assertEqual(remaining.stdout.strip(), b"[]", "secret backups must be removed")
        finally:
            for path, original in originals.items():
                write(path, original)
            execute("python3", "-c", 'from pathlib import Path; Path("/etc/nginx/conf.d/review-invalid.conf").unlink(missing_ok=True)')
            if busy_port:
                execute("python3", "-c", """
from pathlib import Path
import os, signal
path = Path('/tmp/review-port-owner.pid')
if path.exists():
    try:
        os.kill(int(path.read_text()), signal.SIGTERM)
    except ProcessLookupError:
        pass
    path.unlink()
""")
                execute("systemctl", "enable", "--now", "php8.3-fpm", "nginx")
            execute("systemctl", "restart", "php8.3-fpm")
            execute("systemctl", "reload", "nginx")

    def test_validation_failure_preserves_existing_login_and_settings(self):
        self.check_failure(invalid_vhost=True)

    def test_login_failure_restores_settings_and_running_services(self):
        self.check_failure(invalid_vhost=False)

    def test_start_failure_restores_stopped_and_disabled_services(self):
        self.check_failure(invalid_vhost=False, busy_port=True)


if __name__ == "__main__":
    unittest.main()
