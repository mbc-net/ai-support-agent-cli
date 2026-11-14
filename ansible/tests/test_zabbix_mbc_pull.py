"""Unit tests for roles/zabbix_web/files/zabbix_mbc_pull.py (MBC SSO PULL assignment sync).

The PULL API is replaced by an in-process fake connection (no network). The Zabbix frontend is a fake HTTP server
on 127.0.0.1 that serves the JSON-RPC API (``FakeSaml`` of test_zabbix_api_saml.py, which refuses user.update of the
role / groups of provisioned users like Zabbix does) and the SCIM endpoint /api_scim.php. The fake SCIM endpoint
re-provisions a user from the JIT mapping on every membership change, as Zabbix's SCIM Group service does
(CProvisioning::getUserGroupsAndRole + CUser::updateProvisionedUser).

Run: python3 -m unittest discover -s ansible/tests -v   (or: python3 -m pytest ansible/tests/test_zabbix_mbc_pull.py)
"""
import base64
import contextlib
import io
import json
import os
import pathlib
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_zabbix_api import SERVER_NAME  # noqa: E402
from test_zabbix_api_saml import API_TOKEN, FakeSaml  # noqa: E402

SCRIPT = pathlib.Path(__file__).parents[1] / 'roles/zabbix_web/files/zabbix_mbc_pull.py'
KEY_ID = 'k' + '0123456789abcdef01234567'
SECRET = 'S3cr3t_-' + 'x' * 35
PULL_KEY = KEY_ID + '.' + SECRET
APP = 'zabbix'
SAML_DIR = '50'
PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'


def load_pull():
    spec = importlib.util.spec_from_file_location('zabbix_mbc_pull', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pull = load_pull()


def subject(name, provider='mbcawssso'):
    return '%s+%s@example.com' % (name, provider)


class FakeMbc(FakeSaml):
    """FakeSaml with a configured SAML directory (JIT + SCIM), SCIM groups and the SCIM endpoint."""

    def __init__(self, scim_status='1', case_sensitive='1'):
        super().__init__(api_token=API_TOKEN)
        self.deprovisioned = self.add_group('SAML deprovisioned', users_status='1')
        self.admin_disabled = self.add_group('Locked by an administrator', users_status='1')
        self.directories = [{
            'userdirectoryid': SAML_DIR, 'idp_type': '2', 'provision_status': '1', 'scim_status': scim_status,
            'provision_groups': [{'name': 'admin', 'roleid': '6', 'user_groups': [{'usrgrpid': '11'}]},
                                 {'name': 'operator', 'roleid': '5', 'user_groups': [{'usrgrpid': '12'}]},
                                 {'name': 'viewer', 'roleid': '5', 'user_groups': [{'usrgrpid': '13'}]}]}]
        self.auth = {'saml_auth_enabled': '1', 'saml_case_sensitive': case_sensitive, 'saml_jit_status': '1',
                     'disabled_usrgrpid': self.deprovisioned}
        self.scim_groups = {}
        self.scim_calls = []
        self.scim_fail = {}
        self.scim_vanish = set()

    # --- fixtures -------------------------------------------------------------------------

    def scim_group(self, name):
        for groupid, group in self.scim_groups.items():
            if group['name'] == name:
                return groupid
        groupid = self.new_id()
        self.scim_groups[groupid] = {'name': name, 'members': set()}
        return groupid

    def add_jit(self, username, roles, deprovisioned=False):
        """A JIT user as created by a SAML login with the given groups attribute."""
        userid = self.add_user(username, userdirectoryid=SAML_DIR, groups=[])
        for name in roles:
            self.scim_groups[self.scim_group(name)]['members'].add(userid)
        self.provision(userid)
        if deprovisioned:
            self.deprovision(userid)
        return userid

    def user(self, userid):
        user = self.users[userid]
        return user['roleid'], sorted(user['usrgrps'])

    # --- the provisioning rules of Zabbix --------------------------------------------------

    def provision(self, userid):
        names = [g['name'] for g in self.scim_groups.values() if userid in g['members']]
        matched = [p for p in self.directories[0]['provision_groups'] if p['name'] in names]
        if not matched:
            self.deprovision(userid)
            return
        groups = sorted({g['usrgrpid'] for p in matched for g in p['user_groups']})
        roles = sorted({p['roleid'] for p in matched},
                       key=lambda r: (-int(self.roles[r]['type']), self.roles[r]['name'].lower()))
        self.users[userid].update(usrgrps=groups, roleid=roles[0])

    def deprovision(self, userid):
        self.users[userid].update(usrgrps=[self.deprovisioned], roleid='0')

    # --- JSON-RPC additions ----------------------------------------------------------------

    def m_role_get(self, params, token):
        if 'filter' in params:
            return super().m_role_get(params, token)
        return [{'roleid': r['roleid'], 'name': r['name'], 'type': r['type']} for r in self.roles.values()]

    # --- SCIM ------------------------------------------------------------------------------

    def scim(self, method, path, body, headers):
        parts = path[len('/api_scim.php/'):].split('/')
        resource, ident = parts[0], (parts[1] if len(parts) > 1 else None)
        self.scim_calls.append({'method': method, 'resource': resource, 'id': ident, 'body': body,
                                'authorization': headers.get('Authorization'), 'host': headers.get('Host')})
        header = headers.get('Authorization') or ''
        if not header.startswith('Bearer ') or header[len('Bearer '):] not in self.api_tokens:
            return 403, {'detail': 'Not authorized.'}
        if self.directories[0]['scim_status'] != '1':
            return 500, {'detail': 'Unable to find SAML userdirectory.'}
        key = (method, resource)
        if key in self.scim_fail:
            self.scim_fail[key] -= 1
            if self.scim_fail[key] == 0:
                del self.scim_fail[key]
                return 500, {'detail': 'Injected failure for user %s.' % 'alice+mbcawssso@example.com'}
        saml_users = {u for u, row in self.users.items() if row['userdirectoryid'] == SAML_DIR}
        if (method, resource) == ('GET', 'Groups') and ident is None:
            return 200, {'schemas': ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
                         'totalResults': len(self.scim_groups),
                         'Resources': [{'id': gid, 'displayName': g['name'],
                                        'members': [{'value': u, 'display': self.users[u]['username']}
                                                    for u in sorted(g['members'])]}
                                       for gid, g in self.scim_groups.items()]}
        if (method, resource) == ('PATCH', 'Users') and ident in self.scim_vanish:
            self.users.pop(ident, None)
            return 404, {'detail': 'No permissions to referred object or it does not exist!'}
        if (method, resource) == ('PATCH', 'Users'):
            if ident not in saml_users or body.get('schemas') != [PATCH]:
                return 404, {'detail': 'No permissions to referred object or it does not exist!'}
            for op in body['Operations']:
                if op['path'] == 'active' and op['value'] is False:
                    self.deprovision(ident)
                elif op['path'] == 'active' and op['value'] is True and self.users[ident]['roleid'] == '0':
                    self.provision(ident)
            return 200, {'id': ident}
        if (method, resource) == ('PATCH', 'Groups'):
            if ident not in self.scim_groups or body.get('schemas') != [PATCH]:
                return 404, {'detail': 'No such group.'}
            for op in body['Operations']:
                ids = {v['value'] for v in op['value']}
                if not ids <= saml_users:
                    return 404, {'detail': 'No permissions to referred object or it does not exist!'}
                if op['op'] == 'add':
                    self.scim_groups[ident]['members'] |= ids
                elif op['op'] == 'remove':
                    self.scim_groups[ident]['members'] -= ids
                for userid in ids:
                    self.provision(userid)
            return 200, {'id': ident}
        if (method, resource) == ('POST', 'Groups'):
            ids = {m['value'] for m in body.get('members', [])}
            if not ids <= saml_users or not all(m.get('display') for m in body.get('members', [])):
                return 404, {'detail': 'No permissions to referred object or it does not exist!'}
            groupid = self.scim_group(body['displayName'])
            self.scim_groups[groupid]['members'] |= ids
            for userid in ids:
                self.provision(userid)
            return 200, {'id': groupid}
        return 501, {'detail': 'Not supported.'}

    def scim_writes(self):
        return [c for c in self.scim_calls if c['method'] != 'GET']


class MbcServer:
    """JSON-RPC on /api_jsonrpc.php (the frontend port) or SCIM on /api_scim.php/... (the SCIM port) on 127.0.0.1."""

    def __init__(self, state, scim=False):
        class Handler(BaseHTTPRequestHandler):
            def dispatch(handler):  # noqa: N805
                length = int(handler.headers.get('Content-Length', 0) or 0)
                raw = handler.rfile.read(length) if length else b''
                body = json.loads(raw) if raw else None
                path = urlsplit(handler.path).path
                with state.lock:
                    if path == '/api_jsonrpc.php' and handler.command == 'POST' and not scim:
                        reply = state.handle(body, handler.headers)
                        reply.update(jsonrpc='2.0', id=body.get('id'))
                        code = 200
                    elif path.startswith('/api_scim.php/') and scim:
                        code, reply = state.scim(handler.command, path, body, handler.headers)
                    else:
                        code, reply = 404, {}
                payload = json.dumps(reply).encode()
                handler.send_response(code)
                handler.send_header('Content-Type', 'application/json')
                handler.send_header('Content-Length', str(len(payload)))
                handler.end_headers()
                handler.wfile.write(payload)

            do_GET = do_POST = do_PATCH = dispatch

            def log_message(handler, *args):  # noqa: N805
                pass

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class FakePull:
    """Stands in for http.client.HTTPSConnection: one canned response or exception per connection."""

    def __init__(self, users=None, status=200, body=None, content_type='application/json', error=None,
                 application_id=APP):
        if body is None:
            payload = {'applicationId': application_id, 'generatedAt': '2026-11-14T00:00:00.000Z',
                       'users': [{'subject': s, 'roles': r} for s, r in sorted((users or {}).items())]}
            body = json.dumps(payload).encode()
        self.status, self.body, self.content_type, self.error = status, body, content_type, error
        self.requests = []

    def __call__(self, host):
        self.host = host
        return self

    def request(self, method, path, body=None, headers=None):
        self.requests.append({'method': method, 'path': path, 'headers': dict(headers or {})})
        if self.error is not None:
            raise self.error

    def getresponse(self):
        return self

    def getheader(self, name, default=None):
        return self.content_type if name.lower() == 'content-type' else default

    def read(self, amount=None):
        return self.body if amount is None else self.body[:amount]

    def close(self):
        pass


class PullSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_file = os.path.join(self.tmp.name, 'mbc-pull.state')
        self.status_file = os.path.join(self.tmp.name, 'last-success')
        original = pull.STATUS_FILE
        pull.STATUS_FILE = self.status_file
        self.addCleanup(setattr, pull, 'STATUS_FILE', original)

    def settings(self, port, scim_port=None, **overrides):
        settings = {'port': port, 'scim_port': scim_port or port + 1, 'server_name': SERVER_NAME, 'version': '7.0',
                    'url': 'https://sso.mbc-net.com', 'application_id': APP}
        settings.update(overrides)
        return settings

    def credentials(self, **overrides):
        credentials = {'pull_key': PULL_KEY, 'zabbix_api_token': API_TOKEN}
        credentials.update(overrides)
        return credentials

    def sync(self, state, fake, settings=None, credentials=None):
        """Run main() in-process; returns (exit code, summary or None, stdout + stderr)."""
        out, err = io.StringIO(), io.StringIO()
        directory = self.tmp.name
        with MbcServer(state) as server, MbcServer(state, scim=True) as scim_server:
            paths = []
            for name, data in (('settings.json', settings or self.settings(server.port, scim_server.port)),
                               ('credentials.json', credentials or self.credentials())):
                path = os.path.join(directory, name)
                with open(path, 'w', encoding='utf-8') as handle:
                    json.dump(data, handle)
                paths.append(path)
            original = pull.https_connection
            pull.https_connection = fake
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = pull.main(['zabbix_mbc_pull.py'] + paths)
            finally:
                pull.https_connection = original
        output = out.getvalue() + err.getvalue()
        for secret in (PULL_KEY, SECRET, API_TOKEN, 'Bearer'):
            self.assertNotIn(secret, output)
            self.assertNotIn(base64.b64encode(secret.encode()).decode(), output)
        for user in state.users.values():
            if '@' in user['username']:
                self.assertNotIn(user['username'], output)
                self.assertNotIn(user['username'].split('@')[0], output)
        lines = [line for line in out.getvalue().splitlines() if line.startswith('{')]
        return code, (json.loads(lines[-1]) if lines else None), output

    def jsonrpc_writes(self, state):
        reads = ('.get', 'apiinfo.version')
        return [m for m in state.methods() if not m.endswith(reads)]

    def team(self, state, count=4):
        """Enabled users that stay present, so that a single change stays under the safety cap."""
        return {subject('member%d' % i): ['viewer'] for i in range(count)
                if state.add_jit(subject('member%d' % i), ['viewer'])}

    # --- 200: synchronisation --------------------------------------------------------------

    def test_roles_are_aligned_absent_users_deprovisioned_and_returning_users_restored(self):
        state = FakeMbc()
        promoted = state.add_jit(subject('alice'), ['operator'])
        leaver = state.add_jit(subject('bob'), ['viewer'])
        returning = state.add_jit(subject('carol', 'mbclocal'), ['viewer'], deprovisioned=True)
        unchanged = state.add_jit(subject('dave'), ['admin'])
        users = self.team(state)
        users.update({subject('alice'): ['admin'], subject('carol', 'mbclocal'): ['viewer'],
                      subject('dave'): ['admin']})
        fake = FakePull(users)
        code, summary, _ = self.sync(state, fake)
        self.assertEqual(code, 0)
        self.assertEqual(state.user(promoted), ('6', ['11']))
        self.assertEqual(state.user(leaver), ('0', [state.deprovisioned]))
        self.assertEqual(state.user(returning), ('5', ['13']))
        self.assertEqual(state.user(unchanged), ('6', ['11']))
        self.assertIn(leaver, state.users)  # disabled, never deleted
        self.assertEqual(summary['deprovision'], 1)
        self.assertEqual(summary['restore'], 1)
        self.assertEqual(summary['role_changes'], 1)
        self.assertEqual(summary['drift'], 0)
        self.assertTrue(summary['changed'])
        self.assertEqual(summary['applicationId'], APP)
        self.assertEqual(summary['keyId'], KEY_ID)
        # Only reads on JSON-RPC; changes go through SCIM, deprovisioning first.
        self.assertEqual(self.jsonrpc_writes(state), [])
        writes = state.scim_writes()
        self.assertEqual((writes[0]['method'], writes[0]['resource'], writes[0]['id']), ('PATCH', 'Users', leaver))
        self.assertEqual(writes[0]['body']['Operations'], [{'op': 'replace', 'path': 'active', 'value': False}])
        self.assertTrue(all(c['authorization'] == 'Bearer ' + API_TOKEN and c['host'] == SERVER_NAME
                            for c in state.scim_calls))
        # The PULL request: one GET with the key as a Bearer token.
        self.assertEqual(fake.host, 'sso.mbc-net.com')
        self.assertEqual(fake.requests, [{'method': 'GET', 'path': '/pull/v1/applications/zabbix/assignments',
                                          'headers': {'Authorization': 'Bearer ' + PULL_KEY,
                                                      'Accept': 'application/json',
                                                      'User-Agent': 'ai-support-zabbix-mbc-pull/1'}}])
        # Idempotent: the second run changes nothing.
        state.scim_calls.clear()
        code, summary, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(state.scim_writes(), [])
        self.assertFalse(summary['changed'])
        self.assertEqual(summary['already_deprovisioned'], 1)

    def test_role_change_adds_before_removing_and_never_deprovisions(self):
        state = FakeMbc()
        userid = state.add_jit(subject('alice'), ['operator'])
        users = self.team(state)
        users[subject('alice')] = ['viewer']
        seen = []
        original = state.provision
        state.provision = lambda u: (original(u), seen.append(state.user(u)) if u == userid else None)
        code, _, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        ops = [(c['body']['Operations'][0]['op'], state.scim_groups[c['id']]['name']) for c in state.scim_writes()]
        self.assertEqual(ops, [('add', 'viewer'), ('remove', 'operator')])
        # In between the user holds both roles, never "no role" (deprovisioned, sessions ended).
        self.assertEqual(seen, [('5', ['12', '13']), ('5', ['13'])])
        self.assertEqual(state.user(userid), ('5', ['13']))

    def test_a_failing_addition_leaves_the_user_with_the_old_role(self):
        state = FakeMbc()
        userid = state.add_jit(subject('alice'), ['operator'])
        users = self.team(state)
        users[subject('alice')] = ['viewer']
        state.scim_fail[('PATCH', 'Groups')] = 1
        code, _, output = self.sync(state, FakePull(users))
        self.assertEqual(code, 2)
        self.assertIn('0 SCIM change(s) were applied', output)
        self.assertEqual(state.user(userid), ('5', ['12']))
        # The next run finishes the change.
        code, _, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(state.user(userid), ('5', ['13']))

    def test_changes_undone_by_logins_are_reported_as_reapplied(self):
        state = FakeMbc()
        leaver = state.add_jit(subject('bob'), ['viewer'])
        users = self.team(state)
        code, summary, _ = self.sync(state, FakePull(users))
        self.assertEqual((code, summary['deprovision'], summary['reapplied']), (0, 1, 0))
        self.assertEqual(os.stat(self.state_file).st_mode & 0o777, 0o600)
        with open(self.state_file, encoding='utf-8') as handle:
            text = handle.read()
        self.assertNotIn('bob', text)
        self.assertNotIn('"%s"' % leaver, text)
        # A steady state repeats nothing.
        code, summary, output = self.sync(state, FakePull(users))
        self.assertEqual((code, summary['reapplied']), (0, 0))
        self.assertNotIn('repeat', output)
        # A SAML login of the unassigned user re-provisions them from the assertion; the next run repeats.
        state.provision(leaver)
        code, summary, output = self.sync(state, FakePull(users))
        self.assertEqual((code, summary['deprovision'], summary['reapplied']), (0, 1, 1))
        self.assertIn('1 change(s) repeat a change applied in the last 24 hours', output)
        # Older than 24 hours: not a repeat.
        load, record = pull.load_state, pull.record_changes
        history = load(self.state_file)
        self.assertEqual(record(self.state_file, history, ['deprovision:%s' % leaver],
                                max(history['applied'].values()) + 24 * 3600)[0], 0)
        self.assertEqual(load(os.path.join(self.tmp.name, 'missing'))['applied'], {})

    def test_an_unwritable_state_file_only_warns(self):
        state = FakeMbc()
        state.add_jit(subject('bob'), ['viewer'])
        os.mkdir(self.state_file + '.tmp')
        code, summary, output = self.sync(state, FakePull(self.team(state)))
        self.assertEqual(code, 0)
        self.assertEqual(summary['deprovision'], 1)
        self.assertIn('Could not write the state file', output)

    def test_only_successful_runs_record_their_time_for_monitoring(self):
        state = FakeMbc()
        users = self.team(state)
        self.assertEqual(self.sync(state, FakePull(status=503))[0], 5)
        self.assertFalse(os.path.exists(self.status_file))
        before = int(time.time())
        self.assertEqual(self.sync(state, FakePull(users))[0], 0)
        self.assertEqual(os.stat(self.status_file).st_mode & 0o777, 0o644)
        with open(self.status_file, encoding='utf-8') as handle:
            recorded = int(handle.read())
        self.assertGreaterEqual(recorded, before)
        # A refused run (safety cap) leaves the last success as it was, so its age grows.
        self.assertEqual(self.sync(state, FakePull({}))[0], 6)
        with open(self.status_file, encoding='utf-8') as handle:
            self.assertEqual(int(handle.read()), recorded)

    def test_an_unwritable_status_file_warns_and_keeps_the_exit_code(self):
        state = FakeMbc()
        os.mkdir(self.status_file + '.tmp')
        code, _, output = self.sync(state, FakePull(self.team(state)))
        self.assertEqual(code, 0)
        self.assertIn('monitoring will report the sync as stale', output)

    def test_a_scim_failure_also_reports_an_unwritable_state_file(self):
        state = FakeMbc()
        state.add_jit(subject('bob'), ['operator'])
        users = self.team(state)
        users[subject('bob')] = ['admin']
        state.scim_fail[('PATCH', 'Groups')] = 1
        os.mkdir(self.state_file + '.tmp')
        code, _, output = self.sync(state, FakePull(users))
        self.assertEqual(code, 2)
        self.assertIn('Could not write the state file', output)

    def test_users_deleted_during_the_run_are_skipped(self):
        state = FakeMbc()
        gone = state.add_jit(subject('bob'), ['viewer'])
        users = self.team(state)
        state.scim_vanish.add(gone)
        code, summary, output = self.sync(state, FakePull(users))
        self.assertEqual(code, 0, output)
        self.assertEqual(summary['vanished'], 1)
        self.assertIn('deleted while the run was in progress', output)

    def test_a_group_created_after_the_read_is_patched_not_replaced(self):
        class Recorder:
            def __init__(self):
                self.calls = []

            def groups(self):
                return {'operator': ('77', {'9'})}

            def change_members(self, groupid, op, userids):
                self.calls.append(('patch', groupid, op, sorted(userids)))

            def create_group(self, name, members):
                self.calls.append(('post', name))

        scim = Recorder()
        plan = {'deprovision': [], 'restore': [], 'remove': {}, 'add': {'operator': {'5'}}, 'usernames': {'5': 'x'}}
        applied = []
        self.assertEqual(pull.apply_plan(scim, plan, {}, applied), 0)
        self.assertEqual(scim.calls, [('patch', '77', 'add', ['5'])])
        self.assertEqual(applied, ['add:operator:5'])

    def test_several_roles_get_every_mapped_group_and_the_highest_role(self):
        state = FakeMbc()
        userid = state.add_jit(subject('alice'), ['viewer'])
        users = self.team(state)
        users[subject('alice')] = ['viewer', 'admin']
        code, _, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(state.user(userid), ('6', ['11', '13']))

    def test_unknown_roles_are_ignored_and_users_with_only_unknown_roles_are_absent(self):
        state = FakeMbc()
        known = state.add_jit(subject('alice'), ['viewer'])
        unknown = state.add_jit(subject('bob'), ['viewer'])
        users = self.team(state)
        users.update({subject('alice'): ['viewer', 'auditor'], subject('bob'): ['auditor']})
        code, summary, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(state.user(known), ('5', ['13']))
        self.assertEqual(state.user(unknown), ('0', [state.deprovisioned]))
        self.assertEqual(summary['unmapped_roles_only'], 1)
        self.assertFalse(any(g['name'] == 'auditor' for g in state.scim_groups.values()))

    def test_a_missing_scim_group_is_created_with_its_members(self):
        state = FakeMbc()
        userid = state.add_jit(subject('alice'), ['viewer'])
        users = self.team(state)
        users[subject('alice')] = ['operator']
        self.assertFalse(any(g['name'] == 'operator' for g in state.scim_groups.values()))
        code, _, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        post = [c for c in state.scim_writes() if c['method'] == 'POST']
        self.assertEqual(len(post), 1)
        self.assertEqual(post[0]['body']['displayName'], 'operator')
        self.assertEqual(state.user(userid), ('5', ['12']))

    def test_non_saml_admin_super_admin_and_admin_disabled_users_are_never_touched(self):
        state = FakeMbc()
        internal = state.add_user(subject('erin'), userdirectoryid='0', groups=['12'], roleid='5')
        super_admin = state.add_jit(subject('frank'), ['admin'])
        state.users[super_admin]['roleid'] = '3'
        locked = state.add_jit(subject('grace'), ['viewer'])
        state.users[locked]['usrgrps'].append(state.admin_disabled)
        named_admin = state.add_jit('admin', ['viewer'])
        before = {u: dict(row, usrgrps=list(row['usrgrps'])) for u, row in state.users.items()}
        users = self.team(state)
        code, summary, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        for userid in ('1', internal, super_admin, locked, named_admin):
            self.assertEqual(state.users[userid], before[userid])
        service = next(u for u, row in state.users.items() if row['username'] == 'ai-support-automation')
        self.assertEqual(state.users[service], before[service])
        self.assertEqual(summary['protected'], 2)
        self.assertEqual(summary['skipped_disabled'], 1)
        self.assertEqual(state.scim_writes(), [])

    def test_case_insensitive_saml_matches_usernames_ignoring_case(self):
        state = FakeMbc(case_sensitive='0')
        userid = state.add_jit('Alice+mbcawssso@Example.com', ['viewer'])
        users = self.team(state)
        users[subject('alice')] = ['admin']
        code, _, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(state.user(userid), ('6', ['11']))
        # Case-sensitive: the same user is absent (and deprovisioned).
        state = FakeMbc(case_sensitive='1')
        userid = state.add_jit('Alice+mbcawssso@Example.com', ['viewer'])
        users = self.team(state)
        users[subject('alice')] = ['admin']
        code, _, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(state.user(userid), ('0', [state.deprovisioned]))

    def test_usernames_that_collide_ignoring_case_change_nothing(self):
        state = FakeMbc(case_sensitive='0')
        state.add_jit('Alice+mbcawssso@example.com', ['viewer'])
        state.add_jit(subject('alice'), ['viewer'])
        users = self.team(state)
        code, _, output = self.sync(state, FakePull(users))
        self.assertEqual(code, 2)
        self.assertIn('same username ignoring case', output)
        self.assertEqual(state.scim_writes(), [])

    def test_drift_is_reported_but_not_forced(self):
        state = FakeMbc()
        userid = state.add_jit(subject('alice'), ['viewer'])
        users = self.team(state)
        users[subject('alice')] = ['viewer']
        # The mapping changed after the last login: viewer now maps to SSO operators.
        state.directories[0]['provision_groups'][2]['user_groups'] = [{'usrgrpid': '12'}]
        code, summary, output = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(summary['drift'], 5)
        self.assertIn('next login', output)
        self.assertEqual(state.scim_writes(), [])
        self.assertEqual(state.user(userid), ('5', ['13']))

    def test_users_listed_but_not_yet_provisioned_are_counted_only(self):
        state = FakeMbc()
        users = self.team(state)
        users[subject('newcomer')] = ['viewer']
        code, summary, _ = self.sync(state, FakePull(users))
        self.assertEqual(code, 0)
        self.assertEqual(summary['not_provisioned'], 1)
        self.assertEqual(state.scim_writes(), [])

    # --- anything but a usable 200: nothing changes ----------------------------------------

    def assert_nothing_changed(self, fake, reason=None):
        state = FakeMbc()
        state.add_jit(subject('alice'), ['viewer'])
        before = json.dumps(state.users, sort_keys=True)
        code, summary, output = self.sync(state, fake)
        self.assertEqual(code, 5, output)
        self.assertIn('Nothing was changed', output)
        if reason:
            self.assertIn(reason, output)
        # Zabbix is not even contacted.
        self.assertEqual(state.calls, [])
        self.assertEqual(state.scim_calls, [])
        self.assertEqual(json.dumps(state.users, sort_keys=True), before)
        self.assertFalse(summary['changed'])
        self.assertEqual(len(fake.requests), 1)  # no retry

    def test_http_errors_change_nothing(self):
        for status in (301, 302, 400, 401, 403, 404, 405, 429, 500, 502, 503, 504):
            with self.subTest(status=status):
                body = json.dumps({'error': 'X'}).encode()
                self.assert_nothing_changed(FakePull(status=status, body=body), 'HTTP %d' % status)

    def test_transport_failures_change_nothing(self):
        for error in (socket.timeout('timed out'), ConnectionRefusedError(), ssl.SSLError('bad certificate'),
                      OSError('unreachable')):
            with self.subTest(error=type(error).__name__):
                self.assert_nothing_changed(FakePull(error=error), 'request failed')

    def test_malformed_responses_change_nothing(self):
        good = {'subject': subject('alice'), 'roles': ['viewer']}

        def body(**fields):
            payload = {'applicationId': APP, 'generatedAt': '2026-11-14T00:00:00.000Z', 'users': [good]}
            payload.update(fields)
            return json.dumps(payload).encode()

        cases = {
            'not JSON': FakePull(body=b'<html>CloudFront</html>'),
            'HTML content type': FakePull(body=body(), content_type='text/html'),
            'array': FakePull(body=b'[]'),
            'other application': FakePull(body=body(applicationId='zabbix-mbc')),
            'no applicationId': FakePull(body=json.dumps({'generatedAt': 'x', 'users': []}).encode()),
            'no generatedAt': FakePull(body=body(generatedAt='')),
            'users not a list': FakePull(body=body(users={'a': 1})),
            'duplicate subject': FakePull(body=body(users=[good, {'subject': subject('alice'), 'roles': ['admin']}])),
            'upper case subject': FakePull(body=body(users=[{'subject': 'Alice+mbcawssso@example.com',
                                                            'roles': ['viewer']}])),
            'not an MBC subject': FakePull(body=body(users=[{'subject': 'alice@example.com', 'roles': ['viewer']}])),
            'long subject': FakePull(body=body(users=[{'subject': 'a' * 90 + '+mbclocal@example.com',
                                                      'roles': ['viewer']}])),
            'no roles': FakePull(body=body(users=[{'subject': subject('alice'), 'roles': []}])),
            'roles not a list': FakePull(body=body(users=[{'subject': subject('alice'), 'roles': 'viewer'}])),
            'malformed role': FakePull(body=body(users=[{'subject': subject('alice'), 'roles': ['Viewer!']}])),
            'duplicate role': FakePull(body=body(users=[{'subject': subject('alice'), 'roles': ['viewer', 'viewer']}])),
            'entry without roles': FakePull(body=body(users=[{'subject': subject('alice')}])),
            'entry not an object': FakePull(body=body(users=['alice'])),
            'too large': FakePull(body=b' ' * (4 * 1024 * 1024 + 1)),
        }
        for name, fake in cases.items():
            with self.subTest(case=name):
                self.assert_nothing_changed(fake)

    # --- safety cap -----------------------------------------------------------------------------

    def run_cap(self, enabled, present):
        state = FakeMbc()
        ids = [state.add_jit(subject('user%d' % i), ['viewer']) for i in range(enabled)]
        before = json.dumps(state.users, sort_keys=True)
        users = {subject('user%d' % i): ['viewer'] for i in range(present)}
        code, summary, output = self.sync(state, FakePull(users))
        return state, ids, before, code, summary, output

    def test_safety_cap_refuses_mass_deprovisioning(self):
        for enabled, present in ((1, 0), (3, 0), (3, 1), (5, 2), (4, 1), (0, 0)):
            with self.subTest(enabled=enabled, present=present):
                state, _, before, code, summary, output = self.run_cap(enabled, present)
                if enabled == 0:
                    self.assertEqual(code, 0)
                    continue
                self.assertEqual(code, 6, output)
                self.assertIn('safety cap', output)
                self.assertIn('Nothing was changed', output)
                self.assertEqual(state.scim_writes(), [])
                self.assertEqual(json.dumps(state.users, sort_keys=True), before)
                self.assertEqual(summary['deprovision'], enabled - present)

    def test_safety_cap_allows_up_to_half(self):
        for enabled, present in ((3, 2), (4, 2), (2, 2), (5, 3)):
            with self.subTest(enabled=enabled, present=present):
                state, ids, _, code, summary, _ = self.run_cap(enabled, present)
                self.assertEqual(code, 0)
                self.assertEqual(summary['deprovision'], enabled - present)
                for userid in ids[present:]:
                    self.assertEqual(state.user(userid), ('0', [state.deprovisioned]))

    def test_already_deprovisioned_users_do_not_count_as_enabled(self):
        state = FakeMbc()
        state.add_jit(subject('a'), ['viewer'])
        state.add_jit(subject('b'), ['viewer'])
        for name in ('c', 'd', 'e'):
            state.add_jit(subject(name), ['viewer'], deprovisioned=True)
        # 1 of 2 enabled would be disabled: allowed (not more than half, not all).
        code, summary, _ = self.sync(state, FakePull({subject('a'): ['viewer']}))
        self.assertEqual(code, 0)
        self.assertEqual(summary['enabled'], 2)
        # Then the last enabled user: all of them, refused.
        code, _, _ = self.sync(state, FakePull({}))
        self.assertEqual(code, 6)

    # --- Zabbix side ---------------------------------------------------------------------------

    def test_scim_must_be_enabled_and_saml_must_be_on(self):
        for name, change in (('scim', lambda s: s.directories[0].update(scim_status='0')),
                             ('saml', lambda s: s.auth.update(saml_auth_enabled='0')),
                             ('jit', lambda s: s.auth.update(saml_jit_status='0')),
                             ('deprovisioned group', lambda s: s.auth.update(disabled_usrgrpid='0')),
                             ('wildcard', lambda s: s.directories[0]['provision_groups'].append(
                                 {'name': 'ops*', 'roleid': '5', 'user_groups': [{'usrgrpid': '12'}]}))):
            with self.subTest(case=name):
                state = FakeMbc()
                change(state)
                users = self.team(state)
                code, _, output = self.sync(state, FakePull(users))
                self.assertEqual(code, 2, output)
                self.assertIn('Nothing was changed', output)
                self.assertEqual(state.scim_calls, [])

    def test_a_scim_failure_stops_and_reports_progress_without_details(self):
        state = FakeMbc()
        state.add_jit(subject('alice'), ['viewer'])
        state.add_jit(subject('bob'), ['operator'])
        users = self.team(state)
        users[subject('bob')] = ['admin']
        state.scim_fail[('PATCH', 'Groups')] = 1
        code, summary, output = self.sync(state, FakePull(users))
        self.assertEqual(code, 2)
        self.assertIsNone(summary)
        self.assertIn('Zabbix SCIM PATCH Groups returned HTTP 500', output)
        # Deprovisioning alice and creating the admin SCIM group (POST) succeeded; removing bob from operator failed.
        self.assertIn('2 SCIM change(s) were applied', output)
        self.assertNotIn('Injected failure', output)

    def test_a_rejected_zabbix_token_fails_before_scim(self):
        state = FakeMbc()
        state.tokens.discard(API_TOKEN)
        code, _, output = self.sync(state, FakePull(self.team(state)))
        self.assertEqual(code, 2)
        self.assertIn('token was rejected', output)
        self.assertEqual(state.scim_calls, [])

    # --- input validation -------------------------------------------------------------------

    def test_invalid_input_is_rejected_before_any_request(self):
        cases = [
            ({'url': 'http://sso.mbc-net.com'}, {}),
            ({'url': 'https://sso.example.com'}, {}),
            ({'url': 'https://sso.mbc-net.com/pull'}, {}),
            ({'url': 'https://sso.mbc-net.com:8443'}, {}),
            ({'url': 'https://sso.mbc-net.com.example.com'}, {}),
            ({'application_id': 'Zabbix'}, {}),
            ({'application_id': 'zabbix/../x'}, {}),
            ({'application_id': ''}, {}),
            ({'version': '6.0'}, {}),
            ({'port': True}, {}),
            ({'server_name': 'bad name'}, {}),
            ({'extra': 1}, {}),
            ({'scim_port': 1}, {}),
            ({'scim_port': 0}, {}),
            ({}, {'pull_key': 'k123.' + 'x' * 43}),
            ({}, {'pull_key': KEY_ID + '.' + 'x' * 42}),
            ({}, {'pull_key': KEY_ID.upper() + '.' + SECRET}),
            ({}, {'pull_key': KEY_ID + ':' + SECRET}),
            ({}, {'zabbix_api_token': 'A' * 64}),
            ({}, {'zabbix_api_token': ''}),
        ]
        for settings, credentials in cases:
            with self.subTest(settings=settings, credentials=list(credentials)):
                state = FakeMbc()
                fake = FakePull()
                code, _, output = self.sync(state, fake, settings=dict(self.settings(1), **settings),
                                            credentials=self.credentials(**credentials))
                self.assertEqual(code, 2, output)
                self.assertIn('Invalid input', output)
                self.assertEqual(fake.requests, [])
                self.assertEqual(state.calls, [])

    def test_validate_input_accepts_the_documented_forms(self):
        for url in ('https://sso.mbc-net.com', 'https://sso.mbc-net.com/'):
            config = pull.validate_input(self.settings(8080, url=url, application_id='zabbix-mbc'),
                                         self.credentials())
            self.assertEqual((config['host'], config['key_id']), ('sso.mbc-net.com', KEY_ID))

    def test_safety_cap_rule(self):
        cap = pull.safety_cap_exceeded
        self.assertTrue(cap(1, 1))
        self.assertTrue(cap(3, 3))
        self.assertTrue(cap(3, 2))
        self.assertTrue(cap(5, 3))
        self.assertFalse(cap(3, 1))
        self.assertFalse(cap(4, 2))
        self.assertFalse(cap(2, 1))
        self.assertFalse(cap(0, 0))
        self.assertFalse(cap(5, 0))


if __name__ == '__main__':
    unittest.main()
