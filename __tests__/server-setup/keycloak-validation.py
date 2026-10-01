"""Execute the actual role's validation before any host mutation (Ansible 2.16/2.17)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SECRET = "validation-secret-$quote'\"-123"
VALID = {
    "keycloak_hostname": "https://sso.example.com",
    "keycloak_proxy_trusted_addresses": ["172.18.0.1"],
    "keycloak_db_password": SECRET,
    "keycloak_admin_password": SECRET,
}

class ValidationTests(unittest.TestCase):
    def run_role(self, overrides):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "vars.json").write_text(json.dumps(dict(VALID, **overrides)))
            (work / "play.yml").write_text("- hosts: localhost\n  gather_facts: false\n  vars:\n    ansible_distribution: Ubuntu\n    ansible_distribution_version: '24.04'\n    ansible_architecture: x86_64\n  roles:\n    - keycloak\n")
            env = dict(os.environ, ANSIBLE_LOCAL_TEMP=str(work / "local"),
                       ANSIBLE_REMOTE_TEMP=str(work / "remote"),
                       ANSIBLE_ROLES_PATH=str(ROOT / "ansible/roles"),
                       ANSIBLE_NOCOLOR="1")
            result = subprocess.run([os.environ.get("ANSIBLE_PLAYBOOK", "ansible-playbook"),
                                     "-i", "localhost,", "-c", "local", str(work / "play.yml"),
                                     "-e", "@" + str(work / "vars.json"), "--tags", "keycloak_validate"],
                                    env=env, capture_output=True, text=True)
            self.assertNotIn(SECRET, result.stdout + result.stderr)
            return result

    def test_valid_settings(self):
        result = self.run_role({})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Validate deployment settings", result.stdout)

    def test_invalid_input_fails_before_install(self):
        cases = [
            {"keycloak_hostname": "http://sso.example.com"},
            {"keycloak_hostname": "https://user:pass@sso.example.com"},
            {"keycloak_hostname": "https://sso.example.com/path"},
            {"keycloak_hostname": "https://sso.example.com?query"},
            {"keycloak_hostname": "https://sso.example.com:0"},
            {"keycloak_hostname": "https://sso.example.com:65536"},
            {"keycloak_version": "latest"},
            {"keycloak_version": "26.7.4;touch /tmp/pwn"},
            {"keycloak_postgres_version": "17.0"},
            {"keycloak_http_port": True},
            {"keycloak_http_port": 0},
            {"keycloak_http_port": 65536},
            {"keycloak_db_password": ""},
            {"keycloak_admin_password": ""},
            {"keycloak_db_password": "long-password\nnext"},
            {"keycloak_admin_password": "long-password\rnext"},
            {"keycloak_db_password": "long-password\x00next"},
            {"keycloak_version": "26.7.3"},
            {"keycloak_version": "26.7.4\n"},
            {"keycloak_proxy_trusted_addresses": [123]},
            {"keycloak_proxy_headers": "anything"},
            {"keycloak_proxy_trusted_addresses": []},
            {"keycloak_proxy_trusted_addresses": ["0.0.0.0/0"]},
            {"keycloak_proxy_trusted_addresses": ["trusted.invalid"]},
            {"keycloak_proxy_trusted_addresses": ["999.0.0.1"]},
            {"keycloak_proxy_trusted_addresses": ["10.0.0.1/33"]},
            {"keycloak_proxy_trusted_addresses": "172.18.0.1"},
            {"keycloak_start_timeout": 0},
        ]
        for case in cases:
            with self.subTest(case=list(case.keys())):
                result = self.run_role(case)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("FAILED", result.stdout)
                self.assertNotIn("Install prerequisite packages", result.stdout)

    def test_supported_ipv4_cidr_and_ipv6(self):
        for address in ["172.18.0.1", "10.2.3.0/24", "::1", "fd00::/64"]:
            with self.subTest(address=address):
                result = self.run_role({"keycloak_proxy_trusted_addresses": [address]})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

if __name__ == "__main__":
    unittest.main()
