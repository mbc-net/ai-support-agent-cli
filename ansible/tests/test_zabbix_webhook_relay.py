"""zabbix_webhook_relay: real Ansible evaluation of the input validation and template output.

Design: mbc-server-maintenance docs/zabbix/webhook-relay.md (D1-D9). Zabbix's HttpRequest does
not verify TLS certificates and follows redirects, so the Zabbix host relays webhooks through a
loopback-only nginx server that verifies the upstream certificate and turns 3xx into 502.

Run in an Ansible >=2.20 venv: python -m unittest discover -s ansible/tests -p test_zabbix_webhook_relay.py -v
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

try:
    import yaml
    from jinja2 import Environment, StrictUndefined
except ImportError:
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
ROLE = ROOT / 'roles' / 'zabbix_webhook_relay'


@unittest.skipUnless(yaml is not None and shutil.which('ansible-playbook'),
                     'requires PyYAML/Jinja2 and an Ansible >=2.20 venv')
class WebhookRelayTest(unittest.TestCase):
    def tasks(self):
        return yaml.safe_load((ROLE / 'tasks/main.yml').read_text())

    def validate(self, **overrides):
        defaults = yaml.safe_load((ROLE / 'defaults/main.yml').read_text())
        variables = dict(defaults, ansible_distribution='Ubuntu', ansible_distribution_version='26.04',
                         zabbix_webhook_relay_upstream_host='api.example.com')
        variables.update(overrides)
        check = next(t for t in self.tasks() if 'Validate' in t['name'])
        play = [{'hosts': 'localhost', 'gather_facts': False, 'connection': 'local',
                 'vars': variables, 'tasks': [check]}]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'play.yml'
            path.write_text(yaml.safe_dump(play, sort_keys=False))
            env = dict(os.environ, ANSIBLE_LOCAL_TEMP=tmp, ANSIBLE_NOCOLOR='1')
            return subprocess.run([shutil.which('ansible-playbook'), '-i', 'localhost,', str(path)],
                                  capture_output=True, text=True, env=env, timeout=60)

    def test_input_validation(self):
        cases = [
            ({}, True),
            ({'zabbix_webhook_relay_upstream_host': 'ai-support.mbc-net.com'}, True),
            ({'zabbix_webhook_relay_upstream_port': 8443}, True),
            ({'zabbix_webhook_relay_listen_port': 1024}, True),
            ({'zabbix_webhook_relay_listen_port': 65535}, True),
            # required FQDN, no IP literal / single label / uppercase / trailing dot / scheme / path
            ({'zabbix_webhook_relay_upstream_host': ''}, False),
            ({'zabbix_webhook_relay_upstream_host': '203.0.113.10'}, False),
            # the last label (TLD) must start with a letter, as in the recipe-level check
            ({'zabbix_webhook_relay_upstream_host': 'x.1a'}, False),
            ({'zabbix_webhook_relay_upstream_host': 'api.xn--p1ai'}, True),
            ({'zabbix_webhook_relay_upstream_host': 'localhost'}, False),
            ({'zabbix_webhook_relay_upstream_host': 'API.example.com'}, False),
            ({'zabbix_webhook_relay_upstream_host': 'api.example.com.'}, False),
            ({'zabbix_webhook_relay_upstream_host': 'https://api.example.com'}, False),
            ({'zabbix_webhook_relay_upstream_host': 'api.example.com/x'}, False),
            ({'zabbix_webhook_relay_upstream_host': 'api.example.com;'}, False),
            ({'zabbix_webhook_relay_upstream_host': '-api.example.com'}, False),
            ({'zabbix_webhook_relay_upstream_host': 'a' * 64 + '.example.com'}, False),
            ({'zabbix_webhook_relay_upstream_host': None}, False),
            # ports
            ({'zabbix_webhook_relay_listen_port': 1023}, False),
            ({'zabbix_webhook_relay_listen_port': 65536}, False),
            ({'zabbix_webhook_relay_listen_port': '18081x'}, False),
            ({'zabbix_webhook_relay_upstream_port': 0}, False),
            ({'zabbix_webhook_relay_upstream_port': 65536}, False),
            # platform
            ({'ansible_distribution_version': '24.04'}, False),
            ({'ansible_distribution': 'Debian'}, False),
        ]
        for overrides, accepted in cases:
            with self.subTest(overrides=overrides):
                result = self.validate(**overrides)
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)
                if not accepted:
                    self.assertIn('"evaluated_to": false', result.stdout)

    def render(self, **overrides):
        variables = dict(zabbix_webhook_relay_upstream_host='api.example.com', zabbix_webhook_relay_upstream_port=443,
                         zabbix_webhook_relay_listen_port=18081)
        variables.update(overrides)
        template = Environment(undefined=StrictUndefined).from_string((ROLE / 'templates/relay.conf.j2').read_text())
        return template.render(**variables)

    def test_template_enforces_the_design(self):
        text = self.render()
        lines = [line.strip() for line in text.splitlines()]
        # D3: loopback only, a single listen directive
        self.assertEqual([line for line in lines if line.startswith('listen')], ['listen 127.0.0.1:18081;'])
        # D4/D5: fixed upstream with certificate verification and SNI
        for directive in ('proxy_pass https://api.example.com:443;', 'proxy_ssl_verify on;',
                          'proxy_ssl_server_name on;', 'proxy_ssl_name api.example.com;',
                          'proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;',
                          'proxy_ssl_protocols TLSv1.2 TLSv1.3;', 'proxy_set_header Host api.example.com;'):
            self.assertIn(directive, lines)
        self.assertNotIn('proxy_ssl_verify off;', lines)
        # D6: POST only, fixed path, 4KiB body, other paths 404
        self.assertIn('client_max_body_size 4k;', lines)
        self.assertIn('limit_except POST {', lines)
        self.assertIn('location / {', lines)
        location = next(line for line in lines if line.startswith('location ~'))
        pattern = re.search(r'"(.+)"', location).group(1)
        identifier = '[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}'
        self.assertEqual(pattern, f'^/webhooks/zabbix/{identifier}/{identifier}$')
        for path, ok in (('/webhooks/zabbix/internal/generation-1', True),
                         ('/webhooks/zabbix/internal/generation-1/x', False),
                         ('/webhooks/zabbix/internal', False), ('/webhooks/zabbix/../x/y', False),
                         ('/webhooks/zabbix/-a/b', False), ('/other/zabbix/a/b', False)):
            with self.subTest(path=path):
                self.assertEqual(bool(re.match(pattern, path)), ok)
        # D4: only the normalized, already-validated path is sent upstream, without the query.
        # proxy_pass without a URI part would forward the raw request URI ("..", "//", %-escapes, ?x=1).
        location_body = lines[lines.index(location) + 1:lines.index('location = /ai-support-relay-upstream-redirect {')]
        self.assertIn('rewrite ^ $uri? break;', location_body)
        self.assertLess(location_body.index('rewrite ^ $uri? break;'),
                        next(i for i, line in enumerate(location_body) if line.startswith('proxy_pass')))
        # D7: upstream redirects are converted to 502 and not passed to HttpRequest
        self.assertIn('proxy_redirect off;', lines)
        self.assertIn('proxy_intercept_errors on;', lines)
        error_page = next(line for line in lines if line.startswith('error_page'))
        for code in ('301', '302', '303', '307', '308'):
            self.assertIn(code, error_page.split())
        self.assertIn('=502', error_page.split())
        # D6: no forwarding headers are added
        self.assertFalse([line for line in lines if 'X-Forwarded' in line or 'X-Real-IP' in line])

    def test_non_default_ports_render_into_host_header(self):
        lines = [line.strip() for line in self.render(zabbix_webhook_relay_upstream_port=8443).splitlines()]
        self.assertIn('proxy_pass https://api.example.com:8443;', lines)
        self.assertIn('proxy_set_header Host api.example.com:8443;', lines)

    @unittest.skipUnless(shutil.which('nginx'), 'nginx binary not available for a syntax check')
    def test_rendered_config_passes_nginx_syntax_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            conf = Path(tmp) / 'nginx.conf'
            conf.write_text('pid %s/nginx.pid; error_log stderr; events {} http { %s }\n'
                            # nginx -t resolves the upstream name; use one that always resolves so the
                            # check fails only on syntax, not on the test machine's DNS.
                            % (tmp, self.render(zabbix_webhook_relay_upstream_host='localhost')
                               .replace('/var/log/nginx/', tmp + '/')))
            result = subprocess.run(['nginx', '-t', '-p', tmp, '-c', str(conf)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_listener_assert_requires_exactly_the_loopback_socket(self):
        block = next(t for t in self.tasks() if t['name'].endswith('Configure the relay with rollback'))
        check = next(t for t in block['block'] if 'Require the relay to listen only on loopback' in t['name'])
        for lines, accepted in [(['LISTEN 0 511 127.0.0.1:18081 0.0.0.0:*'], True),
                                (['LISTEN 0 511 0.0.0.0:18081 0.0.0.0:*'], False),
                                (['LISTEN 0 511 127.0.0.1:18081 0.0.0.0:*', 'LISTEN 0 511 [::]:18081 [::]:*'], False),
                                ([], False)]:
            play = [{'hosts': 'localhost', 'gather_facts': False, 'connection': 'local',
                     'vars': {'zabbix_webhook_relay_listen_port': 18081,
                              'zabbix_webhook_relay_listener': {'stdout_lines': lines}},
                     'tasks': [check]}]
            with self.subTest(lines=lines), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'play.yml'
                path.write_text(yaml.safe_dump(play, sort_keys=False))
                env = dict(os.environ, ANSIBLE_LOCAL_TEMP=tmp, ANSIBLE_NOCOLOR='1')
                result = subprocess.run([shutil.which('ansible-playbook'), '-i', 'localhost,', str(path)],
                                        capture_output=True, text=True, env=env, timeout=60)
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
