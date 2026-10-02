"""Live Docker/Ansible test with isolated project, DB volume and a local TLS proxy.

Requires Python with PyYAML, Ansible 2.16/2.17, Docker Compose v2 and openssl.
The fixture skips Docker provisioning, rewrites the fixed installation/project
names, uses the current user for files and trusts ONLY the fixture's test CA.
All other role tasks and the production Compose template run unchanged.
"""
import getpass
import grp
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

import yaml

ROOT = Path(__file__).resolve().parents[2]
ROLE = ROOT / 'ansible/roles/keycloak'
DB_PASSWORD = 'test-db-$${UNDEFINED_TEST_KEY}\'"-123-next'
ADMIN_PASSWORD = 'test-admin-$${UNDEFINED_TEST_KEY}\'"-123-next'
NEW_ADMIN_PASSWORD = 'different-admin-12345'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class LiveTest(unittest.TestCase):
    def test_deployment_reexecution_and_failure_paths(self):
        with tempfile.TemporaryDirectory(prefix='keycloak-live-') as directory:
            work = Path(directory)
            project = 'keycloak-test-' + uuid.uuid4().hex[:10]
            http_port, https_port = free_port(), free_port()
            origin = f'https://localhost:{https_port}'
            cert, key = work / 'cert.pem', work / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(key), '-out', str(cert), '-days', '1',
                            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                            '-addext', 'basicConstraints=critical,CA:TRUE'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            class Proxy(BaseHTTPRequestHandler):
                enabled = True
                def log_message(self, *args):
                    pass
                def forward(self):
                    if not self.enabled:
                        self.send_error(503)
                        return
                    connection = http.client.HTTPConnection('127.0.0.1', http_port, timeout=30)
                    length = int(self.headers.get('Content-Length', '0'))
                    body = self.rfile.read(length) if length else None
                    headers = {k: v for k, v in self.headers.items()
                               if k.lower() not in ('host', 'connection') and not k.lower().startswith('x-forwarded-')}
                    headers.update({'Host': f'localhost:{https_port}', 'X-Forwarded-Host': f'localhost:{https_port}',
                                    'X-Forwarded-Proto': 'https', 'X-Forwarded-Port': str(https_port),
                                    'X-Forwarded-For': '127.0.0.1'})
                    try:
                        connection.request(self.command, self.path, body, headers)
                        response = connection.getresponse()
                        data = response.read()
                        self.send_response(response.status)
                        for header, value in response.getheaders():
                            if header.lower() not in ('transfer-encoding', 'connection', 'content-length'):
                                self.send_header(header, value)
                        self.send_header('Content-Length', str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                    except (OSError, http.client.HTTPException):
                        self.send_error(502)
                    finally:
                        connection.close()
                do_GET = forward
                do_POST = forward

            server = ThreadingHTTPServer(('127.0.0.1', https_port), Proxy)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            context = ssl.create_default_context(cafile=str(cert))

            fixture = work / 'roles/keycloak'
            shutil.copytree(ROLE, fixture)
            tasks = yaml.safe_load((fixture / 'tasks/main.yml').read_text())
            tasks = [t for t in tasks if 'ansible.builtin.import_role' not in t]
            text = yaml.safe_dump(tasks, sort_keys=False).replace('/opt/ai-support-keycloak', str(work / 'deployment')).replace('ai-support-keycloak', project)
            tasks = yaml.safe_load(text)
            for task in tasks:
                for module in ('ansible.builtin.file', 'ansible.builtin.template'):
                    if module in task:
                        task[module]['owner'] = getpass.getuser()
                        task[module]['group'] = grp.getgrgid(os.getgid()).gr_name
                if 'ansible.builtin.uri' in task:
                    task['ansible.builtin.uri']['ca_path'] = str(cert)
                    task['retries'], task['delay'] = 1, 1
            (fixture / 'tasks/main.yml').write_text(yaml.safe_dump(tasks, sort_keys=False))
            play = work / 'play.yml'
            play.write_text(yaml.safe_dump([{'hosts': 'localhost', 'gather_facts': False,
                                            'vars': {'ansible_distribution': 'Ubuntu',
                                                     'ansible_distribution_version': '24.04',
                                                     'ansible_architecture': 'x86_64'},
                                            'roles': ['keycloak']}]))
            settings = {'keycloak_hostname': origin, 'keycloak_http_port': http_port,
                        'keycloak_proxy_trusted_addresses': ['127.0.0.1', '172.16.0.0/12', '192.168.0.0/16'],
                        'keycloak_db_password': DB_PASSWORD, 'keycloak_admin_password': ADMIN_PASSWORD,
                        'keycloak_start_timeout': 300}
            compose_file = work / 'deployment/compose.yml'
            base = ['docker', 'compose', '-p', project, '-f', str(compose_file)]

            def compose(*args):
                result = subprocess.run(base + list(args), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, 'Docker command failed: ' + result.stderr)
                return result.stdout.strip()

            def deploy(overrides=None, expected_success=True, failure_message=None):
                values = dict(settings, **(overrides or {}))
                variables = work / 'vars.json'
                variables.write_text(json.dumps(values))
                variables.chmod(0o600)
                env = dict(os.environ, ANSIBLE_ROLES_PATH=str(work / 'roles'),
                           ANSIBLE_LOCAL_TEMP=str(work / 'ansible-local'),
                           ANSIBLE_REMOTE_TEMP=str(work / 'ansible-remote'), ANSIBLE_NOCOLOR='1')
                result = subprocess.run([os.environ.get('ANSIBLE_PLAYBOOK', 'ansible-playbook'),
                                         '-i', 'localhost,', '-c', 'local', str(play), '-e', '@' + str(variables)],
                                        env=env, capture_output=True, text=True, timeout=600)
                output = result.stdout + result.stderr
                for secret in [DB_PASSWORD, ADMIN_PASSWORD, NEW_ADMIN_PASSWORD]:
                    self.assertNotIn(secret, output)
                    self.assertNotIn(secret.replace('$', '$$'), output)
                if expected_success:
                    self.assertEqual(result.returncode, 0, output)
                else:
                    self.assertNotEqual(result.returncode, 0, output)
                    self.assertIn(failure_message, output)
                return output

            def token(password, success=True):
                body = urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'admin-cli',
                                               'username': 'bootstrap-admin', 'password': password}).encode()
                request = urllib.request.Request(origin + '/realms/master/protocol/openid-connect/token', data=body)
                try:
                    with urllib.request.urlopen(request, context=context, timeout=30) as response:
                        value = json.load(response)
                    self.assertTrue(success, 'Unexpected successful login')
                    return value['access_token']
                except urllib.error.HTTPError as error:
                    if success:
                        raise
                    self.assertEqual(error.code, 400)
                    self.assertEqual(json.load(error)['error'], 'invalid_grant')

            try:
                print('Initial deployment with dollar/expression/quote passwords', flush=True)
                deploy()
                self.assertEqual(compose_file.stat().st_mode & 0o777, 0o600)
                config = json.loads(compose('config', '--format', 'json'))
                self.assertNotIn('ports', config['services']['postgres'])
                self.assertEqual(config['services']['keycloak']['ports'][0]['host_ip'], '127.0.0.1')
                self.assertEqual(config['services']['keycloak']['environment']['KCRAW_DB_PASSWORD'], DB_PASSWORD.replace('$', '$$'))
                self.assertEqual(config['services']['keycloak']['environment']['KCRAW_BOOTSTRAP_ADMIN_PASSWORD'], ADMIN_PASSWORD.replace('$', '$$'))
                token(ADMIN_PASSWORD)
                compose('exec', '-T', 'postgres', 'psql', '-U', 'keycloak', '-d', 'keycloak', '-c',
                        "CREATE TABLE deployment_probe (value text); INSERT INTO deployment_probe VALUES ('persistent');")
                keycloak_id = compose('ps', '-q', 'keycloak')
                print('Identical reexecution leaves containers unchanged', flush=True)
                output = deploy()
                self.assertRegex(output, r'changed=0\s')
                self.assertEqual(compose('ps', '-q', 'keycloak'), keycloak_id)
                print('Restart retains DB data and existing administrator', flush=True)
                compose('restart')
                deploy()
                self.assertEqual(compose('exec', '-T', 'postgres', 'psql', '-U', 'keycloak', '-d', 'keycloak',
                                         '-tAc', 'SELECT value FROM deployment_probe'), 'persistent')
                token(ADMIN_PASSWORD)
                print('Bootstrap password change does not rotate the existing administrator', flush=True)
                deploy({'keycloak_admin_password': NEW_ADMIN_PASSWORD})
                token(ADMIN_PASSWORD)
                token(NEW_ADMIN_PASSWORD, success=False)
                keycloak_id = compose('ps', '-q', 'keycloak')
                print('Mismatched DB password stops before recreating Keycloak', flush=True)
                deploy({'keycloak_db_password': 'wrong-db-password-12345'}, False, 'PostgreSQL authentication failed')
                self.assertEqual(compose('ps', '-q', 'keycloak'), keycloak_id)
                self.assertEqual(compose('exec', '-T', 'postgres', 'psql', '-U', 'keycloak', '-d', 'keycloak',
                                         '-tAc', 'SELECT value FROM deployment_probe'), 'persistent')
                deploy()
                print('Public HTTPS outage is reported as failure', flush=True)
                Proxy.enabled = False
                deploy(expected_success=False, failure_message='public HTTPS discovery could not be verified')
                Proxy.enabled = True
                print('Certificate hostname mismatch is rejected', flush=True)
                deploy({'keycloak_hostname': f'https://127.0.0.1:{https_port}'}, False,
                       'public HTTPS discovery could not be verified')
                deploy()
            except Exception:
                if compose_file.exists():
                    logs = subprocess.run(base + ['logs', '--no-color', '--tail', '70'], capture_output=True, text=True).stdout
                    for secret in [DB_PASSWORD, ADMIN_PASSWORD, NEW_ADMIN_PASSWORD]:
                        logs = logs.replace(secret, '[REDACTED]').replace(secret.replace('$', '$$'), '[REDACTED]')
                    print('\n'.join(line for line in logs.splitlines() if any(word in line for word in ['ERROR', 'WARN', 'FATAL'])), flush=True)
                    for service, name, expected in [('postgres', 'POSTGRES_PASSWORD', DB_PASSWORD), ('keycloak', 'KCRAW_DB_PASSWORD', DB_PASSWORD)]:
                        container = subprocess.run(base + ['ps', '-aq', service], capture_output=True, text=True).stdout.strip()
                        if container:
                            details = json.loads(subprocess.run(['docker', 'inspect', container], capture_output=True, text=True, check=True).stdout)[0]
                            value = next((e.split('=', 1)[1] for e in details['Config']['Env'] if e.startswith(name + '=')), '')
                            print(service + ' password matches: ' + str(value == expected) + ', length=' + str(len(value)), flush=True)
                raise
            finally:
                if compose_file.exists():
                    subprocess.run(base + ['down', '--volumes'], check=True, capture_output=True)
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

if __name__ == '__main__':
    unittest.main()
