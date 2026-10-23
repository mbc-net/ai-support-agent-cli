"""Unit tests for roles/zabbix_web/files/zabbix_api.py (design section 4.2 / 7.1.4).

The helper runs as a subprocess against a fake JSON-RPC server that models the
Zabbix 6.0 (token in the request body ``auth``) and 7.0 (``Authorization:
Bearer`` required) frontends. Every case also checks that no password or token
(plain or Base64) reaches stdout / stderr.

Run: python3 -m unittest discover -s ansible/tests -v
"""
import base64
import copy
import json
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HELPER = pathlib.Path(__file__).parents[1] / 'roles/zabbix_web/files/zabbix_api.py'
SERVER_NAME = 'zabbix.example.test'
NEW = 'N3w-Pass "with" $(quotes) & spaces'
PREVIOUS = 'Pr3vious-Pass!'
THIRD = 'Th1rd-Unknown-Pass'
LOGIN_ERROR = {'code': -32500, 'message': 'Application error.',
               'data': 'Incorrect user name or password or account is temporarily blocked.'}
DEFAULT_HOUSEKEEPING = {
    'hk_events_mode': '1', 'hk_events_trigger': '365d', 'hk_events_service': '1d',
    'hk_events_internal': '1d', 'hk_events_discovery': '1d', 'hk_events_autoreg': '1d',
    'hk_services_mode': '1', 'hk_services': '365d', 'hk_audit_mode': '1', 'hk_audit': '31d',
    'hk_sessions_mode': '1', 'hk_sessions': '365d', 'hk_history_mode': '1',
    'hk_history_global': '0', 'hk_history': '31d', 'hk_trends_mode': '1',
    'hk_trends_global': '0', 'hk_trends': '365d', 'compression_status': '0',
    'compress_older': '7d', 'db_extension': '', 'compression_availability': '0',
}


class FakeZabbix:
    """State of one fake frontend. ``auth_mode`` is 'body' (6.0) or 'bearer' (7.0)."""

    def __init__(self, version='7.0.5', password='zabbix'):
        self.version = version
        self.auth_mode = 'bearer' if version.startswith('7.') else 'body'
        self.password = password
        self.tokens = set()
        self.issued = []
        self.calls = []
        self.housekeeping = copy.deepcopy(DEFAULT_HOUSEKEEPING)
        self.policy_error = False
        self.break_relogin = False
        self.lock = threading.Lock()

    def methods(self):
        return [call['method'] for call in self.calls]

    def params_of(self, method):
        return [call['params'] for call in self.calls if call['method'] == method]

    def handle(self, body, headers):
        method = body.get('method')
        params = body.get('params')
        header = headers.get('Authorization')
        self.calls.append({'method': method, 'params': params, 'auth': body.get('auth'),
                           'authorization': header, 'host': headers.get('Host'),
                           'content_type': headers.get('Content-Type')})
        if method == 'apiinfo.version':
            if 'auth' in body or header:
                return {'error': {'code': -32602, 'message': 'Invalid params.',
                                  'data': 'The "apiinfo.version" method must be called without authorization.'}}
            return {'result': self.version}
        if method == 'user.login':
            if params.get('username') == 'Admin' and params.get('password') == self.password:
                token = secrets.token_hex(16)
                self.tokens.add(token)
                self.issued.append(token)
                return {'result': token}
            return {'error': LOGIN_ERROR}
        if self.auth_mode == 'bearer':
            if 'auth' in body:
                return {'error': {'code': -32602, 'message': 'Invalid params.', 'data': 'Bearer required.'}}
            token = header[len('Bearer '):] if header and header.startswith('Bearer ') else None
        else:
            token = body.get('auth')  # 6.0 ignores the Authorization header
        if token not in self.tokens:
            return {'error': {'code': -32602, 'message': 'Invalid params.',
                              'data': 'Session terminated, re-login, please.'}}
        if method == 'user.logout':
            self.tokens.discard(token)
            return {'result': True}
        if method == 'user.get':
            if params.get('filter') == {'username': 'Admin'}:
                return {'result': [{'userid': '1'}]}
            return {'result': []}
        if method == 'user.update':
            # 6.0 has no current_passwd (rejected as unexpected, as the real 6.0.48 does);
            # 7.0 requires it when Admin changes its own password.
            if self.version.startswith('6.0.'):
                if 'current_passwd' in params:
                    return {'error': {'code': -32602, 'message': 'Invalid params.',
                                      'data': 'Invalid parameter "/1": unexpected parameter "current_passwd".'}}
            elif params.get('current_passwd') != self.password:
                return {'error': {'code': -32602, 'message': 'Invalid params.',
                                  'data': 'Incorrect current password.'}}
            if self.policy_error:
                return {'error': {'code': -32602, 'message': 'Invalid params.',
                                  'data': 'Incorrect value for field "passwd": must be at least 12 characters long.'}}
            self.password = params['passwd'] if not self.break_relogin else secrets.token_hex(8)
            self.tokens.clear()  # a password change ends the existing sessions
            return {'result': {'userids': ['1']}}
        if method == 'housekeeping.get':
            return {'result': dict(self.housekeeping)}
        if method == 'housekeeping.update':
            for key, value in params.items():
                self.housekeeping[key] = str(value)
            return {'result': sorted(params)}
        return {'error': {'code': -32601, 'message': 'Method not found.'}}


class Server:
    def __init__(self, state, status=200, raw=None):
        self.state = state

        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):  # noqa: N805
                length = int(handler.headers.get('Content-Length', 0))
                body = json.loads(handler.rfile.read(length))
                if handler.path != '/api_jsonrpc.php':
                    payload = b'not found'
                    code = 404
                elif raw is not None or status != 200:
                    payload = raw if raw is not None else b'{}'
                    code = status
                else:
                    with state.lock:
                        reply = state.handle(body, handler.headers)
                    reply.update(jsonrpc='2.0', id=body.get('id'))
                    payload = json.dumps(reply).encode()
                    code = 200
                handler.send_response(code)
                handler.send_header('Content-Type', 'application/json')
                handler.send_header('Content-Length', str(len(payload)))
                handler.end_headers()
                handler.wfile.write(payload)

            def log_message(handler, *args):  # noqa: N805
                pass

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': 0.05},
                                       daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def unused_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class ZabbixApiHelperTest(unittest.TestCase):
    def run_helper(self, port, version='7.0', password=NEW, previous='', housekeeping=None, state=None):
        config = {'port': port, 'server_name': SERVER_NAME, 'version': version, 'password': password,
                  'previous_password': previous, 'housekeeping': housekeeping or {}}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'credentials.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(config, handle)
            proc = subprocess.run([sys.executable, str(HELPER), path], capture_output=True, text=True,
                                  timeout=60)
        # The initial password 'zabbix' is public and appears in variable names, so it is not checked.
        secrets_seen = [s for s in (password, previous, NEW, PREVIOUS, THIRD) if s and s != 'zabbix']
        if state is not None:
            secrets_seen += state.issued
        output = proc.stdout + proc.stderr
        for secret in secrets_seen:
            self.assertNotIn(secret, output)
            self.assertNotIn(base64.b64encode(secret.encode()).decode(), output)
        return proc

    def converge(self, state, **kwargs):
        with Server(state) as server:
            return self.run_helper(server.port, version=state.version[:3], state=state, **kwargs)

    def result(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    # --- password state machine -------------------------------------------------

    def test_new_password_already_valid_is_unchanged(self):
        for version in ('6.0.30', '7.0.5'):
            with self.subTest(version=version):
                state = FakeZabbix(version, password=NEW)
                out = self.result(self.converge(state))
                self.assertEqual(out, {'changed': False, 'password_changed': False, 'housekeeping_changed': []})
                self.assertEqual(state.methods(), ['apiinfo.version', 'user.login', 'user.logout'])
                self.assertNotIn('user.update', state.methods())

    def test_previous_password_is_rotated(self):
        for version in ('6.0.30', '7.0.5'):
            with self.subTest(version=version):
                state = FakeZabbix(version, password=PREVIOUS)
                out = self.result(self.converge(state, previous=PREVIOUS))
                self.assertEqual(out, {'changed': True, 'password_changed': True, 'housekeeping_changed': []})
                self.assertEqual(state.password, NEW)
                self.assertEqual([p['password'] for p in state.params_of('user.login')], [NEW, PREVIOUS, NEW])
                expected = {'userid': '1', 'passwd': NEW}
                if version.startswith('7.'):
                    expected['current_passwd'] = PREVIOUS
                self.assertEqual(state.params_of('user.update'), [expected])

    def test_initial_password_is_replaced_with_current_passwd_on_7_0_only(self):
        for version in ('6.0.30', '7.0.5'):
            with self.subTest(version=version):
                state = FakeZabbix(version, password='zabbix')
                out = self.result(self.converge(state, previous=PREVIOUS))
                self.assertTrue(out['password_changed'])
                self.assertEqual([p['password'] for p in state.params_of('user.login')],
                                 [NEW, PREVIOUS, 'zabbix', NEW])
                expected = {'userid': '1', 'passwd': NEW}
                if version.startswith('7.'):
                    expected['current_passwd'] = 'zabbix'
                self.assertEqual(state.params_of('user.update'), [expected])
                self.assertEqual(state.params_of('user.get'),
                                 [{'output': ['userid'], 'filter': {'username': 'Admin'}}])

    def test_empty_previous_password_is_not_tried(self):
        state = FakeZabbix(password='zabbix')
        self.result(self.converge(state))
        self.assertEqual([p['password'] for p in state.params_of('user.login')], [NEW, 'zabbix', NEW])

    def test_no_password_works_exits_3(self):
        state = FakeZabbix(password=THIRD)
        proc = self.converge(state, previous=PREVIOUS)
        self.assertEqual(proc.returncode, 3)
        self.assertIn('Could not log in as Admin', proc.stderr)
        self.assertEqual(proc.stdout, '')
        self.assertEqual(len(state.params_of('user.login')), 3)
        self.assertNotIn('user.update', state.methods())

    def test_password_policy_violation_shows_api_error_and_exits_2(self):
        state = FakeZabbix(password='zabbix')
        state.policy_error = True
        proc = self.converge(state)
        self.assertEqual(proc.returncode, 2)
        self.assertIn('must be at least 12 characters long', proc.stderr)
        self.assertIn('user.update', proc.stderr)
        self.assertEqual(state.password, 'zabbix')

    def test_relogin_failure_after_change_exits_4(self):
        state = FakeZabbix(password='zabbix')
        state.break_relogin = True
        proc = self.converge(state)
        self.assertEqual(proc.returncode, 4)
        self.assertIn('probably applied', proc.stderr)

    def test_logout_is_called_for_the_final_session(self):
        state = FakeZabbix(password='zabbix')
        self.result(self.converge(state))
        self.assertEqual(state.methods()[-1], 'user.logout')
        final = state.issued[-1]
        logouts = [c['authorization'] for c in state.calls if c['method'] == 'user.logout']
        self.assertIn('Bearer ' + final, logouts)
        self.assertNotIn(final, state.tokens)

    # --- transport / protocol ---------------------------------------------------

    def test_connection_refused_exits_2(self):
        proc = self.run_helper(unused_port())
        self.assertEqual(proc.returncode, 2)
        self.assertIn('request failed', proc.stderr)
        self.assertNotIn('Errno', proc.stderr)

    def test_http_error_and_non_json_exit_2(self):
        for status, raw, text in ((500, None, 'HTTP 500'), (200, b'<html>', 'not JSON')):
            with self.subTest(status=status), Server(FakeZabbix(), status=status, raw=raw) as server:
                proc = self.run_helper(server.port)
                self.assertEqual(proc.returncode, 2)
                self.assertIn(text, proc.stderr)

    def test_version_mismatch_exits_2_before_login(self):
        state = FakeZabbix('6.0.30', password=NEW)
        with Server(state) as server:
            proc = self.run_helper(server.port, version='7.0', state=state)
        self.assertEqual(proc.returncode, 2)
        self.assertIn('does not match zabbix_web_version', proc.stderr)
        self.assertEqual(state.methods(), ['apiinfo.version'])

    def test_auth_transport_matches_the_version(self):
        for version, bearer in (('6.0.30', False), ('7.0.5', True)):
            with self.subTest(version=version):
                state = FakeZabbix(version, password='zabbix')
                self.result(self.converge(state, housekeeping={'hk_audit': '30d'}))
                for call in state.calls:
                    self.assertEqual(call['host'], SERVER_NAME)
                    self.assertEqual(call['content_type'], 'application/json-rpc')
                authed = [c for c in state.calls if c['method'] not in ('apiinfo.version', 'user.login')]
                self.assertTrue(authed)
                for call in authed:
                    if bearer:
                        self.assertIsNone(call['auth'])
                        self.assertTrue(call['authorization'].startswith('Bearer '))
                    else:
                        self.assertIsNone(call['authorization'])
                        self.assertIsNotNone(call['auth'])

    # --- housekeeping -----------------------------------------------------------

    def test_housekeeping_without_difference_does_not_update(self):
        state = FakeZabbix(password=NEW)
        out = self.result(self.converge(state, housekeeping={'hk_events_trigger': '365d', 'hk_audit_mode': 1}))
        self.assertEqual(out, {'changed': False, 'password_changed': False, 'housekeeping_changed': []})
        self.assertIn('housekeeping.get', state.methods())
        self.assertNotIn('housekeeping.update', state.methods())

    def test_periods_are_compared_in_seconds(self):
        state = FakeZabbix(password=NEW)
        out = self.result(self.converge(state, housekeeping={
            'hk_events_trigger': '31536000', 'hk_services': 31536000, 'hk_sessions': '52w',
            'hk_audit': '744h', 'hk_events_service': '86400s', 'hk_history_mode': '1'}))
        # 52w (364d) differs from 365d; the others are equal in seconds.
        self.assertEqual(out['housekeeping_changed'], ['hk_sessions'])
        # Periods are sent as written, not as normalized seconds.
        self.assertEqual(state.params_of('housekeeping.update'), [{'hk_sessions': '52w'}])

    def test_only_changed_keys_are_sent_and_rerun_is_unchanged(self):
        state = FakeZabbix(password=NEW)
        desired = {'hk_history_global': 1, 'hk_trends_global': '1', 'hk_history': '90d', 'hk_audit': '31d',
                   'hk_trends': 0}
        out = self.result(self.converge(state, housekeeping=desired))
        self.assertTrue(out['changed'])
        self.assertEqual(out['housekeeping_changed'], ['hk_history', 'hk_history_global', 'hk_trends',
                                                       'hk_trends_global'])
        self.assertEqual(state.params_of('housekeeping.update'), [{
            'hk_history': '90d', 'hk_history_global': 1, 'hk_trends': '0', 'hk_trends_global': 1}])
        state.calls.clear()
        again = self.result(self.converge(state, housekeeping=desired))
        self.assertFalse(again['changed'])
        self.assertNotIn('housekeeping.update', state.methods())

    def test_housekeeping_uses_the_session_from_the_relogin(self):
        state = FakeZabbix(password='zabbix')
        out = self.result(self.converge(state, housekeeping={'hk_audit': '30d'}))
        self.assertEqual(out, {'changed': True, 'password_changed': True, 'housekeeping_changed': ['hk_audit']})
        relogin_token = state.issued[-1]
        for call in state.calls:
            if call['method'].startswith('housekeeping.'):
                self.assertEqual(call['authorization'], 'Bearer ' + relogin_token)

    def test_invalid_housekeeping_is_rejected_before_any_request(self):
        cases = {
            'unknown key': {'hk_unknown': '1d'},
            'read-only db_extension': {'db_extension': 'timescaledb'},
            'read-only compression_availability': {'compression_availability': '1'},
            'mode boolean': {'hk_events_mode': True},
            'mode out of range': {'hk_events_mode': 2},
            'mode text': {'hk_events_mode': 'yes'},
            'period boolean': {'hk_audit': True},
            'period macro': {'hk_audit': '{$HK_AUDIT}'},
            'period year unit': {'hk_audit': '1y'},
            'period month unit': {'hk_audit': '1M'},
            'period space': {'hk_audit': '1 d'},
            'period negative': {'hk_audit': -1},
            'period too short': {'hk_audit': '23h'},
            'period zero not allowed': {'hk_audit': 0},
            'period too long': {'hk_audit': '9126d'},
            'history too short': {'hk_history': '59m'},
            'trends too short': {'hk_trends': '23h'},
            'compress_older too short': {'compress_older': '6d'},
            'period float': {'hk_audit': 1.5},
        }
        for label, housekeeping in cases.items():
            with self.subTest(label), Server(FakeZabbix(password=NEW)) as server:
                proc = self.run_helper(server.port, housekeeping=housekeeping, state=server.state)
                self.assertEqual(proc.returncode, 2, label)
                self.assertIn('housekeeping', proc.stderr)
                self.assertEqual(server.state.calls, [])

    def test_boundaries_are_accepted(self):
        state = FakeZabbix(password=NEW)
        out = self.result(self.converge(state, housekeeping={
            'hk_history': '1h', 'hk_trends': '1d', 'hk_audit': '9125d', 'hk_sessions': 788400000}))
        self.assertEqual(len(out['housekeeping_changed']), 4)

    def test_compression_requires_timescaledb_and_does_not_update(self):
        for housekeeping in ({'compression_status': 1}, {'compression_status': '1'}, {'compress_older': '14d'}):
            with self.subTest(housekeeping=housekeeping):
                state = FakeZabbix(password=NEW)
                proc = self.converge(state, housekeeping=dict(housekeeping, hk_audit='30d'))
                self.assertEqual(proc.returncode, 2)
                self.assertIn('TimescaleDB', proc.stderr)
                self.assertNotIn('housekeeping.update', state.methods())

    def test_compression_status_zero_is_allowed_without_timescaledb(self):
        state = FakeZabbix(password=NEW)
        out = self.result(self.converge(state, housekeeping={'compression_status': 0}))
        self.assertFalse(out['changed'])

    def test_compression_unavailable_fails(self):
        state = FakeZabbix(password=NEW)
        state.housekeeping.update(db_extension='timescaledb', compression_availability='0')
        proc = self.converge(state, housekeeping={'compression_status': 1})
        self.assertEqual(proc.returncode, 2)
        self.assertIn('compression_availability', proc.stderr)
        self.assertNotIn('housekeeping.update', state.methods())

    def test_compression_on_timescaledb(self):
        state = FakeZabbix(password=NEW)
        state.housekeeping.update(db_extension='timescaledb', compression_availability='1')
        out = self.result(self.converge(state, housekeeping={'compression_status': 1, 'compress_older': '14d'}))
        self.assertEqual(out['housekeeping_changed'], ['compress_older', 'compression_status'])

    # --- input validation -------------------------------------------------------

    def test_invalid_password_input_is_rejected_before_any_request(self):
        for label, password, previous in (('initial', 'zabbix', ''), ('short', 'Abcdef1', ''),
                                          ('long', 'a' * 73, ''), ('newline', 'abcdefgh\nij', ''),
                                          ('leading space', ' abcdefghij', ''),
                                          ('previous too long', NEW, 'p' * 73),
                                          ('previous newline', NEW, 'pre\nvious')):
            with self.subTest(label), Server(FakeZabbix()) as server:
                proc = self.run_helper(server.port, password=password, previous=previous)
                self.assertEqual(proc.returncode, 2)
                self.assertEqual(server.state.calls, [])

    def test_unreadable_input_file(self):
        proc = subprocess.run([sys.executable, str(HELPER), '/nonexistent/credentials.json'],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2)
        self.assertIn('Could not read', proc.stderr)


if __name__ == '__main__':
    unittest.main()
