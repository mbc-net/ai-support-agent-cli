#!/usr/bin/env python3
"""DISPOSABLE systemd target only: temporarily restarts ssh.service with custom flags."""
import importlib.util
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location('policy', '/usr/local/lib/ai-support-agent/ssh-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
override = Path('/etc/systemd/system/ssh.service.d/10-source-ip-validation.conf')
assert not override.exists(), 'Fixture override already exists'
override.parent.mkdir(exist_ok=True)
policy.require_standard_ssh_service()
defaults = Path('/etc/default/ssh')
original_defaults = defaults.read_bytes()
cases = [
    None,
    '[Service]\nExecStart=\nExecStart=/usr/sbin/sshd -D -o AuthenticationMethods=any -o PasswordAuthentication=yes\n',
    '[Service]\nExecReload=\nExecReload=/bin/true\n',
]
try:
    for case in cases:
        if case is None:
            defaults.write_text('SSHD_OPTS="-o AuthenticationMethods=any -o PasswordAuthentication=yes"\n')
        else:
            defaults.write_bytes(original_defaults)
            override.write_text(case)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'restart', 'ssh'], check=True)
        pid = subprocess.check_output(['systemctl','show','ssh.service','--property=MainPID','--value'], text=True).strip()
        arguments = (Path('/proc') / pid / 'cmdline').read_bytes()
        if case is None or 'ExecStart=' in case:
            assert b'AuthenticationMethods=any' in arguments
        try:
            policy.require_standard_ssh_service()
        except ValueError:
            print('PASS actual custom daemon options rejected:', 'SSHD_OPTS' if case is None else ('ExecReload' if 'ExecReload=' in case else 'ExecStart'), flush=True)
        else:
            raise AssertionError('Custom daemon options were accepted')
finally:
    defaults.write_bytes(original_defaults)
    override.unlink(missing_ok=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'restart', 'ssh'], check=True)
policy.require_standard_ssh_service()
print('PASS standard SSH daemon restored and accepted', flush=True)
