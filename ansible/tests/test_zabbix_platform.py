"""Evaluate the real role validation and platform templates with ansible-playbook.

Run in an Ansible >=2.20 venv with ZABBIX_TEST_LEGACY_ANSIBLE pointing to a
2.16 ansible-playbook: python -m unittest discover -s ansible/tests -p test_zabbix_platform.py -v
No package/service changes are executed; only assert tasks from the roles are used.
"""
import copy
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


@unittest.skipUnless(yaml is not None and shutil.which('ansible-playbook'),
                     "requires PyYAML and an Ansible >=2.20 venv (legacy-controller cases also need "
                     "ZABBIX_TEST_LEGACY_ANSIBLE)")
class PlatformTest(unittest.TestCase):
    def play(self, role, os_version, *, version='7.0', core='2.20.0', timescale=False, success=True, rejection=None,
             extra=None):
        directory = ROOT / 'roles' / role
        defaults = yaml.safe_load((directory / 'defaults/main.yml').read_text())
        tasks = yaml.safe_load((directory / 'tasks/main.yml').read_text())
        variables = dict(defaults, ansible_distribution='Ubuntu', ansible_distribution_version=os_version,
                         ansible_architecture='x86_64')
        variables.update({f'{role}_version': version, f'{role}_ufw_manage': False})
        if role != 'zabbix_agent':
            variables.update({f'{role}_db_password': 'test-password', f'{role}_db_type': 'postgresql'})
        if role == 'zabbix_server':
            variables['zabbix_server_db_timescaledb'] = timescale
        if role == 'zabbix_web':
            variables['zabbix_web_server_name'] = 'zabbix.test'
        if role == 'zabbix_agent':
            variables['zabbix_agent_server'] = '127.0.0.1'
        variables.update(extra or {})
        validation = copy.deepcopy(tasks[0])
        play = [{'hosts': 'localhost', 'gather_facts': False, 'connection': 'local',
                 'vars': variables, 'tasks': [validation]}]
        result = self.run_play(play, legacy=core.startswith('2.16'))
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn('\"evaluated_to\": false', result.stdout)
            if rejection:
                self.assertIn(rejection, result.stdout)
            self.assertNotIn('undefined', result.stdout)

    def run_play(self, play, legacy=False):
        if legacy and not os.environ.get('ZABBIX_TEST_LEGACY_ANSIBLE'):
            self.skipTest('requires ZABBIX_TEST_LEGACY_ANSIBLE pointing to a 2.16 ansible-playbook')
        executable = os.environ.get('ZABBIX_TEST_LEGACY_ANSIBLE') if legacy else shutil.which('ansible-playbook')
        self.assertIsNotNone(executable, 'Run with ansible-core >=2.20 and ZABBIX_TEST_LEGACY_ANSIBLE pointing to 2.16 ansible-playbook')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'test.yml'
            path.write_text(yaml.safe_dump(play, sort_keys=False))
            env = dict(os.environ, ANSIBLE_LOCAL_TEMP=tmp, ANSIBLE_NOCOLOR='1')
            return subprocess.run([executable, '-i', 'localhost,', str(path)],
                                  capture_output=True, text=True, env=env, timeout=30)

    def test_psk_requires_even_hex_and_protocol_length(self):
        tasks = yaml.safe_load((ROOT / 'roles/zabbix_agent/tasks/main.yml').read_text())
        task = next(t for t in tasks if 'Validate the PSK settings' in t['name'])
        for size, accepted in [(32, True), (64, True), (512, True), (33, False), (514, False)]:
            play = [{'hosts': 'localhost', 'gather_facts': False, 'connection': 'local',
                     'vars': {'zabbix_agent_psk': 'a' * size, 'zabbix_agent_psk_identity': 'test-id',
                              'zabbix_agent_tls_connect': 'psk', 'zabbix_agent_tls_accept': 'psk'},
                     'tasks': [task]}]
            with self.subTest(size=size):
                self.assertEqual(self.run_play(play).returncode == 0, accepted)

    def test_accepts_resolute_with_supported_controller(self):
        for role in ('zabbix_server', 'zabbix_web', 'zabbix_agent'):
            with self.subTest(role=role):
                self.play(role, '26.04')

    def test_rejects_resolute_with_legacy_controller(self):
        for role in ('zabbix_server', 'zabbix_web', 'zabbix_agent'):
            with self.subTest(role=role):
                self.play(role, '26.04', core='2.16.19', success=False, rejection='ansible_version.full')

    def test_rejects_six_on_resolute(self):
        for role in ('zabbix_server', 'zabbix_web', 'zabbix_agent'):
            with self.subTest(role=role):
                self.play(role, '26.04', version='6.0', success=False, rejection=f'{role}_version')

    def test_rejects_unvalidated_timescale_on_resolute(self):
        self.play('zabbix_server', '26.04', timescale=True, success=False, rejection='zabbix_server_db_timescaledb')

    def test_preserves_supported_old_platforms(self):
        for release in ('22.04', '24.04'):
            for role in ('zabbix_server', 'zabbix_web', 'zabbix_agent'):
                with self.subTest(role=role, release=release):
                    self.play(role, release, core='2.16.19')

    def role_vars(self, role):
        path = ROOT / 'roles' / role / 'vars/main.yml'
        return yaml.safe_load(path.read_text()) if path.exists() else {}

    def run_check(self, role, name, version, versions, *, release='26.04', arch='x86_64'):
        tasks = yaml.safe_load((ROOT / 'roles' / role / 'tasks/main.yml').read_text())
        check = next(t for t in tasks if name in t['name'])
        play = [{'hosts': 'localhost', 'gather_facts': False,
                 'vars': dict(self.role_vars(role), ansible_distribution_version=release,
                              ansible_architecture=arch,
                              **{f'{role}_version': version,
                                 f'{role}_installed_version': {'stdout_lines': versions}}),
                 'tasks': [check]}]
        return self.run_play(play)

    def test_existing_resolute_packages_require_validated_patch(self):
        cases = [('7.0', [], True), ('7.0', ['1:7.0.32-1+ubuntu26.04'], True),
                 ('7.0', ['1:7.0.33-1+ubuntu26.04'], True),
                 ('7.0', ['1:7.0.24-1+ubuntu26.04'], False),
                 ('7.0', ['1:7.0.32-1+ubuntu26.04', '1:7.0.25-1+ubuntu26.04'], False),
                 ('8.0', [], True), ('8.0', ['2:8.0.0-1+ubuntu26.04'], True),
                 ('8.0', ['2:8.0.1-1+ubuntu26.04'], True)]
        for role in ('zabbix_server', 'zabbix_web'):
            for version, versions, accepted in cases:
                with self.subTest(role=role, version=version, versions=versions):
                    result = self.run_check(role, 'Require the validated patch baseline', version, versions)
                    self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_existing_packages_must_match_the_selected_series(self):
        cases = [('7.0', ['1:7.0.32-1+ubuntu26.04'], True), ('7.0', ['2:8.0.0-1+ubuntu26.04'], False),
                 ('8.0', ['2:8.0.0-1+ubuntu26.04'], True), ('8.0', ['1:7.0.32-2+ubuntu26.04'], False),
                 ('8.0', ['8.0.0-1+ubuntu26.04'], True), ('8.0', ['2:8.00.1-1'], False)]
        names = {'zabbix_server': 'Reject unattended LTS changes',
                 'zabbix_web': 'Reject incompatible existing LTS packages'}
        for role, name in names.items():
            for version, versions, accepted in cases:
                with self.subTest(role=role, version=version, versions=versions):
                    result = self.run_check(role, name, version, versions)
                    self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_fresh_install_cannot_initialize_with_old_or_missing_packages(self):
        cases = [('7.0', [], False), ('7.0', ['1:7.0.32-1+ubuntu26.04'], False),
                 ('7.0', ['1:7.0.32-1+ubuntu26.04'] * 2, True),
                 ('7.0', ['1:7.0.24-1+ubuntu26.04'] * 2, False),
                 ('7.0', ['1:8.0.0-1+ubuntu26.04'] * 2, False),
                 ('7.0', ['2:8.0.0-1+ubuntu26.04'] * 2, False),
                 ('8.0', ['2:8.0.0-1+ubuntu26.04'] * 2, True),
                 ('8.0', ['2:8.0.0-1+ubuntu26.04'], False),
                 ('8.0', ['1:8.0.0-1+ubuntu26.04'] * 2, False),
                 ('8.0', ['1:7.0.32-2+ubuntu26.04'] * 2, False),
                 ('8.0', ['2:7.0.32-1+ubuntu26.04'] * 2, False)]
        for role in ('zabbix_server', 'zabbix_web'):
            for version, versions, accepted in cases:
                with self.subTest(role=role, version=version, versions=versions):
                    result = self.run_check(role, 'Verify installed patch baseline', version, versions)
                    self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_accepts_eight_on_resolute(self):
        for role in ('zabbix_server', 'zabbix_web'):
            with self.subTest(role=role):
                self.play(role, '26.04', version='8.0')

    def test_rejects_eight_on_unvalidated_platforms(self):
        for release in ('22.04', '24.04'):
            for role in ('zabbix_server', 'zabbix_web'):
                with self.subTest(role=role, release=release):
                    self.play(role, release, version='8.0', core='2.16.19', success=False,
                              rejection=f'{role}_version')

    def test_rejects_unknown_series(self):
        for role in ('zabbix_server', 'zabbix_web'):
            with self.subTest(role=role):
                self.play(role, '26.04', version='7.4', success=False, rejection=f'{role}_version')

    def render(self, role, expressions, *, version, release='26.04', arch='x86_64'):
        play = [{'hosts': 'localhost', 'gather_facts': False,
                 'vars': dict(self.role_vars(role), ansible_distribution_version=release,
                              ansible_architecture=arch, **{f'{role}_version': version}),
                 'tasks': [{'ansible.builtin.assert': {'that': expressions}}]}]
        return self.run_play(play)

    def test_repository_layout_per_series(self):
        expected = {
            ('7.0', 'x86_64'): ('https://repo.zabbix.com/zabbix/7.0/ubuntu',
                                'https://repo.zabbix.com/zabbix/7.0/ubuntu/pool/main/z/zabbix-release/'
                                'zabbix-release_latest_7.0+ubuntu26.04_all.deb', '1'),
            ('7.0', 'aarch64'): ('https://repo.zabbix.com/zabbix/7.0/ubuntu-arm64',
                                 'https://repo.zabbix.com/zabbix/7.0/ubuntu-arm64/pool/main/z/zabbix-release/'
                                 'zabbix-release_latest_7.0+ubuntu26.04_all.deb', '1'),
            ('8.0', 'x86_64'): ('https://repo.zabbix.com/zabbix/8.0/stable/ubuntu',
                                'https://repo.zabbix.com/zabbix/8.0/release/ubuntu/pool/main/z/zabbix-release/'
                                'zabbix-release_latest_8.0+ubuntu26.04_all.deb', '2'),
            ('8.0', 'aarch64'): ('https://repo.zabbix.com/zabbix/8.0/stable/ubuntu',
                                 'https://repo.zabbix.com/zabbix/8.0/release/ubuntu/pool/main/z/zabbix-release/'
                                 'zabbix-release_latest_8.0+ubuntu26.04_all.deb', '2'),
        }
        for role in ('zabbix_server', 'zabbix_web'):
            for (version, arch), (uri, deb, epoch) in expected.items():
                with self.subTest(role=role, version=version, arch=arch):
                    result = self.render(role, [f"{role}_repo_uri == '{uri}'", f"{role}_release_deb == '{deb}'",
                                                f"{role}_pkg_epoch == '{epoch}'"], version=version, arch=arch)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_install_pins_use_the_series_epoch(self):
        for role, task_name in (('zabbix_server', 'Install the selected server and SQL scripts'),
                                ('zabbix_web', 'Install the frontend, web server and PHP driver')):
            tasks = yaml.safe_load((ROOT / 'roles' / role / 'tasks/main.yml').read_text())
            names = next(t for t in tasks if task_name in t['name'])['ansible.builtin.apt']['name']
            pinned = [n for n in names if n.startswith('zabbix-') or n.startswith("{{ 'zabbix-")]
            self.assertTrue(pinned)
            for name in pinned:
                with self.subTest(role=role, name=name):
                    self.assertIn(f'={{{{ {role}_pkg_epoch }}}}:{{{{ {role}_version }}}}.*', name)

    def test_web_listen_address_validation(self):
        cases = [({'zabbix_web_listen_address': ''}, True, None),
                 ({'zabbix_web_listen_address': '127.0.0.1'}, True, None),
                 ({'zabbix_web_listen_address': '10.0.0.5'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '127.0.0.2'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '0.0.0.0'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': 'localhost'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '::1'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '127.0.0.1/32'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '127.0.0.01'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '256.0.0.1'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': ' 127.0.0.1'}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': None}, False, 'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '127.0.0.1', 'zabbix_web_type': 'apache'}, False,
                  'zabbix_web_listen_address'),
                 ({'zabbix_web_listen_address': '127.0.0.1', 'zabbix_web_allowed_sources': ['10.0.0.0/24']}, False,
                  'zabbix_web_listen_address')]
        for extra, accepted, rejection in cases:
            with self.subTest(extra=extra):
                self.play('zabbix_web', '26.04', version='8.0', success=accepted, rejection=rejection, extra=extra)

    def test_nginx_template_listen_line(self):
        from jinja2 import Environment
        template = Environment().from_string((ROOT / 'roles/zabbix_web/templates/nginx.conf.j2').read_text())
        for address, line in (('', '    listen 8080;'), ('127.0.0.1', '    listen 127.0.0.1:8080;')):
            with self.subTest(address=address):
                text = template.render(zabbix_web_listen_address=address, zabbix_web_listen_port=8080,
                                       zabbix_web_server_name='zabbix.test', zabbix_web_php_version='8.5')
                self.assertIn(line + '\n', text)
                self.assertEqual(sum(1 for l in text.splitlines() if l.strip().startswith('listen')), 1)

    def test_ui_root_per_series(self):
        # Zabbix 7.2+ packages moved the frontend PHP files to /usr/share/zabbix/ui; the old
        # path only holds stubs that print "Manual intervention is required" (HTTP 404).
        for version, root in (('6.0', '/usr/share/zabbix'), ('7.0', '/usr/share/zabbix'),
                              ('8.0', '/usr/share/zabbix/ui')):
            with self.subTest(version=version):
                result = self.render('zabbix_web', [f"zabbix_web_ui_root == '{root}'"], version=version)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_templates_use_the_ui_root_and_deny_internal_directories(self):
        from jinja2 import Environment
        for name in ('nginx.conf.j2', 'apache.conf.j2'):
            template = Environment().from_string((ROOT / 'roles/zabbix_web/templates' / name).read_text())
            text = template.render(zabbix_web_listen_address='', zabbix_web_listen_port=8080,
                                   zabbix_web_server_name='zabbix.test', zabbix_web_ui_root='/usr/share/zabbix/ui')
            with self.subTest(template=name):
                self.assertNotRegex(text, r'/usr/share/zabbix(?!/ui)')
                self.assertIn('/usr/share/zabbix/ui', text)
                self.assertRegex(text, r'\(api\|conf\|include\|locale\|vendor\)')

    def test_apply_state_is_driven_by_the_listener(self):
        # nginx reload cannot narrow a wildcard listener to a specific address on the same
        # port (bind EADDRINUSE keeps the old config); a changed vhost must restart.
        tasks = yaml.safe_load((ROOT / 'roles/zabbix_web/tasks/main.yml').read_text())
        block = next(t for t in tasks if t['name'].endswith('Update frontend settings with rollback'))
        apply = next(t for t in block['block'] if t['name'].endswith('Apply the web configuration'))
        state = apply['ansible.builtin.service']['state']
        self.assertIn('restarted', state)
        self.assertIn('zabbix_web_listener_differs', state)
        names = [t['name'] for t in block['block']]
        self.assertTrue(any('actual web listener' in n for n in names), names)

    def web_block_task(self, suffix):
        tasks = yaml.safe_load((ROOT / 'roles/zabbix_web/tasks/main.yml').read_text())
        block = next(t for t in tasks if t['name'].endswith('Update frontend settings with rollback'))
        return next(t for t in block['block'] if t['name'].endswith(suffix))

    def test_apply_state_restarts_when_vhost_changed_or_listener_differs(self):
        apply = self.web_block_task('Apply the web configuration')
        wildcard = ['LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*']
        loopback = ['LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*']
        ipv6 = ['LISTEN 0 511 [::]:8080 [::]:*']
        cases = [
            # a vhost change that keeps the listener (root, deny list, ...) only reloads
            (True, '', {'stdout_lines': wildcard}, 'nginx', 'reloaded'),
            (True, '127.0.0.1', {'stdout_lines': loopback}, 'nginx', 'reloaded'),
            (False, '127.0.0.1', {'stdout_lines': loopback}, 'nginx', 'reloaded'),
            # nothing listens yet (fresh install): reload just adds the socket
            (True, '127.0.0.1', {'stdout_lines': []}, 'nginx', 'reloaded'),
            (True, '', {'stdout_lines': []}, 'nginx', 'reloaded'),
            # narrowing and widening both hit EADDRINUSE on reload
            (False, '127.0.0.1', {'stdout_lines': wildcard}, 'nginx', 'restarted'),
            (True, '127.0.0.1', {'stdout_lines': wildcard}, 'nginx', 'restarted'),
            (True, '', {'stdout_lines': loopback}, 'nginx', 'restarted'),
            # another listener on the same port (e.g. [::]:8080 from another server block)
            (True, '', {'stdout_lines': wildcard + ipv6}, 'nginx', 'reloaded'),
            (False, '127.0.0.1', {'stdout_lines': loopback + ipv6}, 'nginx', 'reloaded'),
            (False, '127.0.0.1', {'stdout_lines': wildcard + ipv6}, 'nginx', 'restarted'),
            # a peer column such as 127.0.0.1:8080 must not count as the local address
            (False, '127.0.0.1', {'stdout_lines': ['LISTEN 0 511 0.0.0.0:8080 127.0.0.1:8080']}, 'nginx', 'restarted'),
            # apache never narrows (listen address is nginx-only) and is not read
            (True, '', {'skipped': True}, 'apache', 'reloaded'),
        ]
        for changed, address, before, web_type, expected in cases:
            play = [{'hosts': 'localhost', 'gather_facts': False,
                     'vars': dict(apply.get('vars', {}), zabbix_web_vhost={'changed': changed},
                                  zabbix_web_listen_address=address, zabbix_web_listen_port=8080,
                                  zabbix_web_listener_before=before, zabbix_web_type=web_type,
                                  apply_state=apply['ansible.builtin.service']['state']),
                     'tasks': [{'ansible.builtin.assert': {'that': [f"apply_state == '{expected}'"]}}]}]
            # 2.16 renders without native types; the expression must not turn "False" truthy.
            for legacy in (False, True):
                if legacy and not os.environ.get('ZABBIX_TEST_LEGACY_ANSIBLE'):
                    continue
                with self.subTest(changed=changed, address=address, before=before, legacy=legacy):
                    result = self.run_play(play, legacy=legacy)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_listener_assert_accepts_only_the_configured_address(self):
        check = self.web_block_task('Require the actual web listener to match zabbix_web_listen_address')
        for lines, accepted in [(['LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*'], True),
                                (['LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*'], False),
                                (['LISTEN 0 511 [::]:8080 [::]:*'], False),
                                (['LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*', 'LISTEN 0 511 [::]:8080 [::]:*'], False),
                                ([], False)]:
            play = [{'hosts': 'localhost', 'gather_facts': False,
                     'vars': {'zabbix_web_listen_address': '127.0.0.1', 'zabbix_web_listen_port': 8080,
                              'zabbix_web_listener': {'stdout_lines': lines}},
                     'tasks': [check]}]
            with self.subTest(lines=lines):
                result = self.run_play(play)
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_rescue_restarts_when_the_vhost_had_changed(self):
        tasks = yaml.safe_load((ROOT / 'roles/zabbix_web/tasks/main.yml').read_text())
        block = next(t for t in tasks if t['name'].endswith('Update frontend settings with rollback'))
        restore = next(t for t in block['rescue'] if 'Restore previous web service state' in t['name'])
        state = restore['ansible.builtin.service']['state']
        for changed, running, expected in [(True, 'running', 'restarted'), (False, 'running', 'reloaded'),
                                           (None, 'running', 'reloaded'), (True, 'stopped', 'stopped')]:
            vhost = {} if changed is None else {'changed': changed}
            play = [{'hosts': 'localhost', 'gather_facts': False,
                     'vars': {'zabbix_web_type': 'nginx', 'zabbix_web_vhost': vhost,
                              'zabbix_web_services': {'ansible_facts': {'services': {'nginx.service': {'state': running}}}},
                              'restore_state': state},
                     'tasks': [{'ansible.builtin.assert': {'that': [f"restore_state == '{expected}'"]}}]}]
            with self.subTest(changed=changed, running=running):
                result = self.run_play(play)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_agent_refuses_to_switch_a_shared_repository(self):
        tasks = yaml.safe_load((ROOT / 'roles/zabbix_agent/tasks/main.yml').read_text())
        read = next(t for t in tasks if 'Read Zabbix server and frontend packages sharing' in t['name'])
        self.assertEqual(read['ansible.builtin.command']['argv'][2], r'-f=${db:Status-Abbrev} ${Version}\n')
        check = next(t for t in tasks if 'Refuse to repoint the repository shared' in t['name'])
        install = next(i for i, t in enumerate(tasks) if t['name'].endswith('Install the Zabbix repository package'))
        self.assertLess(tasks.index(check), install)
        # dpkg-query -f='${db:Status-Abbrev} ${Version}': packages present on disk count (ii/hi/iF...);
        # removed-but-not-purged (rc) packages keep their old version and must not block.
        for version, lines, accepted in [('7.0', [], True), ('7.0', ['un  ', 'un  '], True),
                                         ('7.0', ['ii  1:7.0.32-2+ubuntu26.04'], True),
                                         ('7.0', ['ii  2:8.0.0-1+ubuntu26.04'], False),
                                         ('7.0', ['ii  2:8.0.0-1+ubuntu26.04', 'ii  2:8.0.0-1+ubuntu26.04'], False),
                                         ('7.0', ['rc  2:8.0.0-1+ubuntu26.04'], True),
                                         # held packages (the foundation recipe holds them) are installed
                                         ('7.0', ['hi  2:8.0.0-1+ubuntu26.04', 'un  ', 'hi  2:8.0.0-1+ubuntu26.04'], False),
                                         ('8.0', ['hi  2:8.0.0-1+ubuntu26.04'], True),
                                         ('7.0', ['iF  2:8.0.0-1+ubuntu26.04'], False),
                                         ('7.0', ['rc  2:8.0.0-1+ubuntu26.04', 'ii  1:7.0.32-2+ubuntu26.04'], True),
                                         ('6.0', ['ii  1:7.0.32-2+ubuntu24.04'], False)]:
            play = [{'hosts': 'localhost', 'gather_facts': False,
                     'vars': {'zabbix_agent_version': version, 'zabbix_agent_manage_packages': True,
                              'zabbix_agent_shared_packages': {'stdout_lines': lines}},
                     'tasks': [check]}]
            with self.subTest(version=version, lines=lines):
                result = self.run_play(play)
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_web_role_installs_ss(self):
        tasks = yaml.safe_load((ROOT / 'roles/zabbix_web/tasks/main.yml').read_text())
        names = next(t for t in tasks if 'Install the frontend, web server and PHP driver' in t['name'])
        self.assertIn('iproute2', names['ansible.builtin.apt']['name'])

    def test_unstable_repository_must_stay_disabled(self):
        for role in ('zabbix_server', 'zabbix_web'):
            tasks = yaml.safe_load((ROOT / 'roles' / role / 'tasks/main.yml').read_text())
            task = next(t for t in tasks if 'unstable repository' in t['name'])
            self.assertEqual(task['ansible.builtin.command']['argv'],
                             ['grep', '-qx', 'Enabled: no', '/etc/apt/sources.list.d/zabbix-unstable.sources'])
            self.assertIn("== '8.0'", task['when'])

    def test_platform_templates(self):
        for release, suite, php in [('22.04', 'jammy', '8.1'), ('24.04', 'noble', '8.3'), ('26.04', 'resolute', '8.5')]:
            for role in ('zabbix_server', 'zabbix_web'):
                tasks = yaml.safe_load((ROOT / 'roles' / role / 'tasks/main.yml').read_text())
                repo = next(t['ansible.builtin.copy']['content'] for t in tasks
                            if 'Converge the architecture-specific repository' in t['name'])
                php_vars = yaml.safe_load((ROOT / 'roles/zabbix_web/vars/main.yml').read_text())
                play = [{'hosts': 'localhost', 'gather_facts': False,
                         'vars': dict(php_vars, **self.role_vars(role), ansible_distribution_version=release,
                                      ansible_architecture='x86_64', **{f'{role}_version': '7.0'}, repo_content=repo),
                         'tasks': [{'ansible.builtin.assert': {'that': [
                             f"'Suites: {suite}' in repo_content", f"zabbix_web_php_version == '{php}'"]}}]}]
                result = self.run_play(play)
                with self.subTest(role=role, release=release):
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
