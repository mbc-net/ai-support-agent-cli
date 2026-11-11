"""Unit tests for the SAML / API token parts of roles/zabbix_web/files/zabbix_api.py.

The helper runs as a subprocess against a fake JSON-RPC server (``FakeSaml``) that extends the
password / housekeeping fake of test_zabbix_api.py with the user, user group, role, token, global
macro, user directory, authentication and owned-object methods the helper uses. Every case checks
that no password, API token or session token (plain or Base64) reaches stdout / stderr.

Run: python3 -m unittest discover -s ansible/tests -v
"""
import base64
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_zabbix_api import HELPER, NEW, SERVER_NAME, FakeZabbix, Server  # noqa: E402

API_TOKEN = 'a' * 64
SERVICE = 'ai-support-automation'
SERVICE_GROUP = 'AI support automation (API only)'
LOCAL_MARKER = '{$AI_SUPPORT_SAML_LOCAL_USERS_DONE}'
SERVICE_MARKER = '{$AI_SUPPORT_SERVICE_USER_DONE}'
PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
# SSO responders does not exist yet (created by the helper); SSO viewers exists in FakeSaml without rights.
USER_GROUPS = [{'name': 'SSO responders', 'permission': 'read-write', 'hostgroups': 'all'},
               {'name': 'SSO viewers', 'permission': 'read', 'hostgroups': ['Linux servers', 'Web/Frontend']}]


def sha(targets):
    return hashlib.sha256('\n'.join(sorted(targets, key=lambda s: s.encode())).encode()).hexdigest()


def load_helper_module():
    spec = importlib.util.spec_from_file_location('zabbix_api_helper', HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def saml_config(**overrides):
    config = {
        'enabled': True,
        'idp_entityid': 'https://sso.example.com/saml/metadata',
        'sso_url': 'https://sso.example.com/saml/sso',
        'slo_url': '',
        'sp_entityid': 'zabbix',
        'nameid_format': PERSISTENT,
        'username_attribute': 'username',
        'case_sensitive': True,
        'sign': {'messages': True, 'assertions': True, 'authn_requests': False, 'logout_requests': False,
                 'logout_responses': False},
        'jit': {'enabled': True, 'deprovisioned_group': 'SAML deprovisioned',
                'groups': [{'saml_group': 'admin', 'role': 'SSO admin', 'user_groups': ['SSO admins']},
                           {'saml_group': 'operator', 'role': 'SSO user', 'user_groups': ['SSO operators']},
                           {'saml_group': 'viewer', 'role': 'SSO user', 'user_groups': ['SSO viewers']}]},
        'autologout': '1h',
        'allow_legacy_users': False,
        'local_users': {'mode': '', 'targets': [], 'expected_sha256': ''},
    }
    config.update(overrides)
    return config


class FakeSaml(FakeZabbix):
    """Adds the objects behind the SAML helper. Filters are exact unless ``case_insensitive``."""

    HANDLED = {
        'usermacro.get', 'usermacro.createglobal', 'usergroup.get', 'usergroup.create', 'role.get',
        'mediatype.get', 'user.get', 'user.create', 'user.update', 'user.delete', 'token.get', 'token.delete',
        'token.create', 'token.generate', 'userdirectory.get', 'userdirectory.create', 'userdirectory.update',
        'authentication.get', 'authentication.update', 'map.get', 'map.update', 'dashboard.get',
        'dashboard.update', 'report.get', 'action.get', 'hostgroup.get', 'usergroup.update',
    }

    def __init__(self, version='7.0.32', password=NEW, api_token=None):
        super().__init__(version, password=password)
        self.case_insensitive = False
        self.next_id = 100
        self.api_tokens = {}
        self.secret_values = []
        self.fail_methods = {}
        # The default roles allow the API; roles mapped through SAML must not (api.access and
        # manage_api_tokens disabled), like the SSO roles below.
        no_api = {'api.access': '0', 'actions': [{'name': 'manage_api_tokens', 'status': '0'}],
                  'actions.default_access': '1'}
        api = {'api.access': '1', 'actions': [], 'actions.default_access': '1'}
        self.roles = {'1': {'roleid': '1', 'name': 'User role', 'type': '1', 'rules': api},
                      '2': {'roleid': '2', 'name': 'Admin role', 'type': '2', 'rules': api},
                      '3': {'roleid': '3', 'name': 'Super admin role', 'type': '3', 'rules': api},
                      '4': {'roleid': '4', 'name': 'Guest role', 'type': '1', 'rules': api},
                      '5': {'roleid': '5', 'name': 'SSO user', 'type': '1', 'rules': no_api},
                      '6': {'roleid': '6', 'name': 'SSO admin', 'type': '2', 'rules': copy.deepcopy(no_api)}}
        self.groups = {'7': {'usrgrpid': '7', 'name': 'Zabbix administrators', 'gui_access': '0', 'users_status': '0'},
                       '11': {'usrgrpid': '11', 'name': 'SSO admins', 'gui_access': '0', 'users_status': '0'},
                       '12': {'usrgrpid': '12', 'name': 'SSO operators', 'gui_access': '0', 'users_status': '0'},
                       '13': {'usrgrpid': '13', 'name': 'SSO viewers', 'gui_access': '0', 'users_status': '0'}}
        self.users = {'1': {'userid': '1', 'username': 'Admin', 'roleid': '3', 'userdirectoryid': '0',
                            'autologout': '15m', 'usrgrps': ['7']}}
        for group in self.groups.values():
            group['hostgroup_rights'] = []
        self.hostgroups = {'2': 'Linux servers', '4': 'Web/Frontend', '5': 'Databases'}
        self.mediatypes = {'1': {'mediatypeid': '1', 'name': 'Email'}}
        self.macros = []
        self.tokens_api = {}
        self.directories = []
        self.auth = {'saml_auth_enabled': '0', 'saml_case_sensitive': '0', 'saml_jit_status': '0',
                     'disabled_usrgrpid': '0'}
        self.maps, self.dashboards, self.reports, self.actions = [], [], [], []
        if api_token:
            self.add_service_user(api_token)

    # --- fixtures -------------------------------------------------------------------------

    def new_id(self):
        self.next_id += 1
        return str(self.next_id)

    def add_group(self, name, gui_access='0', users_status='0'):
        groupid = self.new_id()
        self.groups[groupid] = {'usrgrpid': groupid, 'name': name, 'gui_access': gui_access,
                                'users_status': users_status, 'hostgroup_rights': []}
        return groupid

    def rights_of(self, name):
        group = next(g for g in self.groups.values() if g['name'] == name)
        return sorted((r['id'], r['permission']) for r in group['hostgroup_rights'])

    def add_user(self, username, userdirectoryid='0', autologout='15m', groups=('11',), roleid='1'):
        userid = self.new_id()
        self.users[userid] = {'userid': userid, 'username': username, 'roleid': roleid,
                              'userdirectoryid': userdirectoryid, 'autologout': autologout, 'usrgrps': list(groups)}
        return userid

    def add_service_user(self, api_token):
        groupid = self.add_group(SERVICE_GROUP, gui_access='3')
        userid = self.add_user(SERVICE, roleid='3', groups=[groupid])
        self.api_tokens[api_token] = userid
        self.tokens.add(api_token)
        self.macros.append({'globalmacroid': self.new_id(), 'macro': SERVICE_MARKER, 'value': SERVICE})
        return userid

    def username_of(self, userid):
        return self.users[userid]['username']

    def marker(self, macro):
        values = [m['value'] for m in self.macros if m['macro'] == macro]
        return values[0] if values else None

    # --- JSON-RPC ---------------------------------------------------------------------------

    def matches(self, actual, wanted):
        wanted = wanted if isinstance(wanted, list) else [wanted]
        if self.case_insensitive:
            return str(actual).lower() in [str(w).lower() for w in wanted]
        return str(actual) in [str(w) for w in wanted]

    def handle(self, body, headers):
        method = body.get('method')
        if method not in self.HANDLED:
            return super().handle(body, headers)
        params = body.get('params')
        header = headers.get('Authorization')
        self.calls.append({'method': method, 'params': params, 'auth': body.get('auth'),
                           'authorization': header, 'host': headers.get('Host'),
                           'content_type': headers.get('Content-Type')})
        token = header[len('Bearer '):] if header and header.startswith('Bearer ') else body.get('auth')
        if token not in self.tokens:
            return {'error': {'code': -32602, 'message': 'Invalid params.', 'data': 'Not authorized.'}}
        if method in self.fail_methods:
            # Fail exactly the n-th call of the method, once.
            self.fail_methods[method] -= 1
            if self.fail_methods[method] == 0:
                del self.fail_methods[method]
                return {'error': {'code': -32500, 'message': 'Application error.', 'data': 'Injected failure.'}}
        try:
            return {'result': getattr(self, 'm_' + method.replace('.', '_'))(params, token)}
        except ValueError as error:
            return {'error': {'code': -32602, 'message': 'Invalid params.', 'data': str(error)}}

    def m_usermacro_get(self, params, token):
        return [dict(m) for m in self.macros if self.matches(m['macro'], params['filter']['macro'])]

    def m_usermacro_createglobal(self, params, token):
        if any(m['macro'] == params['macro'] for m in self.macros):
            raise ValueError('Macro already exists.')
        macroid = self.new_id()
        self.macros.append({'globalmacroid': macroid, 'macro': params['macro'], 'value': params['value']})
        return {'globalmacroids': [macroid]}

    def m_usergroup_get(self, params, token):
        rows = list(self.groups.values())
        if 'filter' in params:
            rows = [g for g in rows if self.matches(g['name'], params['filter']['name'])]
        out = []
        for group in rows:
            row = {k: v for k, v in group.items() if k != 'hostgroup_rights'}
            if 'selectHostGroupRights' in params:
                row['hostgroup_rights'] = copy.deepcopy(group['hostgroup_rights'])
            out.append(row)
        return out[:params.get('limit', len(out))]

    def stored_rights(self, params):
        if 'templategroup_rights' in params:
            raise ValueError('Template group rights must never be sent in these tests.')
        rights = []
        for right in params.get('hostgroup_rights', []):
            if str(right['id']) not in self.hostgroups or right['permission'] not in (0, 2, 3):
                raise ValueError('Invalid parameter "/1/hostgroup_rights".')
            rights.append({'id': str(right['id']), 'permission': str(right['permission'])})
        return rights

    def m_usergroup_create(self, params, token):
        if any(self.matches(g['name'], params['name']) for g in self.groups.values()):
            raise ValueError('User group "%s" already exists.' % params['name'])
        rights = self.stored_rights(params)
        groupid = self.add_group(params['name'], str(params.get('gui_access', 0)),
                                 str(params.get('users_status', 0)))
        self.groups[groupid]['hostgroup_rights'] = rights
        return {'usrgrpids': [groupid]}

    def m_usergroup_update(self, params, token):
        if set(params) - {'usrgrpid', 'hostgroup_rights'}:
            raise ValueError('Only hostgroup_rights is updated in these tests.')
        self.groups[params['usrgrpid']]['hostgroup_rights'] = self.stored_rights(params)
        return {'usrgrpids': [params['usrgrpid']]}

    def m_hostgroup_get(self, params, token):
        return [{'groupid': groupid, 'name': name} for groupid, name in self.hostgroups.items()]

    def m_role_get(self, params, token):
        rows = [copy.deepcopy(r) for r in self.roles.values() if self.matches(r['name'], params['filter']['name'])]
        for row in rows:
            if 'selectRules' not in params:
                del row['rules']
        return rows

    def m_mediatype_get(self, params, token):
        return [dict(m) for m in self.mediatypes.values() if self.matches(m['name'], params['filter']['name'])]

    def m_user_get(self, params, token):
        rows = list(self.users.values())
        flt = params.get('filter', {})
        if 'username' in flt:
            rows = [u for u in rows if self.matches(u['username'], flt['username'])]
        if 'userdirectoryid' in flt:
            rows = [u for u in rows if u['userdirectoryid'] == str(flt['userdirectoryid'])]
        if 'search' in params:
            rows = [u for u in rows if params['search']['username'].lower() in u['username'].lower()]
        out = []
        for user in rows:
            row = {k: v for k, v in user.items() if k != 'usrgrps'}
            if 'selectUsrgrps' in params:
                row['usrgrps'] = [{'usrgrpid': g} for g in user['usrgrps']]
            out.append(row)
        return out

    def m_user_create(self, params, token):
        if 'passwd' in params:
            raise ValueError('Unexpected passwd in this test.')
        groups = [g['usrgrpid'] for g in params['usrgrps']]
        if any(self.groups[g]['gui_access'] != '3' for g in groups):
            raise ValueError('User "%s" must have a password, because internal authentication is in effect.'
                             % params['username'])
        return {'userids': [self.add_user(params['username'], roleid=params['roleid'], groups=groups)]}

    def m_user_update(self, params, token):
        if token not in self.api_tokens:
            # Admin's own session: the password state machine of FakeZabbix.
            raise ValueError('Session users must not update users in these tests.')
        user = self.users[params['userid']]
        if user['userdirectoryid'] != '0' and ({'passwd', 'usrgrps', 'roleid', 'username'} & set(params)):
            raise ValueError('Cannot update readonly parameter of provisioned user.')
        if 'passwd' in params:
            self.secret_values.append(params['passwd'])
            user['passwd'] = params['passwd']
            if user['username'] == 'Admin':
                self.password = params['passwd']
        if 'usrgrps' in params:
            user['usrgrps'] = [g['usrgrpid'] for g in params['usrgrps']]
        if 'autologout' in params:
            seconds = load_helper_module().autologout_seconds(params['autologout'])
            if not (seconds == 0 or 90 <= seconds <= 86400):
                raise ValueError('Invalid parameter "/1/autologout".')
            user['autologout'] = params['autologout']
        return {'userids': [params['userid']]}

    def m_user_delete(self, params, token):
        for userid in params:
            name = self.username_of(userid)
            if any(op == userid for a in self.actions for op in a['recipients']):
                raise ValueError('User "%s" is used in "x" action.' % name)
            if any(m['userid'] == userid for m in self.maps):
                raise ValueError('User "%s" is map "x" owner.' % name)
            if any(d['userid'] == userid for d in self.dashboards):
                raise ValueError('User "%s" is dashboard "x" owner.' % name)
            if any(r['userid'] == userid for r in self.reports):
                raise ValueError('User "%s" is report "x" owner.' % name)
        for userid in params:
            del self.users[userid]
        return {'userids': params}

    def m_token_get(self, params, token):
        return [{'tokenid': t['tokenid'], 'name': t['name'], 'userid': t['userid']} for t in self.tokens_api.values()
                if t['userid'] in params['userids']
                and ('filter' not in params or self.matches(t['name'], params['filter']['name']))]

    def m_token_delete(self, params, token):
        for tokenid in params:
            value = self.tokens_api.pop(tokenid).get('token')
            self.api_tokens.pop(value, None)
            self.tokens.discard(value)
        return {'tokenids': params}

    def m_token_create(self, params, token):
        tokenid = self.new_id()
        self.tokens_api[tokenid] = {'tokenid': tokenid, 'name': params['name'], 'userid': params['userid']}
        return {'tokenids': [tokenid]}

    def m_token_generate(self, params, token):
        out = []
        for tokenid in params:
            value = os.urandom(32).hex()
            self.tokens_api[tokenid]['token'] = value
            self.api_tokens[value] = self.tokens_api[tokenid]['userid']
            self.tokens.add(value)
            self.secret_values.append(value)
            out.append({'tokenid': tokenid, 'token': value})
        return out

    def m_userdirectory_get(self, params, token):
        return copy.deepcopy([d for d in self.directories if str(d['idp_type']) == str(params['filter']['idp_type'])])

    def check_directory(self, params):
        for key in ('idp_certificate', 'sp_certificate', 'sp_private_key'):
            if key in params:
                # 8.0 with file storage (and 7.0, which has no such field).
                raise ValueError('Invalid parameter "/1": unexpected parameter "%s".' % key)

    def stored_directory(self, params):
        stored = {k: (v if isinstance(v, list) else str(v)) for k, v in params.items()}
        stored['provision_groups'] = copy.deepcopy(params.get('provision_groups', []))
        stored['provision_media'] = [dict(m, userdirectory_mediaid=self.new_id(), active='0', severity='63',
                                          period='1-7,00:00-24:00') for m in params.get('provision_media', [])]
        return stored

    def m_userdirectory_create(self, params, token):
        self.check_directory(params)
        if self.directories:
            raise ValueError('Only one SAML user directory is allowed.')
        directory = self.stored_directory(params)
        directory['userdirectoryid'] = self.new_id()
        self.directories.append(directory)
        return {'userdirectoryids': [directory['userdirectoryid']]}

    def m_userdirectory_update(self, params, token):
        self.check_directory(params)
        directory = self.directories[0]
        update = self.stored_directory(params)
        for key in params:
            directory[key] = update[key]
        return {'userdirectoryids': [directory['userdirectoryid']]}

    def m_authentication_get(self, params, token):
        return dict(self.auth)

    def m_authentication_update(self, params, token):
        if 'disabled_usrgrpid' in params and self.groups[str(params['disabled_usrgrpid'])]['users_status'] != '1':
            raise ValueError('Deprovisioned users group must be disabled.')
        self.auth.update({k: str(v) for k, v in params.items()})
        return list(params)

    def m_map_get(self, params, token):
        return [dict(m) for m in self.maps if m['userid'] in params['userids']]

    def m_map_update(self, params, token):
        next(m for m in self.maps if m['sysmapid'] == params['sysmapid'])['userid'] = params['userid']
        return {'sysmapids': [params['sysmapid']]}

    def m_dashboard_get(self, params, token):
        return [dict(d) for d in self.dashboards if d['userid'] in params['filter']['userid']]

    def m_dashboard_update(self, params, token):
        next(d for d in self.dashboards if d['dashboardid'] == params['dashboardid'])['userid'] = params['userid']
        return {'dashboardids': [params['dashboardid']]}

    def m_report_get(self, params, token):
        return [{'reportid': r['reportid'], 'userid': r['userid'], 'users': r.get('users', []),
                 'user_groups': []} for r in self.reports]

    def m_action_get(self, params, token):
        return [{'actionid': a['actionid'], 'operations': [{'opmessage_usr': [{'userid': u} for u in a['recipients']]}],
                 'recovery_operations': [], 'update_operations': []} for a in self.actions]


class SamlHelperTest(unittest.TestCase):
    def run_helper(self, state, *, saml=None, api_token='', password=NEW, lockdown=False, housekeeping=None,
                   token_path=None, version=None, delete_admin_tokens=False):
        config = {'port': None, 'server_name': SERVER_NAME, 'version': version or state.version[:3],
                  'password': password, 'previous_password': '', 'housekeeping': housekeeping or {},
                  'api_token': api_token, 'admin_lockdown': lockdown, 'admin_lockdown_delete_tokens': delete_admin_tokens,
                  'token_output_path': token_path or os.path.join(self.tmp.name, 'service-user-token'),
                  'saml': saml}
        with Server(state) as server, tempfile.TemporaryDirectory() as directory:
            config['port'] = server.port
            path = os.path.join(directory, 'input.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(config, handle)
            proc = subprocess.run([sys.executable, str(HELPER), path], capture_output=True, text=True, timeout=60)
        output = proc.stdout + proc.stderr
        for secret in [password, api_token, *state.issued, *state.secret_values]:
            if secret and secret != 'zabbix':
                self.assertNotIn(secret, output)
                self.assertNotIn(base64.b64encode(secret.encode()).decode(), output)
        # User names are never printed (only counts and the literal names this helper owns).
        for user in state.users.values():
            if '@' in user['username']:
                self.assertNotIn(user['username'], output)
        return proc

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def ok(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def failed(self, proc, text):
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn(text, proc.stderr)
        self.assertEqual(proc.stdout, '')

    def writes(self, state):
        reads = ('.get', 'apiinfo.version', 'user.login', 'user.logout')
        return [m for m in state.methods() if not m.endswith(reads) and m not in reads]

    # --- service user bootstrap ------------------------------------------------------

    def test_bootstrap_creates_a_passwordless_api_only_service_user_and_token_once(self):
        for version in ('7.0.32', '8.0.0'):
            with self.subTest(version=version):
                state = FakeSaml(version)
                path = os.path.join(self.tmp.name, 'token-' + version)
                out = self.ok(self.run_helper(state, saml=saml_config(), token_path=path))
                self.assertEqual(out, {'changed': True, 'password_changed': False, 'housekeeping_changed': [],
                                       'service_user_bootstrapped': True})
                user = next(u for u in state.users.values() if u['username'] == SERVICE)
                self.assertNotIn('passwd', user)
                self.assertEqual(user['roleid'], '3')
                group = state.groups[user['usrgrps'][0]]
                self.assertEqual((group['name'], group['gui_access'], group['users_status']), (SERVICE_GROUP, '3', '0'))
                self.assertEqual(len(user['usrgrps']), 1)
                with open(path, encoding='ascii') as handle:
                    value = handle.read().strip()
                self.assertIn(value, state.api_tokens)
                self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
                self.assertEqual(state.marker(SERVICE_MARKER), SERVICE)
                # SAML is not configured in the bootstrap run; Admin sessions are logged out.
                self.assertNotIn('userdirectory.create', state.methods())
                self.assertNotIn('authentication.update', state.methods())
                self.assertEqual(state.methods()[-1], 'user.logout')

    def test_bootstrap_is_refused_once_the_db_marker_exists(self):
        state = FakeSaml()
        self.ok(self.run_helper(state, saml=saml_config()))
        os.unlink(os.path.join(self.tmp.name, 'service-user-token'))
        state.calls.clear()
        proc = self.run_helper(state, saml=saml_config())
        self.failed(proc, 'Set zabbix_web_api_token (bootstrap is done)')
        self.assertEqual(self.writes(state), [])

    def test_bootstrap_refuses_an_existing_token_file_before_any_change(self):
        state = FakeSaml()
        path = os.path.join(self.tmp.name, 'existing')
        with open(path, 'w', encoding='ascii') as handle:
            handle.write('old\n')
        self.failed(self.run_helper(state, saml=saml_config(), token_path=path), 'already exists')
        self.assertEqual(self.writes(state), [])
        self.assertIsNone(state.marker(SERVICE_MARKER))

    def test_interrupted_bootstrap_replaces_the_unreadable_token(self):
        state = FakeSaml()
        state.fail_methods['usermacro.createglobal'] = 1
        self.failed(self.run_helper(state, saml=saml_config()), 'usermacro.createglobal failed')
        self.assertIsNone(state.marker(SERVICE_MARKER))
        first = list(state.tokens_api)
        os.unlink(os.path.join(self.tmp.name, 'service-user-token'))
        self.ok(self.run_helper(state, saml=saml_config()))
        self.assertEqual(len([u for u in state.users.values() if u['username'] == SERVICE]), 1)
        self.assertEqual(len(state.tokens_api), 1)
        self.assertNotEqual(list(state.tokens_api), first)
        self.assertIn('token.delete', state.methods())

    def test_a_failed_token_file_write_leaves_no_partial_file(self):
        helper = load_helper_module()
        state = FakeSaml()
        path = os.path.join(self.tmp.name, 'partial-token')
        original = helper.os.fdopen

        def broken(descriptor, *args, **kwargs):
            os.close(descriptor)
            raise OSError('disk full')

        with Server(state) as server:
            client = helper.Client(server.port, SERVER_NAME, helper.Redactor())
            helper.check_version(client, '7.0')
            session = client.login(NEW)
            helper.os.fdopen = broken
            try:
                with self.assertRaises(helper.HelperError) as raised:
                    helper.bootstrap_service_user(client, session, path, client.redact)
            finally:
                helper.os.fdopen = original
        self.assertIn('OSError', str(raised.exception))
        self.assertFalse(os.path.exists(path))
        self.assertIsNone(state.marker(SERVICE_MARKER))

    def test_bootstrap_refuses_a_service_user_with_other_groups(self):
        state = FakeSaml()
        state.add_user(SERVICE, roleid='3', groups=['7'])
        self.failed(self.run_helper(state, saml=saml_config()), 'exists with another role or other groups')
        self.assertEqual([m for m in self.writes(state) if m != 'usergroup.create'], [])

    def test_bootstrap_refuses_a_service_group_with_frontend_access(self):
        state = FakeSaml()
        state.add_group(SERVICE_GROUP, gui_access='0')
        self.failed(self.run_helper(state, saml=saml_config()), 'must have frontend access disabled')
        self.assertEqual(self.writes(state), [])

    # --- API token mode ---------------------------------------------------------------

    def test_token_mode_never_logs_in_and_uses_bearer(self):
        state = FakeSaml(api_token=API_TOKEN)
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', housekeeping={'hk_audit': '30d'}))
        self.assertEqual(out, {'changed': True, 'password_changed': False, 'housekeeping_changed': ['hk_audit']})
        self.assertNotIn('user.login', state.methods())
        self.assertNotIn('user.logout', state.methods())
        for call in state.calls[1:]:
            self.assertEqual(call['authorization'], 'Bearer ' + API_TOKEN)

    def test_token_mode_ignores_a_stale_admin_password(self):
        state = FakeSaml(password='zabbix', api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password=NEW))
        self.assertEqual(state.password, 'zabbix')
        self.assertNotIn('user.login', state.methods())

    def test_rejected_token_fails_clearly(self):
        state = FakeSaml()
        self.failed(self.run_helper(state, api_token='b' * 64, password=''), 'zabbix_web_api_token was rejected')

    def test_invalid_token_and_lockdown_input_is_rejected_before_any_request(self):
        for label, kwargs, text in (
                ('uppercase token', {'api_token': 'A' * 64}, 'zabbix_web_api_token'),
                ('short token', {'api_token': 'a' * 63}, 'zabbix_web_api_token'),
                ('empty password without token', {'password': ''}, 'zabbix_web_admin_password'),
                ('lockdown without token', {'lockdown': True}, 'requires zabbix_web_api_token')):
            with self.subTest(label):
                state = FakeSaml()
                self.failed(self.run_helper(state, **kwargs), text)
                self.assertEqual(state.calls, [])

    # --- SAML convergence -------------------------------------------------------------

    def test_saml_is_created_with_nameid_and_without_certificates_then_idempotent(self):
        for version in ('7.0.32', '8.0.0'):
            with self.subTest(version=version):
                state = FakeSaml(version, api_token=API_TOKEN)
                out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
                self.assertEqual(out['saml_changed'], ['userdirectory', 'authentication'])
                self.assertTrue(out['changed'])
                created = state.params_of('userdirectory.create')[0]
                self.assertEqual(created['nameid_format'], PERSISTENT)
                self.assertEqual(created['idp_type'], 2)
                for key in ('idp_certificate', 'sp_certificate', 'sp_private_key'):
                    self.assertNotIn(key, created)
                self.assertEqual((created['sign_messages'], created['sign_assertions'], created['sign_authn_requests']),
                                 (1, 1, 0))
                self.assertEqual(created['provision_groups'], [
                    {'name': 'admin', 'roleid': '6', 'user_groups': [{'usrgrpid': '11'}]},
                    {'name': 'operator', 'roleid': '5', 'user_groups': [{'usrgrpid': '12'}]},
                    {'name': 'viewer', 'roleid': '5', 'user_groups': [{'usrgrpid': '13'}]}])
                disabled = next(g for g in state.groups.values() if g['name'] == 'SAML deprovisioned')
                self.assertEqual(disabled['users_status'], '1')
                self.assertEqual(state.auth, {'saml_auth_enabled': '1', 'saml_case_sensitive': '1',
                                              'saml_jit_status': '1', 'disabled_usrgrpid': disabled['usrgrpid']})
                state.calls.clear()
                again = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
                self.assertEqual(again, {'changed': False, 'password_changed': False, 'housekeeping_changed': [],
                                         'saml_changed': [], 'autologout_updated': 0})
                self.assertEqual(self.writes(state), [])

    def test_only_differences_are_updated_and_group_order_is_ignored(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        state.calls.clear()
        config = saml_config(sso_url='https://sso.example.com/saml/sso2')
        config['jit']['groups'].reverse()
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=config))
        self.assertEqual(out['saml_changed'], ['userdirectory'])
        update = state.params_of('userdirectory.update')
        self.assertEqual(len(update), 1)
        self.assertEqual(set(update[0]), {'userdirectoryid', 'sso_url'})

    def test_nameid_format_drift_is_corrected(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        state.directories[0]['nameid_format'] = ''
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        self.assertEqual(state.params_of('userdirectory.update')[-1]['nameid_format'], PERSISTENT)

    def test_super_admin_roles_are_never_mapped(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.roles['9'] = {'roleid': '9', 'name': 'Custom root', 'type': '3'}
        config = saml_config()
        config['jit']['groups'][0]['role'] = 'Custom root'
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config), 'Super admin')
        self.assertEqual(self.writes(state), [])
        config['jit']['groups'][0]['role'] = 'Super admin role'
        state.calls.clear()
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config), 'never granted')
        self.assertEqual(state.calls, [])

    def test_missing_roles_groups_and_enabled_deprovisioned_group_fail_without_writes(self):
        cases = []
        config = saml_config()
        config['jit']['groups'][0]['role'] = 'No such role'
        cases.append((config, 'User role(s) not found', None))
        config = saml_config()
        config['jit']['groups'][1]['user_groups'] = ['No such group']
        cases.append((config, 'User group(s) not found', None))
        cases.append((saml_config(), 'exists but is enabled', 'SAML deprovisioned'))
        for config, text, enabled_group in cases:
            with self.subTest(text):
                state = FakeSaml(api_token=API_TOKEN)
                if enabled_group:
                    state.add_group(enabled_group)
                self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config), text)
                self.assertEqual(self.writes(state), [])

    def test_manual_users_with_email_names_block_enabling_saml(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.add_user('alice@example.com')
        proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config())
        self.failed(proc, '1 non-SAML user(s)')
        self.assertIn('SAML login stays disabled', proc.stderr)
        self.assertEqual(state.auth['saml_auth_enabled'], '0')
        self.assertNotIn('authentication.update', state.methods())
        # The validation-period exception.
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='',
                                saml=saml_config(allow_legacy_users=True)))
        self.assertEqual(state.auth['saml_auth_enabled'], '1')

    def test_legacy_users_fail_closed_when_saml_is_already_enabled(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.add_user('alice@example.com')
        # Enabled during the validation period with allow_legacy_users.
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config(allow_legacy_users=True)))
        self.assertEqual(state.auth['saml_auth_enabled'], '1')
        state.calls.clear()
        proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config())
        self.failed(proc, 'SAML login was enabled and has been disabled now')
        self.assertEqual(state.auth['saml_auth_enabled'], '0')
        self.assertEqual(state.params_of('authentication.update'), [{'saml_auth_enabled': 0}])

    def test_users_of_other_directories_with_email_names_block(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.add_user('ldap.user@example.com', userdirectoryid='77')  # e.g. an LDAP user directory
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()), '1 non-SAML user(s)')

    def test_roles_that_allow_api_tokens_are_never_mapped(self):
        for label, rules in (
                ('default role with API access', None),
                ('manage_api_tokens allowed', {'api.access': '0', 'actions': [{'name': 'manage_api_tokens', 'status': '1'}],
                                               'actions.default_access': '0'}),
                ('manage_api_tokens by default access', {'api.access': '0', 'actions': [], 'actions.default_access': '1'})):
            with self.subTest(label):
                state = FakeSaml(api_token=API_TOKEN)
                config = saml_config()
                if rules is None:
                    config['jit']['groups'][1]['role'] = 'User role'
                else:
                    state.roles['6']['rules'] = rules
                self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config),
                            'allows API access or managing API tokens')
                self.assertEqual(self.writes(state), [])

    def test_saml_prerequisites_are_checked_before_users_are_deleted(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        config = self.local(['alice@example.com', 'bob@example.com'])
        config['jit']['groups'][0]['role'] = 'No such role'
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config), 'User role(s) not found')
        self.assertEqual(self.writes(state), [])
        self.assertEqual(len([u for u in state.users.values() if '@' in u['username']]), 2)

    def test_scramble_deletes_the_targets_api_tokens(self):
        state = FakeSaml(api_token=API_TOKEN)
        alice, bob = self.people(state)
        state.tokens_api['910'] = {'tokenid': '910', 'name': 'script', 'userid': alice, 'token': 'f' * 64}
        state.tokens_api['911'] = {'tokenid': '911', 'name': 'keep', 'userid': '1', 'token': '9' * 64}
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='',
                                      saml=self.local(['alice@example.com', 'bob@example.com'], mode='scramble')
                                      | {'allow_legacy_users': True}))
        self.assertEqual(out['local_users']['tokens_deleted'], 1)
        self.assertEqual(list(state.tokens_api), ['911'])
        methods = state.methods()
        self.assertLess(methods.index('token.delete'), methods.index('user.update'))

    def test_signature_of_messages_or_assertions_is_required(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='',
                                    saml=saml_config(sign={'messages': False, 'assertions': False})),
                    'needs messages or assertions')
        self.assertEqual(state.calls, [])
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config(sign={'messages': False})))

    def test_api_errors_do_not_print_email_like_user_names(self):
        helper = load_helper_module()
        client = helper.Client(1, 'x', helper.Redactor())
        text = client.describe({'message': 'Invalid params.', 'data': 'User "alice@example.com" is map "m" owner.'})
        self.assertNotIn('alice@example.com', text)
        self.assertIn('is map "m" owner', text)

    def test_jit_users_with_email_names_do_not_block(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        state.add_user('bob@example.com', userdirectoryid=state.directories[0]['userdirectoryid'])
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))

    def test_version_floor_is_checked_before_any_login(self):
        for version, accepted in (('7.0.31', False), ('7.0.32', True), ('7.0.40', True), ('8.0.0', True)):
            with self.subTest(version=version):
                state = FakeSaml(version, api_token=API_TOKEN)
                proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config())
                if accepted:
                    self.ok(proc)
                else:
                    self.failed(proc, 'SAML requires Zabbix 7.0.32 or newer')
                    self.assertEqual(state.methods(), ['apiinfo.version'])
        state = FakeSaml('6.0.30')
        self.failed(self.run_helper(state, saml=saml_config()), 'SAML requires zabbix_web_version 7.0 or 8.0')
        self.assertEqual(state.calls, [])

    def test_autologout_converges_for_jit_users_only(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        directory = state.directories[0]['userdirectoryid']
        jit = state.add_user('carol@example.com', userdirectoryid=directory, autologout='15m')
        same = state.add_user('dave@example.com', userdirectoryid=directory, autologout='60m')
        manual = state.add_user('breakglass-20261110', autologout='15m')
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        self.assertEqual(out['autologout_updated'], 1)
        self.assertEqual(state.users[jit]['autologout'], '1h')
        self.assertEqual(state.users[same]['autologout'], '60m')
        self.assertEqual(state.users[manual]['autologout'], '15m')
        again = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        self.assertEqual(again['autologout_updated'], 0)
        self.assertFalse(again['changed'])

    def test_disabling_saml_only_switches_authentication_off(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        state.calls.clear()
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml={'enabled': False}))
        self.assertEqual(out['saml_changed'], ['authentication'])
        self.assertEqual(state.params_of('authentication.update'), [{'saml_auth_enabled': 0}])
        self.assertEqual(len(state.directories), 1)
        state.calls.clear()
        again = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml={'enabled': False}))
        self.assertFalse(again['changed'])
        self.assertNotIn('authentication.update', state.methods())

    def test_invalid_saml_input_is_rejected_before_any_request(self):
        jit_star = saml_config()
        jit_star['jit']['groups'][0]['saml_group'] = 'adm*'
        jit_no_disabled = saml_config()
        del jit_no_disabled['jit']['deprovisioned_group']
        cases = {
            'http sso url': saml_config(sso_url='http://sso.example.com/saml/sso'),
            'entityid not url or urn': saml_config(idp_entityid='sso.example.com'),
            'sp entityid with space': saml_config(sp_entityid='zab bix'),
            'transient nameid': saml_config(nameid_format='urn:oasis:names:tc:SAML:2.0:nameid-format:transient'),
            'empty nameid': saml_config(nameid_format=''),
            'attribute': saml_config(username_attribute='1user'),
            'sign key': saml_config(sign={'everything': True}),
            'sign value': saml_config(sign={'messages': 'yes'}),
            'autologout too short': saml_config(autologout='30s'),
            'autologout too long': saml_config(autologout='2d'),
            'autologout zero': saml_config(autologout='0'),
            'saml group wildcard': jit_star,
            'no deprovisioned group': jit_no_disabled,
            'case sensitive string': saml_config(case_sensitive='true'),
        }
        for label, config in cases.items():
            with self.subTest(label):
                state = FakeSaml(api_token=API_TOKEN)
                proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=config)
                self.assertEqual(proc.returncode, 2, label)
                self.assertEqual(state.calls, [])

    # --- one-time local user procedure ----------------------------------------------

    def local(self, targets, mode='delete', **extra):
        return saml_config(local_users=dict({'mode': mode, 'targets': targets, 'expected_sha256': sha(targets)},
                                            **extra))

    def people(self, state):
        return [state.add_user('alice@example.com'), state.add_user('bob@example.com')]

    def test_delete_runs_before_enabling_saml_and_records_the_db_marker(self):
        state = FakeSaml(api_token=API_TOKEN)
        alice, bob = self.people(state)
        keep = state.add_user('carol@example.com')
        targets = ['alice@example.com', 'bob@example.com']
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.local(
            targets, mode='delete') | {'allow_legacy_users': True}))
        self.assertEqual(out['local_users'], {'deleted': 2, 'scrambled': 0, 'moved_maps_dashboards': 0})
        self.assertEqual(out['local_users_marker'], '%s:delete' % sha(targets))
        self.assertNotIn(alice, state.users)
        self.assertNotIn(bob, state.users)
        self.assertIn(keep, state.users)
        self.assertTrue(any(u['username'] == SERVICE for u in state.users.values()))
        methods = state.methods()
        self.assertLess(methods.index('user.delete'), methods.index('authentication.update'))
        self.assertEqual(state.params_of('user.delete'), [[alice, bob]])
        self.assertEqual(state.marker(LOCAL_MARKER), '%s:delete' % sha(targets))

    def test_completed_procedure_changes_nothing_even_for_new_jit_users_with_the_same_name(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        config = self.local(['alice@example.com', 'bob@example.com'])
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=config))
        # JIT recreates alice; the host marker file is not used, the DB marker decides.
        state.add_user('alice@example.com', userdirectoryid=state.directories[0]['userdirectoryid'])
        state.calls.clear()
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=config))
        self.assertEqual(out['local_users'], {'deleted': 0, 'scrambled': 0})
        self.assertNotIn('user.delete', state.methods())
        self.assertEqual([p['filter'].get('username') for p in state.params_of('user.get')
                          if 'username' in p.get('filter', {})], [])
        self.assertTrue(any(u['username'] == 'alice@example.com' for u in state.users.values()))

    def test_delete_with_no_user_left_records_the_marker_without_changes(self):
        state = FakeSaml(api_token=API_TOKEN)
        targets = ['gone@example.com']
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.local(targets)))
        self.assertEqual(out['local_users'], {'deleted': 0, 'scrambled': 0})
        self.assertNotIn('user.delete', state.methods())
        self.assertEqual(state.marker(LOCAL_MARKER), '%s:delete' % sha(targets))

    def test_a_different_marker_fails_without_changes(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        state.macros.append({'globalmacroid': '900', 'macro': LOCAL_MARKER, 'value': '0' * 64 + ':delete'})
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.local(['alice@example.com'])),
                    'records another local user procedure')
        self.assertEqual(self.writes(state), [])

    def test_input_errors_fail_before_any_request(self):
        targets = ['alice@example.com', 'bob@example.com']
        cases = {
            'hash mismatch': dict(self.local(targets)['local_users'], expected_sha256='0' * 64),
            'hash with trailing newline': dict(self.local(targets)['local_users'],
                                               expected_sha256=hashlib.sha256(
                                                   ('\n'.join(sorted(targets)) + '\n').encode()).hexdigest()),
            'duplicates': {'mode': 'delete', 'targets': targets + ['bob@example.com'],
                           'expected_sha256': sha(targets + ['bob@example.com'])},
            'Admin': {'mode': 'delete', 'targets': ['Admin'], 'expected_sha256': sha(['Admin'])},
            'admin lowercase': {'mode': 'delete', 'targets': ['admin'], 'expected_sha256': sha(['admin'])},
            'service user': {'mode': 'scramble', 'targets': [SERVICE], 'expected_sha256': sha([SERVICE])},
            'space': {'mode': 'delete', 'targets': ['a b'], 'expected_sha256': sha(['a b'])},
            'unknown mode': {'mode': 'disable', 'targets': targets, 'expected_sha256': sha(targets)},
            'empty targets': {'mode': 'delete', 'targets': [], 'expected_sha256': sha([])},
        }
        for label, local_users in cases.items():
            with self.subTest(label):
                state = FakeSaml(api_token=API_TOKEN)
                self.people(state)
                proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config(local_users=local_users))
                self.assertEqual(proc.returncode, 2, label)
                self.assertEqual(state.calls, [])

    def test_found_names_must_match_targets_case_sensitively(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.case_insensitive = True  # a MySQL collation
        state.add_user('Alice@example.com')
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.local(['alice@example.com'])),
                    'Found 0 of 1 target users')
        self.assertEqual(self.writes(state), [])
        self.assertIsNone(state.marker(LOCAL_MARKER))

    def test_partial_match_fails_without_changes(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.add_user('alice@example.com')
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='',
                                    saml=self.local(['alice@example.com', 'bob@example.com'])), 'Found 1 of 2')
        self.assertEqual(self.writes(state), [])

    def test_scramble_sets_unprinted_random_passwords(self):
        state = FakeSaml(api_token=API_TOKEN)
        alice, bob = self.people(state)
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='',
                                      saml=self.local(['alice@example.com', 'bob@example.com'], mode='scramble')
                                      | {'allow_legacy_users': True}))
        self.assertEqual(out['local_users'], {'deleted': 0, 'scrambled': 2, 'tokens_deleted': 0})
        self.assertEqual(len({state.users[alice]['passwd'], state.users[bob]['passwd']}), 2)
        self.assertGreaterEqual(len(state.users[alice]['passwd']), 64)
        self.assertEqual(state.marker(LOCAL_MARKER).split(':')[1], 'scramble')

    def test_scramble_failure_reports_progress_and_creates_no_marker(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        state.fail_methods['user.update'] = 2
        proc = self.run_helper(state, api_token=API_TOKEN, password='',
                               saml=self.local(['alice@example.com', 'bob@example.com'], mode='scramble'))
        self.failed(proc, '1 of 2 users were scrambled')
        self.assertIsNone(state.marker(LOCAL_MARKER))

    def test_owned_maps_and_dashboards_block_unless_moved_to_the_service_user(self):
        state = FakeSaml(api_token=API_TOKEN)
        alice, bob = self.people(state)
        state.maps.append({'sysmapid': '50', 'userid': alice})
        state.dashboards.append({'dashboardid': '60', 'userid': bob})
        targets = ['alice@example.com', 'bob@example.com']
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.local(targets)),
                    'own 1 map(s) and 1 dashboard(s)')
        self.assertEqual(self.writes(state), [])
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='',
                                      saml=self.local(targets, transfer_maps_dashboards=True)))
        self.assertEqual(out['local_users']['moved_maps_dashboards'], 2)
        service = next(u['userid'] for u in state.users.values() if u['username'] == SERVICE)
        self.assertEqual(state.maps[0]['userid'], service)
        self.assertEqual(state.dashboards[0]['userid'], service)
        self.assertNotIn(alice, state.users)

    def test_reports_and_action_recipients_are_never_moved_to_the_service_user(self):
        for kind in ('report', 'action', 'report recipient'):
            with self.subTest(kind):
                state = FakeSaml(api_token=API_TOKEN)
                alice, _ = self.people(state)
                if kind == 'report':
                    state.reports.append({'reportid': '70', 'userid': alice})
                elif kind == 'report recipient':
                    state.reports.append({'reportid': '70', 'userid': '1',
                                          'users': [{'userid': alice, 'access_userid': '0'}]})
                else:
                    state.actions.append({'actionid': '80', 'recipients': [alice]})
                proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=self.local(
                    ['alice@example.com', 'bob@example.com'], transfer_maps_dashboards=True))
                self.failed(proc, 'scheduled report(s)')
                self.assertEqual(self.writes(state), [])

    def test_hash_vector_matches_the_documented_command(self):
        helper = load_helper_module()
        names = ['b@example.com', 'B@example.com', 'a@example.com', 'Z-user']
        expected = hashlib.sha256(b'B@example.com\nZ-user\na@example.com\nb@example.com').hexdigest()
        self.assertEqual(helper.targets_sha256(names), expected)
        documented = ('import hashlib,sys; print(hashlib.sha256("\\n".join(sorted(sys.argv[1:], '
                      'key=lambda s: s.encode())).encode()).hexdigest())')
        proc = subprocess.run([sys.executable, '-c', documented, *names], capture_output=True, text=True, check=True)
        self.assertEqual(proc.stdout.strip(), expected)

    # --- managed user groups ----------------------------------------------------------

    def grouped(self, user_groups=None, **overrides):
        """SAML input with managed user groups; the JIT operator maps to the group created by the helper."""
        config = saml_config(user_groups=USER_GROUPS if user_groups is None else user_groups, **overrides)
        config['jit']['groups'][1]['user_groups'] = ['SSO responders']
        return config

    def test_user_groups_are_created_and_converged_before_provisioning_then_idempotent(self):
        for version in ('7.0.32', '8.0.0'):
            with self.subTest(version=version):
                state = FakeSaml(version, api_token=API_TOKEN)
                out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))
                self.assertTrue(out['changed'])
                self.assertEqual(out['user_groups_changed'], ['SSO responders', 'SSO viewers'])
                self.assertEqual(state.rights_of('SSO responders'), [('2', '3'), ('4', '3'), ('5', '3')])
                self.assertEqual(state.rights_of('SSO viewers'), [('2', '2'), ('4', '2')])
                self.assertEqual(out['user_groups_diff'], {
                    'SSO responders': {'created': True, 'removed': [], 'changed': [], 'added': [
                        {'hostgroup': 'Databases', 'permission': 'read-write'},
                        {'hostgroup': 'Linux servers', 'permission': 'read-write'},
                        {'hostgroup': 'Web/Frontend', 'permission': 'read-write'}]},
                    'SSO viewers': {'created': False, 'removed': [], 'changed': [], 'added': [
                        {'hostgroup': 'Linux servers', 'permission': 'read'},
                        {'hostgroup': 'Web/Frontend', 'permission': 'read'}]}})
                created = next(g for g in state.groups.values() if g['name'] == 'SSO responders')
                self.assertEqual((created['gui_access'], created['users_status']), ('0', '0'))
                provision = state.directories[0]['provision_groups']
                self.assertEqual(provision[1], {'name': 'operator', 'roleid': '5',
                                                'user_groups': [{'usrgrpid': created['usrgrpid']}]})
                methods = state.methods()
                self.assertLess(methods.index('usergroup.update'), methods.index('userdirectory.create'))
                state.calls.clear()
                again = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))
                self.assertEqual(again, {'changed': False, 'password_changed': False, 'housekeeping_changed': [],
                                         'user_groups_changed': [], 'user_groups_diff': {}, 'saml_changed': [],
                                         'autologout_updated': 0})
                self.assertEqual(self.writes(state), [])

    def test_only_rights_that_differ_are_set_exactly_as_listed_and_reported(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))
        viewers = next(g for g in state.groups.values() if g['name'] == 'SSO viewers')
        viewers['hostgroup_rights'] = [{'id': '2', 'permission': '3'}, {'id': '5', 'permission': '2'}]
        state.calls.clear()
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))
        self.assertEqual(out['user_groups_changed'], ['SSO viewers'])
        self.assertTrue(out['changed'])
        self.assertEqual(out['user_groups_diff'], {'SSO viewers': {
            'created': False,
            'added': [{'hostgroup': 'Web/Frontend', 'permission': 'read'}],
            'removed': [{'hostgroup': 'Databases', 'permission': 'read'}],
            'changed': [{'hostgroup': 'Linux servers', 'before': 'read-write', 'after': 'read'}]}})
        self.assertEqual(state.params_of('usergroup.update'), [
            {'usrgrpid': viewers['usrgrpid'], 'hostgroup_rights': [{'id': '2', 'permission': 2},
                                                                   {'id': '4', 'permission': 2}]}])
        self.assertNotIn('usergroup.create', state.methods())
        self.assertEqual(state.rights_of('SSO viewers'), [('2', '2'), ('4', '2')])

    def test_deny_rights_are_replaced_only_with_replace_denied(self):
        state = FakeSaml(api_token=API_TOKEN)
        viewers = next(g for g in state.groups.values() if g['name'] == 'SSO viewers')
        viewers['hostgroup_rights'] = [{'id': '2', 'permission': '2'}, {'id': '4', 'permission': '0'},
                                       {'id': '5', 'permission': '0'}]
        proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped())
        self.failed(proc, 'User group "SSO viewers" has deny rights on 2 host group(s)')
        self.assertIn('"Databases", "Web/Frontend"', proc.stderr)
        self.assertEqual(self.writes(state), [])
        user_groups = [USER_GROUPS[0], dict(USER_GROUPS[1], replace_denied=True)]
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped(user_groups)))
        self.assertEqual(out['user_groups_diff']['SSO viewers'], {
            'created': False, 'added': [],
            'removed': [{'hostgroup': 'Databases', 'permission': 'deny'}],
            'changed': [{'hostgroup': 'Web/Frontend', 'before': 'deny', 'after': 'read'}]})
        self.assertEqual(state.rights_of('SSO viewers'), [('2', '2'), ('4', '2')])
        # Without deny rights left, replace_denied is no longer needed.
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))

    def test_all_means_every_host_group_at_each_run(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))
        state.hostgroups['17'] = 'Windows servers'
        state.calls.clear()
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))
        self.assertEqual(out['user_groups_changed'], ['SSO responders'])
        self.assertEqual(out['user_groups_diff']['SSO responders']['added'],
                         [{'hostgroup': 'Windows servers', 'permission': 'read-write'}])
        self.assertEqual(state.rights_of('SSO responders'), [('17', '3'), ('2', '3'), ('4', '3'), ('5', '3')])
        self.assertEqual(state.rights_of('SSO viewers'), [('2', '2'), ('4', '2')])

    def test_exclude_hostgroups_leaves_host_groups_out_of_all(self):
        state = FakeSaml(api_token=API_TOKEN)
        user_groups = [dict(USER_GROUPS[0], exclude_hostgroups=['Databases']), USER_GROUPS[1]]
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped(user_groups)))
        self.assertEqual(state.rights_of('SSO responders'), [('2', '3'), ('4', '3')])
        state.hostgroups['17'] = 'Windows servers'
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped(user_groups)))
        self.assertEqual(state.rights_of('SSO responders'), [('17', '3'), ('2', '3'), ('4', '3')])
        state.calls.clear()
        missing = [dict(USER_GROUPS[0], exclude_hostgroups=['Databases', 'No such hosts']), USER_GROUPS[1]]
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped(missing)),
                    'Host group(s) not found: "No such hosts"')
        self.assertEqual(self.writes(state), [])

    def test_unicode_host_group_names_are_accepted(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.hostgroups['30'] = '監視対象/本番'
        state.hostgroups['31'] = '検証用'
        user_groups = [dict(USER_GROUPS[0], exclude_hostgroups=['検証用']),
                       dict(USER_GROUPS[1], hostgroups=['監視対象/本番'])]
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped(user_groups)))
        self.assertEqual(state.rights_of('SSO responders'), [('2', '3'), ('30', '3'), ('4', '3'), ('5', '3')])
        self.assertEqual(state.rights_of('SSO viewers'), [('30', '2')])
        self.assertEqual(out['user_groups_diff']['SSO viewers']['added'],
                         [{'hostgroup': '監視対象/本番', 'permission': 'read'}])
        self.assertFalse(self.ok(self.run_helper(state, api_token=API_TOKEN, password='',
                                                 saml=self.grouped(user_groups)))['changed'])

    def test_user_groups_converge_without_jit(self):
        state = FakeSaml(api_token=API_TOKEN)
        config = saml_config(jit={'enabled': False}, user_groups=USER_GROUPS)
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=config))
        self.assertEqual(out['user_groups_changed'], ['SSO responders', 'SSO viewers'])
        self.assertEqual((state.directories[0]['provision_status'], state.directories[0]['provision_groups']), ('0', []))
        self.assertEqual(state.auth['saml_jit_status'], '0')
        again = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=config))
        self.assertFalse(again['changed'])

    def test_disabled_or_frontend_disabled_groups_are_not_managed(self):
        for field, value in (('users_status', '1'), ('gui_access', '3')):
            with self.subTest(field=field):
                state = FakeSaml(api_token=API_TOKEN)
                next(g for g in state.groups.values() if g['name'] == 'SSO viewers')[field] = value
                self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()),
                            'is disabled or has frontend access disabled')
                self.assertEqual(self.writes(state), [])

    def test_host_group_names_are_matched_case_sensitively(self):
        state = FakeSaml(api_token=API_TOKEN)
        user_groups = [dict(USER_GROUPS[1], hostgroups=['linux servers'])]
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config(user_groups=user_groups)),
                    'Host group(s) not found: "linux servers"')
        self.assertEqual(self.writes(state), [])

    def test_duplicate_host_group_names_fail_without_writes(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.hostgroups['9'] = 'Linux servers'
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()),
                    'Host group "Linux servers" exists more than once')
        self.assertEqual(self.writes(state), [])

    def test_user_groups_converge_before_the_one_time_procedure(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        targets = ['alice@example.com', 'bob@example.com']
        config = self.grouped(local_users={'mode': 'delete', 'targets': targets, 'expected_sha256': sha(targets)})
        self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=config))
        methods = state.methods()
        self.assertLess(methods.index('usergroup.create'), methods.index('user.delete'))
        self.assertLess(methods.index('usergroup.update'), methods.index('user.delete'))
        # A failed group change stops before the irreversible deletion.
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        state.fail_methods['usergroup.update'] = 1
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config),
                    '1 of 2 user groups were changed')
        self.assertNotIn('user.delete', state.methods())
        self.assertIsNone(state.marker(LOCAL_MARKER))
        self.assertEqual(len([u for u in state.users.values() if '@' in u['username']]), 2)

    def test_without_user_groups_nothing_about_them_is_read_or_reported(self):
        state = FakeSaml(api_token=API_TOKEN)
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config()))
        self.assertNotIn('user_groups_changed', out)
        self.assertNotIn('hostgroup.get', state.methods())
        self.assertNotIn('usergroup.update', state.methods())

    def test_missing_host_groups_fail_before_the_one_time_procedure(self):
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        targets = ['alice@example.com', 'bob@example.com']
        user_groups = [dict(USER_GROUPS[1], hostgroups=['Linux servers', 'No such hosts'])]
        config = saml_config(user_groups=user_groups, local_users={'mode': 'delete', 'targets': targets,
                                                                   'expected_sha256': sha(targets)})
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config),
                    'Host group(s) not found: "No such hosts"')
        self.assertEqual(self.writes(state), [])
        self.assertEqual(len([u for u in state.users.values() if '@' in u['username']]), 2)

    def test_saml_names_are_checked_before_the_one_time_procedure_with_planned_groups(self):
        # A JIT group that is neither listed nor existing still fails before anything changes.
        state = FakeSaml(api_token=API_TOKEN)
        self.people(state)
        targets = ['alice@example.com', 'bob@example.com']
        config = self.grouped(local_users={'mode': 'delete', 'targets': targets, 'expected_sha256': sha(targets)})
        config['jit']['groups'][2]['user_groups'] = ['SSO auditors']
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config),
                    'User group(s) not found: "SSO auditors"')
        self.assertEqual(self.writes(state), [])
        self.assertEqual(len([u for u in state.users.values() if '@' in u['username']]), 2)

    def test_a_listed_name_in_another_letter_case_fails_without_writes(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.case_insensitive = True  # a MySQL collation
        state.add_group('sso responders')
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()),
                    'exists with another letter case')
        self.assertEqual(self.writes(state), [])

    def test_a_failed_group_change_reports_progress_and_the_rerun_resolves_ids(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.fail_methods['usergroup.update'] = 1
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()),
                    '1 of 2 user groups were changed')
        self.assertNotIn('userdirectory.create', state.methods())
        created = next(g for g in state.groups.values() if g['name'] == 'SSO responders')
        state.calls.clear()
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', saml=self.grouped()))
        self.assertEqual(out['user_groups_changed'], ['SSO viewers'])
        self.assertEqual([p['name'] for p in state.params_of('usergroup.create')], ['SAML deprovisioned'])
        self.assertEqual(state.rights_of('SSO viewers'), [('2', '2'), ('4', '2')])
        provision = {row['name']: row['user_groups'] for row in state.directories[0]['provision_groups']}
        self.assertEqual(provision, {'admin': [{'usrgrpid': '11'}], 'operator': [{'usrgrpid': created['usrgrpid']}],
                                     'viewer': [{'usrgrpid': '13'}]})

    def test_invalid_user_groups_are_rejected_before_any_request(self):
        cases = {
            'not a list': 'all',
            'unknown key': [dict(USER_GROUPS[0], users=[])],
            'missing key': [{'name': 'SSO viewers', 'permission': 'read'}],
            'administrators': [dict(USER_GROUPS[0], name='Zabbix administrators')],
            'administrators other case': [dict(USER_GROUPS[0], name='zabbix ADMINISTRATORS')],
            'service group': [dict(USER_GROUPS[0], name=SERVICE_GROUP)],
            'deprovisioned group': [dict(USER_GROUPS[0], name='saml deprovisioned')],
            'duplicate names': [USER_GROUPS[0], dict(USER_GROUPS[1], name='sso RESPONDERS')],
            'long name': [dict(USER_GROUPS[0], name='a' * 65)],
            'permission': [dict(USER_GROUPS[0], permission='write')],
            'numeric permission': [dict(USER_GROUPS[0], permission=3)],
            'list permission': [dict(USER_GROUPS[0], permission=['read'])],
            'hostgroups other word': [dict(USER_GROUPS[0], hostgroups='All')],
            'empty hostgroups': [dict(USER_GROUPS[0], hostgroups=[])],
            'duplicate hostgroups': [dict(USER_GROUPS[0], hostgroups=['Databases', 'Databases'])],
            'hostgroup with space': [dict(USER_GROUPS[0], hostgroups=['Databases '])],
            'hostgroup not a string': [dict(USER_GROUPS[0], hostgroups=[5])],
            'exclude without all': [dict(USER_GROUPS[1], exclude_hostgroups=['Databases'])],
            'exclude not a list': [dict(USER_GROUPS[0], exclude_hostgroups='Databases')],
            'exclude duplicates': [dict(USER_GROUPS[0], exclude_hostgroups=['Databases', 'Databases'])],
            'exclude not a string': [dict(USER_GROUPS[0], exclude_hostgroups=[5])],
            'replace_denied string': [dict(USER_GROUPS[0], replace_denied='yes')],
            'hostgroup too long': [dict(USER_GROUPS[1], hostgroups=['監' * 256])],
            'hostgroup leading space': [dict(USER_GROUPS[1], hostgroups=[' 監視'])],
            'hostgroup trailing ideographic space': [dict(USER_GROUPS[1], hostgroups=['監視' + chr(0x3000)])],
            'hostgroup with a control character': [dict(USER_GROUPS[1], hostgroups=['監' + chr(0x07) + '視'])],
            'hostgroup with a newline': [dict(USER_GROUPS[1], hostgroups=['Linux\nservers'])],
            'hostgroup with a format character': [dict(USER_GROUPS[1], hostgroups=['監' + chr(0x200b) + '視'])],
            'hostgroup with a bidi override': [dict(USER_GROUPS[1], hostgroups=['ab' + chr(0x202e) + 'cd'])],
            'hostgroup with a private use character': [dict(USER_GROUPS[1], hostgroups=['ab' + chr(0xe000)])],
            'hostgroup with an unassigned code point': [dict(USER_GROUPS[1], hostgroups=['ab' + chr(0x0378) + 'cd'])],
            'exclude with a control character': [dict(USER_GROUPS[0], exclude_hostgroups=['ab' + chr(0x1f)])],
            'exclude with trailing space': [dict(USER_GROUPS[0], exclude_hostgroups=['検証用 '])],
            'optional key only': [{'name': 'SSO viewers', 'permission': 'read', 'replace_denied': True}],
            **{'built-in ' + name: [dict(USER_GROUPS[0], name=name)]
               for name in ('GUESTS', 'disabled', 'No access to the Frontend', 'internal', 'Enabled Debug Mode')},
        }
        for label, user_groups in cases.items():
            with self.subTest(label):
                state = FakeSaml(api_token=API_TOKEN)
                proc = self.run_helper(state, api_token=API_TOKEN, password='', saml=saml_config(user_groups=user_groups))
                self.assertEqual(proc.returncode, 2, label)
                self.assertIn('saml user_groups', proc.stderr)
                self.assertEqual(state.calls, [])

    def test_the_deprovisioned_group_is_refused_with_or_without_jit(self):
        for jit in ({'enabled': False, 'deprovisioned_group': 'Old leavers'},
                    dict(saml_config()['jit'], deprovisioned_group='Old leavers')):
            with self.subTest(enabled=jit['enabled']):
                state = FakeSaml(api_token=API_TOKEN)
                config = saml_config(jit=jit, user_groups=[dict(USER_GROUPS[0], name='old LEAVERS')])
                self.failed(self.run_helper(state, api_token=API_TOKEN, password='', saml=config),
                            'must not contain the API-only, deprovisioned or a built-in group')
                self.assertEqual(state.calls, [])

    # --- Admin lockdown -------------------------------------------------------------

    def test_admin_lockdown_adds_the_api_only_group_and_a_random_password_once(self):
        state = FakeSaml(password=NEW, api_token=API_TOKEN)
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', lockdown=True, saml=saml_config()))
        self.assertTrue(out['admin_locked_down'])
        service_group = next(g['usrgrpid'] for g in state.groups.values() if g['name'] == SERVICE_GROUP)
        self.assertEqual(state.users['1']['usrgrps'], ['7', service_group])
        self.assertNotEqual(state.password, NEW)
        state.calls.clear()
        again = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', lockdown=True, saml=saml_config()))
        self.assertFalse(again['admin_locked_down'])
        self.assertFalse(again['changed'])
        self.assertEqual(self.writes(state), [])

    def test_admin_lockdown_requires_the_service_group(self):
        state = FakeSaml(api_token=API_TOKEN)
        state.groups = {k: v for k, v in state.groups.items() if v['name'] != SERVICE_GROUP}
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', lockdown=True, saml=saml_config()), 'does not exist')
        self.assertNotIn('user.update', state.methods())
        self.assertNotIn('token.delete', state.methods())

    def test_admin_lockdown_requires_saml(self):
        state = FakeSaml(api_token=API_TOKEN)
        for saml in (None, {'enabled': False}):
            with self.subTest(saml=saml):
                state.calls.clear()
                self.failed(self.run_helper(state, api_token=API_TOKEN, password='', lockdown=True, saml=saml),
                            'requires zabbix_web_saml_enabled')
                self.assertEqual(state.calls, [])

    def test_admin_tokens_block_the_lockdown_unless_deletion_is_allowed(self):
        state = FakeSaml(password=NEW, api_token=API_TOKEN)
        state.tokens_api['900'] = {'tokenid': '900', 'name': 'old script', 'userid': '1', 'token': 'c' * 64}
        state.tokens_api['901'] = {'tokenid': '901', 'name': 'other', 'userid': '1', 'token': 'd' * 64}
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', lockdown=True, saml=saml_config()),
                    'Admin owns 2 API token(s)')
        self.assertNotIn('user.update', state.methods())
        self.assertEqual(state.password, NEW)
        out = self.ok(self.run_helper(state, api_token=API_TOKEN, password='', lockdown=True, saml=saml_config(),
                                      delete_admin_tokens=True))
        self.assertTrue(out['admin_locked_down'])
        self.assertEqual(state.params_of('token.delete'), [['900', '901']])
        self.assertEqual([t for t in state.tokens_api.values() if t['userid'] == '1'], [])
        # A token created after the lockdown is caught on the next run as well.
        state.tokens_api['902'] = {'tokenid': '902', 'name': 'late', 'userid': '1', 'token': 'e' * 64}
        self.failed(self.run_helper(state, api_token=API_TOKEN, password='', lockdown=True, saml=saml_config()),
                    'Admin owns 1 API token(s)')


if __name__ == '__main__':
    unittest.main()
