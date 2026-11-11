"""Evaluate the zabbix_web SAML / API token validation and rendering with ansible-playbook.

Only the role's Validate assert, the SAML version floor assert and the zabbix.conf.php / certificate
copy tasks are executed (against a temporary directory); no package or service is touched.

Run in an Ansible >=2.20 venv (set ZABBIX_TEST_LEGACY_ANSIBLE to a 2.16 ansible-playbook to also
check the 22.04/24.04 controllers):
  python -m unittest discover -s ansible/tests -p test_zabbix_web_saml_role.py -v
"""
import base64
import copy
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

try:
    import yaml
except ImportError:
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
ROLE = ROOT / 'roles/zabbix_web'
CERT_A = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\nQUJDREVGRw==\n-----END CERTIFICATE-----\n'
CERT_B = '-----BEGIN CERTIFICATE-----\nMIIBtDCCAVqgAwIBAgIU\n-----END CERTIFICATE-----'
KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n'
TOKEN = '0123456789abcdef' * 4
USER_GROUPS = [{'name': 'SSO operators', 'permission': 'read-write', 'hostgroups': 'all'},
               {'name': 'SSO viewers', 'permission': 'read', 'hostgroups': ['Linux servers', 'Web/Frontend']}]


def sha(targets):
    return hashlib.sha256('\n'.join(sorted(targets, key=lambda s: s.encode())).encode()).hexdigest()


def saml_vars(**overrides):
    variables = {
        'zabbix_web_saml_enabled': True,
        'zabbix_web_api_token': TOKEN,
        'zabbix_web_saml_public_url': 'https://zabbix.example.com/',
        'zabbix_web_saml_idp_entityid': 'https://sso.example.com/saml/metadata',
        'zabbix_web_saml_sso_url': 'https://sso.example.com/saml/sso',
        'zabbix_web_saml_sp_entityid': 'zabbix',
        'zabbix_web_saml_idp_certificates': [CERT_A, CERT_B],
        'zabbix_web_saml_autologout': '1h',
        'zabbix_web_saml_jit': {
            'enabled': True, 'deprovisioned_group': 'SAML deprovisioned',
            'groups': [{'saml_group': 'admin', 'role': 'Admin role', 'user_groups': ['MBC admins']},
                       {'saml_group': 'operator', 'role': 'User role', 'user_groups': ['MBC operators']},
                       {'saml_group': 'viewer', 'role': 'User role', 'user_groups': ['MBC viewers']}],
        },
    }
    variables.update(overrides)
    return variables


def jit_with(**entry):
    jit = copy.deepcopy(saml_vars()['zabbix_web_saml_jit'])
    jit['groups'][0].update(entry)
    return jit


@unittest.skipUnless(yaml is not None and shutil.which('ansible-playbook'),
                     'requires PyYAML and an Ansible >=2.20 venv')
class SamlRoleTest(unittest.TestCase):
    def tasks(self):
        return yaml.safe_load((ROLE / 'tasks/main.yml').read_text())

    def base_vars(self, os_version='26.04', version='8.0'):
        variables = yaml.safe_load((ROLE / 'defaults/main.yml').read_text())
        variables.update(ansible_distribution='Ubuntu', ansible_distribution_version=os_version,
                         ansible_architecture='x86_64', zabbix_web_version=version, zabbix_web_ufw_manage=False,
                         zabbix_web_db_password='test-password', zabbix_web_db_type='postgresql',
                         zabbix_web_server_name='zabbix.test')
        return variables

    def run_play(self, variables, tasks, legacy=False):
        executable = os.environ.get('ZABBIX_TEST_LEGACY_ANSIBLE') if legacy else shutil.which('ansible-playbook')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'test.yml'
            play = [{'hosts': 'localhost', 'gather_facts': False, 'connection': 'local',
                     'vars': variables, 'tasks': tasks}]
            path.write_text(yaml.safe_dump(play, sort_keys=False))
            env = dict(os.environ, ANSIBLE_LOCAL_TEMP=tmp, ANSIBLE_NOCOLOR='1')
            return subprocess.run([executable, '-i', 'localhost,', str(path)], capture_output=True, text=True,
                                  env=env, timeout=60)

    def validate(self, extra, *, accepted, rejection=None, os_version='26.04', version='8.0', legacy=False):
        variables = self.base_vars(os_version, version)
        variables.update(extra)
        result = self.run_play(variables, [copy.deepcopy(self.tasks()[0])], legacy=legacy)
        if accepted:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn('"evaluated_to": false', result.stdout)
            self.assertNotIn('undefined', result.stdout)
            if rejection:
                self.assertIn(rejection, result.stdout)
        return result

    # --- Validate assert -------------------------------------------------------------------------

    def test_defaults_and_valid_saml_are_accepted(self):
        controllers = [False] + ([True] if os.environ.get('ZABBIX_TEST_LEGACY_ANSIBLE') else [])
        for legacy in controllers:
            for os_version, version in (('26.04', '8.0'), ('26.04', '7.0')) if not legacy else (('24.04', '7.0'),):
                with self.subTest(legacy=legacy, version=version):
                    self.validate({}, accepted=True, os_version=os_version, version=version, legacy=legacy)
                    self.validate(saml_vars(), accepted=True, os_version=os_version, version=version, legacy=legacy)
                    targets = ['alice@example.com', 'Bob@example.com']
                    self.validate(saml_vars(
                        zabbix_web_saml_local_users={'mode': 'delete', 'targets': targets,
                                                     'expected_sha256': sha(targets)},
                        zabbix_web_saml_sign={'authn_requests': True},
                        zabbix_web_saml_sp_certificate=CERT_A, zabbix_web_saml_sp_private_key=KEY,
                        zabbix_web_admin_lockdown=True, zabbix_web_saml_idp_entityid='urn:example:idp',
                        zabbix_web_saml_public_url='https://zabbix.example.com:8443/zabbix/'),
                        accepted=True, os_version=os_version, version=version, legacy=legacy)
                    self.validate(saml_vars(zabbix_web_saml_user_groups=USER_GROUPS), accepted=True,
                                  os_version=os_version, version=version, legacy=legacy)
                    # The bootstrap run uses the Admin password instead of the token.
                    self.validate(saml_vars(zabbix_web_api_token='', zabbix_web_admin_password='Abcdefgh1'),
                                  accepted=True, os_version=os_version, version=version, legacy=legacy)

    def test_invalid_inputs_are_rejected_by_the_first_assert(self):
        targets = ['alice@example.com', 'bob@example.com']
        local = {'mode': 'delete', 'targets': targets, 'expected_sha256': sha(targets)}
        cases = [
            ({'zabbix_web_api_token': 'A' * 64}, 'zabbix_web_api_token is match'),
            ({'zabbix_web_api_token': None}, 'zabbix_web_api_token is string'),
            ({'zabbix_web_admin_lockdown': 'yes'}, 'zabbix_web_admin_lockdown is boolean'),
            ({'zabbix_web_admin_lockdown': True}, 'not zabbix_web_admin_lockdown or'),
            ({'zabbix_web_saml_enabled': 'true'}, 'zabbix_web_saml_enabled is boolean'),
            ({'zabbix_web_housekeeping': {'hk_audit': '31d'}, 'zabbix_web_api_token': ''},
             'zabbix_web_housekeeping | length == 0 or'),
            (saml_vars(zabbix_web_api_token=''), 'zabbix_web_api_token | length > 0 or zabbix_web_admin_password'),
            (saml_vars(zabbix_web_saml_public_url='http://zabbix.example.com/'), 'zabbix_web_saml_public_url'),
            (saml_vars(zabbix_web_saml_public_url='https://zabbix.example.com'), 'zabbix_web_saml_public_url'),
            (saml_vars(zabbix_web_saml_public_url='https://zabbix.example.com/?a=1'), 'zabbix_web_saml_public_url'),
            (saml_vars(zabbix_web_saml_public_url="https://zabbix.example.com/');"), 'zabbix_web_saml_public_url'),
            (saml_vars(zabbix_web_saml_idp_entityid='sso.example.com'), 'zabbix_web_saml_idp_entityid'),
            (saml_vars(zabbix_web_saml_idp_entityid='https://x.example.com/' + 'a' * 1024),
             'zabbix_web_saml_idp_entityid'),
            (saml_vars(zabbix_web_saml_sso_url='http://sso.example.com/'), 'zabbix_web_saml_sso_url'),
            (saml_vars(zabbix_web_saml_slo_url='ftp://sso.example.com/'), 'zabbix_web_saml_slo_url'),
            (saml_vars(zabbix_web_saml_sp_entityid=''), 'zabbix_web_saml_sp_entityid'),
            (saml_vars(zabbix_web_saml_sp_entityid='zab bix'), 'zabbix_web_saml_sp_entityid'),
            (saml_vars(zabbix_web_saml_nameid_format='urn:oasis:names:tc:SAML:2.0:nameid-format:transient'),
             'zabbix_web_saml_nameid_format'),
            (saml_vars(zabbix_web_saml_username_attribute='user name'), 'zabbix_web_saml_username_attribute'),
            (saml_vars(zabbix_web_saml_case_sensitive='yes'), 'zabbix_web_saml_case_sensitive is boolean'),
            (saml_vars(zabbix_web_saml_sign={'messages': 'yes'}), 'zabbix_web_saml_sign_check'),
            (saml_vars(zabbix_web_saml_sign={'encrypt': True}), 'zabbix_web_saml_sign_check'),
            (saml_vars(zabbix_web_saml_sign=['messages']), 'zabbix_web_saml_sign_check'),
            (saml_vars(zabbix_web_saml_sign={'messages': False, 'assertions': False}), 'zabbix_web_saml_sign_check'),
            ({'zabbix_web_api_token': TOKEN, 'zabbix_web_admin_lockdown': True}, 'not zabbix_web_admin_lockdown or'),
            (saml_vars(zabbix_web_admin_lockdown_delete_tokens='yes'), 'zabbix_web_admin_lockdown_delete_tokens is boolean'),
            (saml_vars(zabbix_web_saml_idp_certificates=[]), 'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_idp_certificates=[CERT_A, CERT_A, CERT_B]),
             'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_idp_certificates=CERT_A), 'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_idp_certificates=[CERT_A.replace('MIIB', "MI'B")]),
             'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_idp_certificates=[CERT_A.replace('\n', '\r\n')]),
             'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_sign={'authn_requests': True}), 'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_sp_certificate=CERT_A), 'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_sp_certificate=CERT_A,
                       zabbix_web_saml_sp_private_key=KEY.replace('PRIVATE KEY', 'ENCRYPTED PRIVATE KEY')),
             'zabbix_web_saml_certificates_check'),
            (saml_vars(zabbix_web_saml_autologout='30s'), 'zabbix_web_saml_autologout'),
            (saml_vars(zabbix_web_saml_autologout='2d'), 'zabbix_web_saml_autologout'),
            (saml_vars(zabbix_web_saml_autologout='1y'), 'zabbix_web_saml_autologout'),
            (saml_vars(zabbix_web_saml_jit={'enabled': 'yes'}), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit={'enabled': True, 'unknown': 1}), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit={'enabled': True, 'groups': []}), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit=jit_with(saml_group='adm*')), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit=jit_with(role='Super admin role')), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit=jit_with(user_groups=[])), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit=jit_with(user_groups=['SAML deprovisioned'])),
             'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit=jit_with(saml_group='operator')), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_jit=dict(jit_with(), deprovisioned_group='')), 'zabbix_web_saml_jit_check'),
            (saml_vars(zabbix_web_saml_user_groups='all'), 'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups={'name': 'SSO viewers'}), 'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], extra=1)]), 'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[{'name': 'SSO viewers', 'permission': 'read'}]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], name='')]), 'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], name='a' * 65)]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], name='zabbix Administrators')]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], name='AI support automation (API only)')]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], name='saml Deprovisioned')]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[USER_GROUPS[0], dict(USER_GROUPS[1], name='sso Operators')]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], permission='write')]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], permission=3)]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], hostgroups='All')]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], hostgroups=[])]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], hostgroups=['Linux servers', 'Linux servers'])]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], hostgroups=[' Linux servers'])]),
             'zabbix_web_saml_user_groups_check'),
            (saml_vars(zabbix_web_saml_user_groups=[dict(USER_GROUPS[0], hostgroups=[1])]),
             'zabbix_web_saml_user_groups_check'),
            ({'zabbix_web_saml_local_users': local}, "zabbix_web_saml_local_users.mode | default('') == '' or"),
            ({'zabbix_web_saml_local_users': 'delete'}, 'zabbix_web_saml_local_users is mapping'),
            (saml_vars(zabbix_web_saml_local_users=dict(local, mode='disable')),
             'zabbix_web_saml_local_users_check'),
            (saml_vars(zabbix_web_saml_local_users=dict(local, targets=[])), 'zabbix_web_saml_local_users_check'),
            (saml_vars(zabbix_web_saml_local_users=dict(local, targets=targets + [targets[0]],
                                                         expected_sha256=sha(targets + [targets[0]]))),
             'zabbix_web_saml_local_users_check'),
            (saml_vars(zabbix_web_saml_local_users=dict(local, targets=['Admin'], expected_sha256=sha(['Admin']))),
             'zabbix_web_saml_local_users_check'),
            (saml_vars(zabbix_web_saml_local_users=dict(local, targets=['ai-support-automation'],
                                                         expected_sha256=sha(['ai-support-automation']))),
             'zabbix_web_saml_local_users_check'),
            (saml_vars(zabbix_web_saml_local_users=dict(local, expected_sha256='')),
             'zabbix_web_saml_local_users_check'),
            (saml_vars(zabbix_web_saml_local_users=dict(local, expected_sha256='0' * 64)),
             "hash('sha256') == zabbix_web_saml_local_users.expected_sha256"),
            # A trailing newline or case-insensitive sorting gives another hash.
            (saml_vars(zabbix_web_saml_local_users=dict(local, expected_sha256=hashlib.sha256(
                ('\n'.join(sorted(targets)) + '\n').encode()).hexdigest())),
             "hash('sha256') == zabbix_web_saml_local_users.expected_sha256"),
        ]
        for extra, rejection in cases:
            with self.subTest(rejection=rejection, extra=str(extra)[:120]):
                self.validate(extra, accepted=False, rejection=rejection)

    def test_saml_needs_seven_or_eight(self):
        if not os.environ.get('ZABBIX_TEST_LEGACY_ANSIBLE'):
            self.skipTest('requires ZABBIX_TEST_LEGACY_ANSIBLE pointing to a 2.16 ansible-playbook')
        self.validate(saml_vars(), accepted=False, rejection="zabbix_web_version in ['7.0', '8.0']",
                      os_version='24.04', version='6.0', legacy=True)

    def test_case_sensitive_hash_order(self):
        # Bytes order puts upper case first; a case-insensitive sort would differ.
        targets = ['bob@example.com', 'Alice@example.com', 'alice@example.com']
        self.validate(saml_vars(zabbix_web_saml_local_users={'mode': 'scramble', 'targets': targets,
                                                             'expected_sha256': sha(targets)}), accepted=True)

    # --- version floor ---------------------------------------------------------------------------

    def test_saml_version_floor_applies_on_every_release(self):
        tasks = self.tasks()
        check = next(t for t in tasks if 'Require the SAML version floor' in t['name'])
        cases = [('7.0', ['1:7.0.32-1+ubuntu24.04'], True), ('7.0', ['1:7.0.31-1+ubuntu22.04'], False),
                 ('7.0', ['1:7.0.40-1+ubuntu26.04'], True), ('8.0', ['2:8.0.0-1+ubuntu26.04'], True),
                 ('7.0', [], False)]
        role_vars = yaml.safe_load((ROLE / 'vars/main.yml').read_text())
        for version, lines, accepted in cases:
            with self.subTest(version=version, lines=lines):
                variables = dict(role_vars, zabbix_web_version=version, zabbix_web_saml_enabled=True,
                                 zabbix_web_saml_installed_version={'stdout_lines': lines})
                result = self.run_play(variables, [copy.deepcopy(check)])
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_version_floor_tasks_are_skipped_without_saml(self):
        tasks = self.tasks()
        for name in ('Read the installed frontend package for the SAML version floor',
                     'Require the SAML version floor'):
            task = next(t for t in tasks if name in t['name'])
            self.assertEqual(task['when'], 'zabbix_web_saml_enabled')
        names = [t['name'] for t in tasks]
        install = names.index('zabbix_web : Install the frontend, web server and PHP driver')
        floor = next(i for i, n in enumerate(names) if 'Require the SAML version floor' in n)
        rollback = names.index('zabbix_web : Prepare frontend rollback')
        self.assertLess(install, floor)
        self.assertLess(floor, rollback)

    # --- rendering -------------------------------------------------------------------------------

    def render(self, extra, *, task_name='Configure frontend DB and server connections'):
        tasks = self.tasks()
        block = next(t for t in tasks if 'block' in t and 'rescue' in t)
        task = copy.deepcopy(next(t for t in block['block'] if task_name in t['name']))
        task.pop('register', None)
        with tempfile.TemporaryDirectory() as tmp:
            args = task['ansible.builtin.copy']
            for key in ('validate', 'owner', 'group'):
                args.pop(key, None)
            args['dest'] = str(Path(tmp) / 'zabbix.conf.php')
            variables = self.base_vars()
            variables.update(extra)
            result = self.run_play(variables, [task])
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return (Path(tmp) / 'zabbix.conf.php').read_text()

    def test_conf_without_saml_has_no_sso_settings(self):
        text = self.render({})
        self.assertNotIn('$SSO', text)
        self.assertTrue(text.endswith('$IMAGE_FORMAT_DEFAULT = IMAGE_FORMAT_PNG;\n'), text)

    def test_conf_with_saml_uses_file_storage_fixed_baseurl_and_x509certmulti(self):
        text = self.render(saml_vars())
        lines = text.splitlines()
        self.assertIn("$SSO['CERT_STORAGE'] = 'file';", lines)
        self.assertIn("$SSO['IDP_CERT'] = '/etc/zabbix/web/saml/idp.crt';", lines)
        self.assertNotIn('SP_KEY', text)
        encoded = base64.b64encode(b'https://zabbix.example.com/').decode()
        self.assertIn("    'baseurl' => base64_decode('%s')," % encoded, lines)
        self.assertIn("    'use_proxy_headers' => false,", lines)
        self.assertIn("    'strict' => true,", lines)
        self.assertIn("        'MIIBszCCAVmgAwIBAgIUQUJDREVGRw==',", lines)
        self.assertIn("        'MIIBtDCCAVqgAwIBAgIU',", lines)
        self.assertTrue(text.endswith('];\n'), text)
        self.assertNotIn('{%', text)
        with_sp = self.render(saml_vars(zabbix_web_saml_sp_certificate=CERT_A, zabbix_web_saml_sp_private_key=KEY))
        self.assertIn("$SSO['SP_KEY'] = '/etc/zabbix/web/saml/sp.key';", with_sp.splitlines())
        self.assertIn("$SSO['SP_CERT'] = '/etc/zabbix/web/saml/sp.crt';", with_sp.splitlines())
        self.assertNotIn('MIIEvQ', with_sp)  # the key itself never goes into zabbix.conf.php

    def test_certificate_files_are_private_and_the_key_is_not_logged(self):
        tasks = self.tasks()
        block = next(t for t in tasks if t.get('name') == 'zabbix_web : Converge SAML certificate files')
        self.assertEqual(block['when'], 'zabbix_web_saml_enabled')
        names = [t['name'] for t in tasks]
        self.assertLess(names.index(block['name']), names.index('zabbix_web : Prepare frontend rollback'))
        directory, idp, sp_cert, sp_key, remove = block['block']
        self.assertEqual(directory['ansible.builtin.file'],
                         {'path': '/etc/zabbix/web/saml', 'state': 'directory', 'owner': 'root',
                          'group': 'www-data', 'mode': '0750'})
        for task in (idp, sp_cert, sp_key):
            self.assertEqual((task['ansible.builtin.copy']['owner'], task['ansible.builtin.copy']['group'],
                              task['ansible.builtin.copy']['mode']), ('root', 'www-data', '0640'))
        # copy content is censored by the module; a loop would print the key as the item.
        self.assertNotIn('loop', sp_key)
        self.assertFalse(sp_key['diff'])
        self.assertEqual(sp_key['ansible.builtin.copy']['dest'], '/etc/zabbix/web/saml/sp.key')
        self.assertEqual(remove['when'], 'zabbix_web_saml_sp_certificate | length == 0')
        with tempfile.TemporaryDirectory() as tmp:
            task = copy.deepcopy(idp)
            args = task['ansible.builtin.copy']
            args.pop('owner'); args.pop('group')
            args['dest'] = str(Path(tmp) / 'idp.crt')
            variables = self.base_vars()
            variables.update(saml_vars(zabbix_web_saml_idp_certificates=[CERT_B]))
            result = self.run_play(variables, [task])
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((Path(tmp) / 'idp.crt').read_text(), CERT_B + '\n')

    def test_bootstrap_stops_the_run_and_the_local_user_marker_is_recorded(self):
        api = yaml.safe_load((ROLE / 'tasks/api.yml').read_text())
        block = next(t for t in api if 'block' in t)['block']
        stop = next(t for t in block if 'Stop after the service user bootstrap' in t['name'])
        record = next(t for t in block if 'Record the completed one-time local user procedure' in t['name'])
        self.assertEqual(record['ansible.builtin.copy']['mode'], '0600')
        cases = (('{"changed": false, "password_changed": false, "housekeeping_changed": []}', False, None),
                 ('{"changed": true, "service_user_bootstrapped": true}', True, None),
                 ('{"changed": true, "local_users_marker": "%s:delete"}' % ('a' * 64), False, 'a' * 64 + ':delete\n'))
        for stdout, stops, marker in cases:
            with self.subTest(stdout=stdout), tempfile.TemporaryDirectory() as tmp:
                task = copy.deepcopy(record)
                args = task['ansible.builtin.copy']
                args.pop('owner'); args.pop('group')
                args['dest'] = str(Path(tmp) / 'done')
                result = self.run_play({'zabbix_web_api_result': {'rc': 0, 'stdout': stdout}},
                                       [copy.deepcopy(stop), task])
                self.assertEqual(result.returncode != 0, stops, result.stdout)
                done = Path(tmp) / 'done'
                self.assertEqual(done.read_text() if done.exists() else None, marker)

    def test_saml_directory_is_removed_and_warnings_follow_the_state(self):
        tasks = self.tasks()
        names = [t['name'] for t in tasks]
        block = next(i for i, t in enumerate(tasks) if 'block' in t and 'rescue' in t)
        remove = names.index('zabbix_web : Remove SAML certificates after SAML is disabled')
        self.assertGreater(remove, block)
        self.assertEqual(tasks[remove]['ansible.builtin.file'], {'path': '/etc/zabbix/web/saml', 'state': 'absent'})
        warn_names = ('zabbix_web : Warn that SAML stays enabled in the database without an API token',
                      'zabbix_web : Warn while SAML runs without the Admin lockdown or with legacy users allowed',
                      'zabbix_web : Warn that the one-time service user token file still exists')
        warns = [copy.deepcopy(tasks[names.index(n)]) for n in warn_names]
        cases = [  # (variables, expected warnings)
            ({}, []),
            ({'zabbix_web_saml_dir': {'stat': {'exists': True}}}, [0]),
            ({'zabbix_web_saml_dir': {'stat': {'exists': True}}, 'zabbix_web_api_token': TOKEN}, []),
            (saml_vars(zabbix_web_saml_token_file={'stat': {'exists': False}}), [1]),
            (saml_vars(zabbix_web_admin_lockdown=True, zabbix_web_saml_token_file={'stat': {'exists': False}}), []),
            (saml_vars(zabbix_web_admin_lockdown=True, zabbix_web_saml_allow_legacy_users=True,
                       zabbix_web_saml_token_file={'stat': {'exists': True}}), [1, 2]),
        ]
        for extra, expected in cases:
            with self.subTest(extra=str(extra)[:100]):
                variables = self.base_vars()
                variables.update(extra)
                result = self.run_play(variables, warns)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                shown = [i for i, n in enumerate(warn_names)
                         if 'TASK [%s]' % n in result.stdout
                         and 'skipping' not in result.stdout.split('TASK [%s]' % n)[1].split('TASK [')[0]]
                self.assertEqual(shown, expected, result.stdout)

    def test_api_input_carries_the_saml_settings_only_when_needed(self):
        api = yaml.safe_load((ROLE / 'tasks/api.yml').read_text())
        block = next(t for t in api if 'block' in t)
        write = next(t for t in block['block'] if t['name'] == 'zabbix_web : Write API connection parameters')
        task = copy.deepcopy(write)
        with tempfile.TemporaryDirectory() as tmp:
            task['ansible.builtin.copy']['dest'] = str(Path(tmp) / 'input.json')
            for extra, expected in (({}, None), ({'zabbix_web_api_token': TOKEN}, False), (saml_vars(), True)):
                variables = self.base_vars()
                variables.update(extra)
                result = self.run_play(variables, [task])
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                import json
                data = json.loads((Path(tmp) / 'input.json').read_text())
                self.assertEqual(data['token_output_path'], '/var/lib/ai-support-zabbix/service-user-token')
                if expected is None:
                    self.assertIsNone(data['saml'])
                else:
                    self.assertEqual(data['saml']['enabled'], expected)
                    self.assertEqual(data['saml']['user_groups'], [])
                    self.assertNotIn('sp_private_key', str(data))
            task['ansible.builtin.copy']['dest'] = str(Path(tmp) / 'groups.json')
            variables = self.base_vars()
            variables.update(saml_vars(zabbix_web_saml_user_groups=USER_GROUPS))
            result = self.run_play(variables, [task])
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            data = json.loads((Path(tmp) / 'groups.json').read_text())
            self.assertEqual(data['saml']['user_groups'], USER_GROUPS)


if __name__ == '__main__':
    unittest.main()
