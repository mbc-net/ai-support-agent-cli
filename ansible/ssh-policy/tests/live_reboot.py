#!/usr/bin/env python3
"""DISPOSABLE guest reboot validation after live_container.py.
Usage: python3 live_reboot.py HOST KEY KNOWN_HOSTS [SSH_PORT]
"""
import hashlib
import json
import secrets
import subprocess
import sys
import time

host, key, known = sys.argv[1:4]
port = int(sys.argv[4]) if len(sys.argv) > 4 else 22
ssh = ['ssh', '-p', str(port), '-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile='+known, '-o', 'ConnectTimeout=5', 'root@'+host]
helper = '/usr/bin/python3 /usr/local/lib/ai-support-agent/ssh-policy.py '

def remote(command, payload=None):
    result = subprocess.run(ssh+[command], input=json.dumps(payload) if payload is not None else '', text=True, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout

def call(action, payload):
    return json.loads(remote(helper+action+' "$SSH_CONNECTION"', payload))

source = remote('printf "%s" "$SSH_CONNECTION"').split()[0]
before = remote('cat /proc/sys/kernel/random/boot_id').strip()
nonce = secrets.token_hex(32)
request = dict(attemptId='live-guest-reboot', policyId='live-policy', policyVersion=8,
               definitionVersion=5, sshHostId='fixture', port=port, username='root',
               cidrs=[source+'/32', '2001:db8::/64'], release=False, keyOnly=True,
               manageSources=True, nonceHash=hashlib.sha256(nonce.encode()).hexdigest())
inspection = call('inspect', request)
request.update(machineId=inspection['machineId'], expectedRemovedRules=inspection['removedRules'])
assert call('apply', request)['status'] == 'pending'
print('PASS pending transaction persisted before real guest reboot', before, flush=True)
try:
    remote('systemctl reboot')
except RuntimeError:
    pass
for _ in range(90):
    time.sleep(3)
    try:
        after = remote('cat /proc/sys/kernel/random/boot_id').strip()
        if after == before:
            continue
        state = call('status', {'attemptId': request['attemptId']})
        if state['status'] == 'recovered':
            print('PASS real guest boot ID changed and boot service recovered', after, flush=True)
            break
    except (RuntimeError, subprocess.TimeoutExpired):
        pass
else:
    raise RuntimeError('Guest reboot recovery did not finish')
assert call('apply', request)['status'] == 'recovered'
print('PASS recovered reboot attempt replay does not reapply', flush=True)

# A newly approved version may still proceed after a recovered attempt.
request.update(attemptId='live-after-guest-reboot', policyVersion=9, definitionVersion=6)
inspection = call('inspect', request)
request.update(expectedRemovedRules=inspection['removedRules'])
assert call('apply', request)['status'] == 'pending'
proof = dict(attemptId=request['attemptId'], policyVersion=9, definitionVersion=6,
             machineId=inspection['machineId'], nonce=nonce)
assert call('confirm', proof)['status'] == 'succeeded'
assert call('status', {'attemptId': request['attemptId']})['status'] == 'succeeded'
print('PASS new version after recovery and lost-result receipt reconciliation', flush=True)
