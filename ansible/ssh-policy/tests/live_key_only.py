#!/usr/bin/env python3
"""Retry independent key-only validation on a NEW disposable-fixture attempt.
Usage: python3 live_key_only.py HOST KEY KNOWN_HOSTS [SSH_PORT]
"""
import hashlib
import json
import secrets
import subprocess
import sys

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

assert call('status', {'attemptId':'live-key-only'})['status'] == 'recovered'
before = remote('cat /etc/ufw/user.rules /etc/ufw/user6.rules')
nonce = secrets.token_hex(32)
request = dict(attemptId='live-key-only-new-attempt', policyId='live-policy', policyVersion=6,
               definitionVersion=3, sshHostId='fixture', port=port, username='root',
               cidrs=[], release=False, keyOnly=True, manageSources=False,
               nonceHash=hashlib.sha256(nonce.encode()).hexdigest(), expectedRemovedRules=[])
inspection = call('inspect', request)
request['machineId'] = inspection['machineId']
assert call('apply', request)['status'] == 'pending'
assert call('confirm', dict(attemptId=request['attemptId'], policyVersion=6,
            definitionVersion=3, machineId=inspection['machineId'], nonce=nonce))['status'] == 'succeeded'
assert remote('cat /etc/ufw/user.rules /etc/ufw/user6.rules') == before
print('PASS failed verification recovered; new key-only attempt confirmed; firewall bytes unchanged', flush=True)
