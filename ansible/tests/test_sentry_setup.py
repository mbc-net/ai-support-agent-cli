import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

SOURCE = pathlib.Path(__file__).parents[1] / 'roles/sentry/files/sentry_setup.py'
spec = importlib.util.spec_from_file_location('sentry_setup', SOURCE)
sentry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sentry)


class SentrySetupTest(unittest.TestCase):
    def config(self, **values):
        return dict(profile='errors-only', domain='sentry.example.com', proxy_mode='external',
                    admin_email='admin@example.com', admin_password='a password with $() and "quotes"',
                    retention_days=30, acme_email='', smtp_host='', smtp_port=587,
                    smtp_user='', smtp_password='', smtp_tls=True, mail_from='', **values)

    def test_invalid_config_fails_before_side_effects(self):
        for field, value in [('domain', 'example.com\nlocalhost'), ('profile', 'latest'),
                             ('retention_days', 0), ('smtp_port', True), ('smtp_tls', 'false'),
                             ('proxy_mode', 'anything'), ('smtp_host', 'smtp.example.com\nX')]:
            config = self.config()
            config[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                sentry.validate_config(config)

    def test_secret_characters_are_json_data_not_shell(self):
        config = self.config()
        config.update(smtp_host='smtp.example.com', smtp_password='$(touch /tmp/unsafe)\n"quoted"')
        sentry.validate_config(config)
        encoded = sentry.render_config(config)
        self.assertEqual(json.loads(encoded)['mail.password'], config['smtp_password'])
        self.assertNotIn(config['admin_password'], encoded)
        self.assertNotIn('smtp_password', sentry.render_env(config, 'a' * 64))

    def test_secret_input_is_censored_without_relying_on_recipe_variable_metadata(self):
        import yaml
        tasks = yaml.safe_load((SOURCE.parents[1] / 'tasks/main.yml').read_text())
        secret_writes = [task for task in tasks
                         if task.get('ansible.builtin.copy', {}).get('dest')
                         == '/var/lib/ai-support-sentry/config.json']
        self.assertEqual(len(secret_writes), 1)
        self.assertIsNot(secret_writes[0].get('no_log'), True)
        self.assertIs(secret_writes[0].get('diff'), False)

    def test_prepared_without_source_can_be_diagnosed_before_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / 'state'
            source = pathlib.Path(directory) / 'source'
            with patch.object(sentry, 'ROOT', root), patch.object(sentry, 'SOURCE', source), \
                    patch.object(sentry, 'active', return_value=False), \
                    patch.object(sentry, 'containers', return_value=[]), patch.object(sentry, 'run') as run:
                sentry.save_state(dict(run_id='exec-1', phase='prepared', settled=False,
                                      commit=sentry.COMMIT, profile='errors-only'))
                sentry.main(['diagnose'])
                self.assertTrue(sentry.state()['settled'])
                run.assert_not_called()
                sentry.preflight('install')

    def test_missing_source_does_not_allow_interrupted_migration_retry(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(sentry, 'ROOT', pathlib.Path(directory) / 'state'), \
                patch.object(sentry, 'SOURCE', pathlib.Path(directory) / 'absent'), \
                patch.object(sentry, 'active', return_value=False), \
                patch.object(sentry, 'containers', return_value=[]):
            sentry.save_state(dict(run_id='exec-1', phase='installing', settled=False))
            with self.assertRaisesRegex(ValueError, 'manual recovery'):
                sentry.main(['diagnose'])
            self.assertFalse(sentry.state()['settled'])

    def test_standalone_compose_wrapper_attributes_migration_to_execution(self):
        import yaml
        tasks = yaml.safe_load((SOURCE.parents[1] / 'tasks/main.yml').read_text())
        wrappers = [task['ansible.builtin.copy'] for task in tasks
                    if task.get('ansible.builtin.copy', {}).get('dest', '').endswith('/bin/docker-compose')]
        self.assertEqual(len(wrappers), 1)
        self.assertIn('sentry_setup.py docker compose "$@"', wrappers[0]['content'])
        with patch.dict(os.environ, {'SENTRY_JOB_ID': 'exec-1'}), patch.object(os, 'execv') as execute:
            sentry.main(['docker', 'compose', '--ansi', 'never', 'run', '--rm', 'web', 'upgrade'])
        self.assertIn(sentry.LABEL + '=exec-1', execute.call_args.args[1])

    def test_launchpad_secret_persists_and_stays_shell_safe(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(sentry, 'ROOT', pathlib.Path(directory)):
            secret = sentry.launchpad_secret()
            self.assertRegex(secret, r'^[a-f0-9]{64}$')
            self.assertEqual(sentry.launchpad_secret(), secret)
            file = pathlib.Path(directory) / 'launchpad-secret.json'
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertIn('LAUNCHPAD_RPC_SHARED_SECRET=' + secret, sentry.render_env(self.config(), secret))
            with self.assertRaises(ValueError):
                sentry.render_env(self.config(), '$(touch /tmp/unsafe)')

    def test_proxy_settings_preserve_existing_config_and_are_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'sentry.conf.py'
            file.write_text('SENTRY_OPTIONS = {}\nCUSTOM_SETTING = "preserved"\n')
            self.assertTrue(sentry.write_proxy_config(file, self.config()))
            first = file.read_text()
            self.assertFalse(sentry.write_proxy_config(file, self.config()))
            self.assertEqual(file.read_text(), first)
            config = self.config()
            config['domain'] = 'new.example.com'
            self.assertTrue(sentry.write_proxy_config(file, config))
            settings = {}
            exec(compile(file.read_text(), str(file), 'exec'), settings)
            self.assertEqual(settings['CUSTOM_SETTING'], 'preserved')
            self.assertEqual(settings['SECURE_PROXY_SSL_HEADER'], ('HTTP_X_FORWARDED_PROTO', 'https'))
            self.assertEqual(settings['CSRF_TRUSTED_ORIGINS'], ['https://new.example.com'])
            for key in ['USE_X_FORWARDED_HOST', 'SESSION_COOKIE_SECURE', 'CSRF_COOKIE_SECURE',
                        'SOCIAL_AUTH_REDIRECT_IS_HTTPS']:
                self.assertIs(settings[key], True)
            self.assertEqual(file.read_text().count('SECURE_PROXY_SSL_HEADER ='), 1)

    def test_secret_key_survives_config_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'config.yml'
            file.write_text(json.dumps({'system.secret-key': 'persistent-key'}))
            with patch.object(sentry.os, 'chown') as chown:
                sentry.write_sentry_config(file, self.config())
                chown.assert_called_once_with(file, 999, 999)
            self.assertEqual(json.loads(file.read_text())['system.secret-key'], 'persistent-key')
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_smtp_sender_overrides_upstream_python_default_and_updates_on_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'sentry.conf.py'
            file.write_text('SENTRY_OPTIONS = {"mail.from": "sentry@localhost"}\nCUSTOM_SETTING = 42\n')
            config = self.config()
            config.update(smtp_host='smtp.example.com', mail_from='alerts@example.com')
            sentry.write_proxy_config(file, config)
            settings = {}
            exec(compile(file.read_text(), str(file), 'exec'), settings)
            self.assertEqual(settings['SENTRY_OPTIONS']['mail.from'], 'alerts@example.com')
            self.assertEqual(settings['CUSTOM_SETTING'], 42)
            config['mail_from'] = ''
            sentry.write_proxy_config(file, config)
            settings = {}
            exec(compile(file.read_text(), str(file), 'exec'), settings)
            self.assertEqual(settings['SENTRY_OPTIONS']['mail.from'], 'sentry@sentry.example.com')
            self.assertFalse(sentry.write_proxy_config(file, config))

    def test_nginx_preserves_https_and_http_with_safe_fallback_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'nginx.conf'
            file.write_text('http {\n    # keep this custom setting\n    proxy_set_header X-Forwarded-Proto $scheme;\n    server { listen 80; }\n}\n')
            self.assertTrue(sentry.write_nginx_config(file))
            rendered = file.read_text()
            self.assertIn('# keep this custom setting', rendered)
            self.assertIn('map $http_x_forwarded_proto $ai_support_sentry_forwarded_proto', rendered)
            self.assertIn('default $scheme;', rendered)
            self.assertIn('https https;', rendered)
            self.assertIn('http http;', rendered)
            self.assertIn('proxy_set_header X-Forwarded-Proto $ai_support_sentry_forwarded_proto;', rendered)
            self.assertNotIn('proxy_set_header X-Forwarded-Proto $scheme;', rendered)
            self.assertFalse(sentry.write_nginx_config(file))
            self.assertEqual(file.read_text(), rendered)

    def test_unrecognized_nginx_config_fails_without_overwriting_admin_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'nginx.conf'
            original = 'http {\n    proxy_set_header X-Forwarded-Proto https;\n}\n'
            file.write_text(original)
            with self.assertRaisesRegex(ValueError, 'Nginx'):
                sentry.write_nginx_config(file)
            self.assertEqual(file.read_text(), original)

    def test_public_config_generation_is_readable_under_protected_service_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'redis.conf'
            previous = os.umask(0o077)
            try:
                sentry.run([sys.executable, '-c',
                            'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("port 6379")', str(file)],
                           public_files=True)
                sentry.atomic_json(pathlib.Path(directory) / 'state.json', {'run_id': 'test'})
            finally:
                os.umask(previous)
            self.assertEqual(file.stat().st_mode & 0o777, 0o644)
            self.assertEqual((pathlib.Path(directory) / 'state.json').stat().st_mode & 0o777, 0o600)

    def test_public_health_rejects_https_downgrade(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.url = 'http://sentry.example.com/_health/'
        with patch.object(sentry.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'verification'):
                sentry.verify_url({'domain': 'sentry.example.com'})

    def test_incomplete_migration_requires_recovery(self):
        state = {'phase': 'installing', 'commit': sentry.COMMIT, 'profile': 'errors-only'}
        with self.assertRaisesRegex(ValueError, 'manual recovery'):
            sentry.check_resume(state, self.config())

    def test_profile_and_version_changes_are_rejected(self):
        for key, value in [('profile', 'feature-complete'), ('commit', 'old')]:
            state = {'phase': 'complete', 'commit': sentry.COMMIT, 'profile': 'errors-only'}
            state[key] = value
            with self.assertRaisesRegex(ValueError, 'change'):
                sentry.check_resume(state, self.config())

    def test_docker_shim_tags_both_direct_and_compose_run(self):
        label = 'ai.support.sentry.run=exec-1'
        self.assertEqual(sentry.tag_docker_args(['run', '--rm', 'busybox', 'true'], 'exec-1'),
                         ['run', '--label', label, '--rm', 'busybox', 'true'])
        self.assertEqual(sentry.tag_docker_args(['compose', '--ansi', 'never', 'run', '--rm', 'web', 'upgrade'], 'exec-1'),
                         ['compose', '--ansi', 'never', 'run', '--label', label, '--rm', 'web', 'upgrade'])
        self.assertEqual(sentry.tag_docker_args(['compose', 'up', '-d'], 'exec-1'), ['compose', 'up', '-d'])

    def test_unresolved_state_blocks_preceding_roles(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(sentry, 'ROOT', pathlib.Path(directory)), patch.object(sentry, 'active', return_value=False):
                sentry.save_state({'phase': 'installing', 'run_id': 'previous', 'settled': False})
                with self.assertRaisesRegex(ValueError, 'unresolved'):
                    sentry.preflight('install')
                sentry.preflight('diagnose')

    def test_stop_is_allowed_through_preflight_for_an_active_installer(self):
        with patch.object(sentry, 'state', return_value={'settled': False}), patch.object(sentry, 'active', return_value=True):
            sentry.preflight('stop')
            with self.assertRaises(ValueError):
                sentry.preflight('install')

    def test_stopping_another_execution_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(sentry, 'ROOT', pathlib.Path(directory)):
                sentry.save_state({'phase': 'installing', 'run_id': 'newer'})
                with self.assertRaisesRegex(ValueError, 'execution'):
                    sentry.stop('older')

    def test_new_execution_does_not_inherit_stop_confirmation_after_cleanup_failure(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(sentry, 'ROOT', pathlib.Path(directory) / 'state'), \
                patch.object(sentry, 'SOURCE', pathlib.Path(directory) / 'source'), \
                patch.object(sentry, 'active', return_value=False):
            sentry.save_state(dict(run_id='old', phase='prepared', settled=True,
                                  stop_state='confirmed', commit=sentry.COMMIT, profile='errors-only'))
            sentry.atomic_json(sentry.ROOT / 'config.json', self.config())
            with patch.object(sentry, 'requirements'), patch.object(sentry, 'run', return_value=''), \
                    patch.object(pathlib.Path, 'write_text'):
                sentry.main(['start', 'new'])
            self.assertEqual(sentry.state()['run_id'], 'new')
            self.assertNotEqual(sentry.public_state().get('stop_state'), 'confirmed')
            with patch.object(sentry, 'containers', return_value=['migration']), \
                    patch.object(sentry, 'run', side_effect=RuntimeError('Docker stop failed')):
                with self.assertRaises(RuntimeError):
                    sentry.cleanup('new')
            self.assertNotEqual(sentry.public_state().get('stop_state'), 'confirmed')
            self.assertFalse(sentry.public_state()['settled'])

    def test_cleanup_confirms_only_after_current_execution_containers_are_gone(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(sentry, 'ROOT', pathlib.Path(directory)), \
                patch.object(sentry, 'containers', side_effect=[['migration'], []]), \
                patch.object(sentry, 'run') as run, patch.object(sentry.time, 'sleep'):
            sentry.save_state(dict(run_id='new', phase='installing', settled=False))
            sentry.cleanup('new')
            run.assert_called_once_with(['/usr/bin/docker', 'stop', '--time', '60', 'migration'], timeout=70)
            self.assertEqual(sentry.public_state()['stop_state'], 'confirmed')
            self.assertFalse(sentry.public_state()['settled'])

    def test_diagnosis_recovers_an_attempt_before_state_or_source_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with patch.object(sentry, 'ROOT', root / 'state'), \
                    patch.object(sentry, 'SOURCE', root / 'source'), \
                    patch.object(sentry, 'active', return_value=False), \
                    patch('builtins.print') as output:
                sentry.main(['diagnose'])
                self.assertEqual(json.loads(output.call_args.args[0]),
                                 {'phase': 'absent', 'settled': True})
                self.assertFalse((root / 'state/state.json').exists())

    def test_missing_state_never_releases_an_existing_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'source').mkdir()
            with patch.object(sentry, 'ROOT', root / 'state'), \
                    patch.object(sentry, 'SOURCE', root / 'source'), \
                    patch.object(sentry, 'active', return_value=False):
                self.assertIs(sentry.public_state().get('settled'), False)
                with self.assertRaisesRegex(ValueError, 'manual recovery'):
                    sentry.main(['diagnose'])


if __name__ == '__main__':
    unittest.main()
