#!/usr/bin/python3
"""Root-owned Sentry installation supervisor. Never prints configuration or subprocess output.

State is a recovery guard, not proof that a database migration can be replayed.
An interrupted installer always requires operator recovery. No rollback or volume deletion.
"""
import contextlib
import fcntl
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path('/var/lib/ai-support-sentry')
SOURCE = pathlib.Path('/opt/ai-support-sentry')
SCRIPT = '/usr/local/lib/ai-support-sentry/sentry_setup.py'
UNIT = 'ai-support-sentry-install.service'
VERSION = '26.9.0'
COMMIT = '667094ad0b11bb27e6380fc757754c66516b59b4'
PROJECT = 'ai-support-sentry'
LABEL = 'ai.support.sentry.run'
FQDN = re.compile(r'(?=.{1,253}\Z)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\Z')
EMAIL = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}\Z')


def run(args, *, data=None, cwd=None, timeout=300, env=None, public_files=False):
    # Callers receive only a fixed stage name on error. Docker/Sentry errors may contain secrets.
    result = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=cwd, timeout=timeout, env=env,
                            umask=0o022 if public_files else -1)
    if result.returncode:
        raise RuntimeError('Command failed during ' + pathlib.Path(args[0]).name)
    return result.stdout.strip()


def atomic_json(file, value):
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = file.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    os.chmod(file, 0o600)


def state():
    file = ROOT / 'state.json'
    return json.loads(file.read_text()) if file.exists() else {}


def save_state(value):
    atomic_json(ROOT / 'state.json', value)


def validate_config(c):
    if c.get('profile') not in ('errors-only', 'feature-complete'):
        raise ValueError('Invalid profile')
    if c.get('proxy_mode') not in ('external', 'caddy'):
        raise ValueError('Invalid proxy_mode')
    if not isinstance(c.get('domain'), str) or not FQDN.fullmatch(c['domain']):
        raise ValueError('Invalid domain')
    for name in ('admin_email', 'acme_email', 'mail_from'):
        value = c.get(name, '')
        if not isinstance(value, str) or (value and not EMAIL.fullmatch(value)):
            raise ValueError('Invalid ' + name)
    if not c.get('admin_email') or not isinstance(c.get('admin_password'), str) or len(c['admin_password']) < 12:
        raise ValueError('Administrator email and password (12+ characters) required')
    for key, low, high in [('retention_days', 1, 365), ('smtp_port', 1, 65535)]:
        if type(c.get(key)) is not int or not low <= c[key] <= high:
            raise ValueError('Invalid ' + key)
    if type(c.get('smtp_tls')) is not bool:
        raise ValueError('Invalid smtp_tls')
    host = c.get('smtp_host', '')
    if not isinstance(host, str) or (host and not FQDN.fullmatch(host)):
        raise ValueError('Invalid smtp_host')
    for key in ('smtp_user', 'smtp_password'):
        if not isinstance(c.get(key), str) or '\x00' in c[key]:
            raise ValueError('Invalid ' + key)
    if c['proxy_mode'] == 'caddy' and not c.get('acme_email'):
        raise ValueError('acme_email required for automatic HTTPS')


def launchpad_secret():
    file = ROOT / 'launchpad-secret.json'
    if not file.exists():
        atomic_json(file, {'secret': secrets.token_hex(32)})
    value = json.loads(file.read_text()).get('secret')
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
        raise ValueError('Invalid stored Launchpad secret; manual recovery required')
    return value


def render_env(c, rpc_secret):
    # Only enums, a validated integer and literals. This file is sourced by upstream bash.
    if not re.fullmatch(r'[a-f0-9]{64}', rpc_secret):
        raise ValueError('Invalid Launchpad secret')
    return '\n'.join(['COMPOSE_PROJECT_NAME=' + PROJECT,
                      'COMPOSE_PROFILES=' + c['profile'],
                      'SENTRY_BIND=127.0.0.1:9000',
                      'LAUNCHPAD_RPC_SHARED_SECRET=' + rpc_secret,
                      'SENTRY_EVENT_RETENTION_DAYS=' + str(c['retention_days']), ''])


def render_config(c):
    # JSON is a YAML subset: secrets stay data, including quotes, newlines and dollar signs.
    values = {'system.url-prefix': 'https://' + c['domain'],
              'system.internal-url-prefix': 'http://web:9000',
              'mail.backend': 'smtp' if c['smtp_host'] else 'dummy'}
    if c['smtp_host']:
        values.update({'mail.host': c['smtp_host'], 'mail.port': c['smtp_port'],
                       'mail.username': c['smtp_user'], 'mail.password': c['smtp_password'],
                       'mail.use-tls': c['smtp_tls'], 'mail.use-ssl': False})
        if c['mail_from']:
            values['mail.from'] = c['mail_from']
    return json.dumps(values)


def write_sentry_config(file, c):
    # PyYAML ships with the Ansible target dependency installed by this role.
    import yaml
    existing = yaml.safe_load(file.read_text()) if file.exists() else {}
    existing = existing or {}
    key = existing.get('system.secret-key')
    if not key or key == '!!changeme!!':
        key = secrets.token_urlsafe(64)
    existing.update(json.loads(render_config(c)))
    existing['system.secret-key'] = key
    # Do not retain stale SMTP credentials when email is disabled.
    if not c['smtp_host']:
        for name in list(existing):
            if name.startswith('mail.') and name != 'mail.backend':
                del existing[name]
    atomic_json(file, existing)
    # The pinned Sentry image drops to UID/GID 999 before loading configuration.
    # Keep secrets owner-only; the root-owned SOURCE parent remains 0700 on the host.
    os.chown(file, 999, 999)


def write_proxy_config(file, c):
    # Append managed settings after upstream defaults, preserving administrator edits.
    begin = '# BEGIN AI SUPPORT SENTRY HTTPS\n'
    end = '# END AI SUPPORT SENTRY HTTPS\n'
    original = file.read_text()
    block = (begin + "SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')\n"
             'USE_X_FORWARDED_HOST = True\nSESSION_COOKIE_SECURE = True\n'
             'CSRF_COOKIE_SECURE = True\nSOCIAL_AUTH_REDIRECT_IS_HTTPS = True\n'
             'CSRF_TRUSTED_ORIGINS = ' + repr(['https://' + c['domain']]) + '\n'
             # Upstream sentry.conf.py takes precedence over config.yml for mail.from.
             'SENTRY_OPTIONS["mail.from"] = ' + repr(c['mail_from'] or 'sentry@' + c['domain']) + '\n' + end)
    if begin in original or end in original:
        if original.count(begin) != 1 or original.count(end) != 1 or original.index(begin) > original.index(end):
            raise ValueError('Invalid managed HTTPS configuration block; manual recovery required')
        updated = original[:original.index(begin)] + block + original[original.index(end) + len(end):]
    else:
        updated = original.rstrip('\n') + '\n\n' + block
    if updated == original:
        return False
    file.write_text(updated)
    os.chmod(file, 0o644)
    return True


def write_nginx_config(file):
    # The bundled listener is loopback-only, behind a trusted HTTPS proxy.
    # Accept only HTTP/HTTPS; missing or malformed forwarding headers use the local scheme.
    original = file.read_text()
    old_header = 'proxy_set_header X-Forwarded-Proto $scheme;'
    new_header = 'proxy_set_header X-Forwarded-Proto $ai_support_sentry_forwarded_proto;'
    block = ('\n\t# BEGIN AI SUPPORT SENTRY FORWARDED PROTO\n'
             '\tmap $http_x_forwarded_proto $ai_support_sentry_forwarded_proto {\n'
             '\t\tdefault $scheme;\n\t\thttps https;\n\t\thttp http;\n\t}\n'
             '\t# END AI SUPPORT SENTRY FORWARDED PROTO\n')
    if original.count(new_header) == 1 and original.count(block) == 1 and old_header not in original:
        return False
    if (original.count(old_header) != 1 or original.count('http {') != 1
            or 'ai_support_sentry_forwarded_proto' in original
            or 'AI SUPPORT SENTRY FORWARDED PROTO' in original):
        raise ValueError('Unrecognized Nginx configuration; manual recovery required')
    updated = original.replace('http {', 'http {' + block, 1).replace(old_header, new_header, 1)
    file.write_text(updated)
    os.chmod(file, 0o644)
    return True


def active():
    value = subprocess.run(['systemctl', 'show', '--property=ActiveState', '--value', UNIT],
                           text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return value.stdout.strip() in ('active', 'activating', 'deactivating')


def preflight(operation):
    previous = state()
    if active() and operation != 'stop':
        raise ValueError('Sentry installation is already active')
    if previous and not previous.get('settled', False) and operation not in ('diagnose', 'stop'):
        raise ValueError('Sentry state unresolved; run diagnose/stop and perform manual recovery')


def check_resume(previous, c):
    if not previous:
        return
    if previous.get('commit') != COMMIT or previous.get('profile') != c['profile']:
        raise ValueError('Sentry version/profile change is not supported')
    if previous.get('phase') not in ('prepared', 'installed', 'complete'):
        raise ValueError('Interrupted installation requires manual recovery')


def tag_docker_args(args, run_id):
    args = list(args)
    if args and args[0] in ('run', 'create'):
        args[1:1] = ['--label', LABEL + '=' + run_id]
    elif args and args[0] == 'compose' and 'run' in args:
        index = args.index('run') + 1
        args[index:index] = ['--label', LABEL + '=' + run_id]
    return args


@contextlib.contextmanager
def lock(wait=False):
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT / 'lock').open('a') as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except BlockingIOError:
            raise ValueError('Sentry operation already in progress')
        yield


def compose(*args, data=None, env=None, timeout=300):
    return run(['/usr/local/lib/ai-support-sentry/bin/docker', 'compose',
                '--project-name', PROJECT, '--env-file', '.env.custom', *args],
               cwd=SOURCE, data=data, env=env, timeout=timeout)


def requirements(c):
    if not pathlib.Path('/run/systemd/system').exists():
        raise ValueError('A systemd Ubuntu VPS is required')
    mem = int(re.search(r'MemTotal:\s+(\d+)', pathlib.Path('/proc/meminfo').read_text())[1]) // 1024
    cpu, ram = (2, 7000) if c['profile'] == 'errors-only' else (4, 14000)
    if (os.cpu_count() or 0) < cpu or mem < ram:
        raise ValueError('Insufficient CPU or memory for selected Sentry profile')
    if shutil.disk_usage('/opt').free < 20 * 1024**3:
        raise ValueError('At least 20 GiB free disk required (production needs additional event capacity)')
    if c['proxy_mode'] == 'caddy' and not (ROOT / 'caddy-managed').exists():
        if pathlib.Path('/etc/caddy/Caddyfile').exists() or run(['ss', '-H', '-ltn', '( sport = :80 or sport = :443 )']):
            raise ValueError('Existing proxy detected; use external proxy mode')
    version = run(['/usr/bin/docker', 'compose', 'version', '--short'])
    match = re.match(r'v?(\d+)\.(\d+)\.(\d+)', version)
    if not match or tuple(map(int, match.groups())) < (2, 32, 2):
        raise ValueError('Docker Compose >= 2.32.2 required')


def verify_url(c, external=True):
    url = ('https://' + c['domain']) if external else 'http://127.0.0.1:9000'
    # Certificate validation stays enabled; reject redirects to a different origin.
    with urllib.request.urlopen(url + '/_health/', timeout=20) as response:
        from urllib.parse import urlsplit
        if (response.status != 200 or urlsplit(response.url).netloc != urlsplit(url).netloc
                or urlsplit(response.url).scheme != urlsplit(url).scheme):
            raise ValueError('Sentry health verification failed')


def install_caddy(c):
    # Dedicated-host mode only. Never replace an existing administrator-owned Caddyfile.
    file = pathlib.Path('/etc/caddy/Caddyfile')
    owned = ROOT / 'caddy-managed'
    if not owned.exists():
        if file.exists() or run(['ss', '-H', '-ltn', '( sport = :80 or sport = :443 )']):
            raise ValueError('Existing proxy detected; use external proxy mode')
        run(['apt-get', 'update'])
        run(['apt-get', 'install', '-y', 'caddy'])
    text = '{\n email ' + c['acme_email'] + '\n}\n' + c['domain'] + ' {\n reverse_proxy 127.0.0.1:9000\n}\n'
    candidate = ROOT / 'Caddyfile'
    candidate.write_text(text)
    run(['caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'])
    file.write_text(text)
    os.chmod(file, 0o644)
    owned.touch(mode=0o600)
    run(['systemctl', 'enable', '--now', 'caddy'])
    run(['systemctl', 'reload', 'caddy'])


ADMIN_SCRIPT = '''import json, sys
from sentry.users.models.user import User
from sentry.runner.commands.createuser import createuser
d = json.load(sys.stdin)
u = User.objects.filter(username=d['email']).first()
if u is not None:
    if not (u.is_active and u.is_superuser and u.is_staff):
        raise RuntimeError('Existing account is not an active administrator')
else:
    createuser.main(['--email', d['email'], '--password', d['password'], '--superuser', '--no-input'], standalone_mode=False)
'''


def worker(run_id):
    with lock(wait=True):
        c = json.loads((ROOT / 'config.json').read_text())
        validate_config(c)
        previous = state()
        check_resume(previous, c)
        requirements(c)
        current = dict(previous, run_id=run_id, commit=COMMIT, profile=c['profile'], settled=False)
        save_state(current)
        env = dict(os.environ, PATH='/usr/local/lib/ai-support-sentry/bin:' + os.environ['PATH'],
                   SENTRY_JOB_ID=run_id, REPORT_SELF_HOSTED_ISSUES='0',
                   APPLY_AUTOMATIC_CONFIG_UPDATES='0', SKIP_USER_CREATION='1')
        try:
            if not SOURCE.exists():
                # Do not adopt existing upstream volumes or published services.
                volumes = run(['/usr/bin/docker', 'volume', 'ls', '--format', '{{.Name}}'])
                if any(name.startswith('sentry-') or name.startswith(PROJECT) for name in volumes.splitlines()):
                    raise ValueError('Existing Sentry volumes detected; importing installations is unsupported')
                if run(['ss', '-H', '-ltn', 'sport = :9000']):
                    raise ValueError('Port 9000 is already in use')
                run(['git', 'clone', '--no-checkout', 'https://github.com/getsentry/self-hosted.git', str(SOURCE)],
                    public_files=True)
                os.chmod(SOURCE, 0o700)
                run(['git', 'checkout', '--detach', COMMIT], cwd=SOURCE, public_files=True)
                current['phase'] = 'prepared'
                save_state(current)
            elif not previous:
                raise ValueError('Unmanaged Sentry installation; refusing overwrite')
            if not (current.get('phase') == 'prepared' and not SOURCE.exists()) and run(['git', 'rev-parse', 'HEAD'], cwd=SOURCE) != COMMIT:
                raise ValueError('Sentry source commit mismatch')
            # Never git reset: preserve existing instance configuration and keys.
            env_file = SOURCE / '.env.custom'
            env_text = (SOURCE / '.env').read_text() + '\n' + render_env(c, launchpad_secret())
            config_changed = not env_file.exists() or env_file.read_text() != env_text
            env_file.write_text(env_text)
            os.chmod(SOURCE / '.env.custom', 0o600)
            config = SOURCE / 'sentry/config.yml'
            if not config.exists():
                shutil.copyfile(SOURCE / 'sentry/config.example.yml', config)
            old_config = config.read_text()
            write_sentry_config(config, c)
            config_changed = config_changed or old_config != config.read_text()
            proxy_config = SOURCE / 'sentry/sentry.conf.py'
            if not proxy_config.exists():
                shutil.copyfile(SOURCE / 'sentry/sentry.conf.example.py', proxy_config)
            proxy_changed = write_proxy_config(proxy_config, c)
            config_changed = config_changed or proxy_changed
            nginx_changed = write_nginx_config(SOURCE / 'nginx.conf')
            config_changed = config_changed or nginx_changed
            # Upstream Dockerfile COPY . must never bake live credentials into an image layer.
            ignore = SOURCE / 'sentry/.dockerignore'
            ignore_text = ignore.read_text() if ignore.exists() else ''
            if '\nconfig.yml\n' not in '\n' + ignore_text:
                ignore.write_text(ignore_text + '\nconfig.yml\n')
            if current.get('phase') == 'prepared':
                current['phase'] = 'installing'
                save_state(current)
                run(['bash', './install.sh', '--skip-user-creation', '--no-report-self-hosted-issues',
                     '--no-apply-automatic-config-updates'], cwd=SOURCE, env=env, timeout=3500,
                    public_files=True)
                current['phase'] = 'installed'
                save_state(current)
            recreate = ['--force-recreate'] if previous.get('phase') == 'complete' and config_changed else []
            compose('up', '-d', *recreate, '--wait', '--wait-timeout', '300', env=env, timeout=360)
            compose('run', '--rm', '-T', 'web', 'exec', '-c', ADMIN_SCRIPT,
                    data=json.dumps({'email': c['admin_email'], 'password': c['admin_password']}), env=env)
            verify_url(c, external=False)
            if c['proxy_mode'] == 'caddy':
                install_caddy(c)
                for attempt in range(12):
                    try:
                        verify_url(c)
                        break
                    except Exception:
                        if attempt == 11:
                            raise
                        time.sleep(5)
            current.update(phase='complete', settled=True,
                           publication='verified' if c['proxy_mode'] == 'caddy' else 'pending')
            save_state(current)
        except Exception:
            # Preserve the last durable phase. In particular, do not mark interrupted migrations retryable.
            current.update(settled=False, error='Installation failed; diagnose before retrying')
            save_state(current)
            raise
        finally:
            # Initial administrator password is no longer needed after this attempt.
            (ROOT / 'config.json').unlink(missing_ok=True)


def containers(run_id):
    return run(['/usr/bin/docker', 'ps', '-q', '--filter', 'label=' + LABEL + '=' + run_id]).splitlines()


def cleanup(run_id):
    previous = state()
    if previous.get('run_id') != run_id:
        raise ValueError('Refusing cleanup of another execution')
    for container in containers(run_id):
        run(['/usr/bin/docker', 'stop', '--time', '60', container], timeout=70)
    time.sleep(1)
    if containers(run_id):
        raise ValueError('Remote termination unconfirmed')
    (ROOT / 'config.json').unlink(missing_ok=True)
    previous = state()
    if not previous.get('settled'):
        previous['stop_state'] = 'confirmed'
        save_state(previous)


def stop(run_id):
    previous = state()
    if previous.get('run_id') != run_id:
        raise ValueError('Refusing to stop another execution')
    run(['systemctl', 'stop', UNIT], timeout=310)
    for container in containers(run_id):
        run(['/usr/bin/docker', 'stop', '--time', '60', container], timeout=70)
    if active() or containers(run_id):
        raise ValueError('Remote termination unconfirmed')
    previous = state()
    # Stopped does not imply the database is safe to migrate again.
    previous['stop_state'] = 'confirmed'
    previous['settled'] = previous.get('phase') == 'complete'
    save_state(previous)
    return previous


def public_state():
    current = state()
    if not current:
        # A failed attempt may copy the supervisor before start creates state.
        # Missing state on an existing installation is not proof of safety.
        return {'phase': 'unmanaged' if SOURCE.exists() else 'absent',
                'settled': not SOURCE.exists() and not active()}
    return {key: current[key] for key in ('run_id', 'phase', 'settled', 'publication', 'stop_state') if key in current}


def main(args):
    operation = args[0]
    if operation == 'docker':
        run_id = os.environ.get('SENTRY_JOB_ID', '')
        if not re.fullmatch(r'[A-Za-z0-9-]{1,80}', run_id):
            raise ValueError('Missing installer execution id')
        os.execv('/usr/bin/docker', ['/usr/bin/docker', *tag_docker_args(args[1:], run_id)])
        return
    if operation == 'worker':
        worker(args[1])
    elif operation == 'cleanup':
        cleanup(args[1])
    elif operation == 'preflight':
        preflight(args[1])
    elif operation == 'start':
        run_id = args[1]
        if not re.fullmatch(r'[A-Za-z0-9-]{1,80}', run_id):
            raise ValueError('Invalid execution id')
        with lock():
            preflight('install')
            config = json.loads((ROOT / 'config.json').read_text())
            validate_config(config)
            previous = state()
            check_resume(previous, config)
            requirements(config)
            if SOURCE.exists() and not previous:
                raise ValueError('Unmanaged Sentry installation; refusing overwrite')
            current = dict(previous, run_id=run_id, phase=previous.get('phase', 'prepared'),
                           commit=COMMIT, profile=config['profile'], settled=False)
            # Termination proof belongs to an execution, never to its successor.
            current.pop('stop_state', None)
            save_state(current)
            unit = ('[Unit]\nDescription=AI Support Sentry installer\nAfter=docker.service network-online.target\n'
                    '[Service]\nType=exec\nRestart=no\nRuntimeMaxSec=3600\nTimeoutStopSec=300\n'
                    'KillMode=control-group\nUMask=0077\nStandardOutput=null\nStandardError=null\n'
                    'ExecStart=/usr/bin/python3 ' + SCRIPT + ' worker ' + run_id + '\n'
                    'ExecStopPost=/usr/bin/python3 ' + SCRIPT + ' cleanup ' + run_id + '\n')
            pathlib.Path('/etc/systemd/system/' + UNIT).write_text(unit)
            run(['systemctl', 'daemon-reload'])
            # Queue while holding the lock; worker obtains it after start exits.
            run(['systemctl', 'start', '--no-block', UNIT])
    elif operation == 'status':
        print(json.dumps(dict(public_state(), active=active())))
        return
    elif operation == 'stop':
        target = args[1] if len(args) > 1 else state().get('run_id')
        if target:
            stop(target)
    elif operation == 'diagnose':
        if active():
            raise ValueError('Installer is still active; stop it first')
        current = state()
        if not current and SOURCE.exists():
            raise ValueError('Sentry source exists without state; manual recovery required')
        if current.get('run_id') and containers(current['run_id']):
            raise ValueError('Installer containers are still running; stop them first')
        if current.get('phase') == 'complete':
            # Do not require or load administrator/SMTP credentials for diagnosis.
            verify_url({}, external=False)
            current['settled'] = True
            save_state(current)
        elif current.get('phase') in ('prepared', 'installed'):
            if not (current.get('phase') == 'prepared' and not SOURCE.exists()) and run(['git', 'rev-parse', 'HEAD'], cwd=SOURCE) != COMMIT:
                raise ValueError('Source verification failed; manual recovery required')
            # prepared precedes migrations; installed is written only after install.sh exits zero.
            current['settled'] = True
            save_state(current)
        elif current:
            raise ValueError('Interrupted installation requires manual recovery; no automatic migration retry')
    elif operation == 'verify':
        preflight('verify')
        c = json.loads((SOURCE / 'sentry/config.yml').read_text())
        domain = c['system.url-prefix'].removeprefix('https://')
        if not FQDN.fullmatch(domain):
            raise ValueError('Invalid installed public URL')
        verify_url({'domain': domain})
        current = state()
        current['publication'] = 'verified'
        save_state(current)
    else:
        raise ValueError('Unknown operation')
    print(json.dumps(public_state()))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        # Our validation errors contain field names, never configuration values.
        print(str(error) if isinstance(error, ValueError) else 'Sentry operation failed; inspect protected host state', file=sys.stderr)
        sys.exit(1)
