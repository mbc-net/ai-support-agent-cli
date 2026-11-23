#!/usr/bin/env python3
"""Disposable systemd container validation. NEVER run against a production server.
Usage (inside isolated client container): python3 live_container.py HOST KEY KNOWN_HOSTS [SSH_PORT]
The fixture must already have active stock UFW, broad 22/tcp and unrelated 443/tcp.
"""
import hashlib
import json
import secrets
import subprocess
import sys

host, key, known = sys.argv[1:4]
port = int(sys.argv[4]) if len(sys.argv) > 4 else 22
ssh = ['ssh','-p',str(port),'-i',key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+known,'-o','ConnectTimeout=5','root@'+host]
helper = '/usr/bin/python3 /usr/local/lib/ai-support-agent/ssh-policy.py '

def remote(command, payload=None):
    result = subprocess.run(ssh+[command],input=json.dumps(payload) if payload is not None else '',text=True,capture_output=True,timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout

def invoke(action, payload):
    return json.loads(remote(helper+action+' "$SSH_CONNECTION"',payload))

source = remote('printf "%s" "$SSH_CONNECTION"').split()[0]
nonce = secrets.token_hex(32)
request = dict(attemptId='live-adopt',policyId='live-policy',policyVersion=1,definitionVersion=1,sshHostId='fixture',port=port,username='root',cidrs=[source+'/32','2001:db8::/64'],release=False,keyOnly=True,manageSources=True,nonceHash=hashlib.sha256(nonce.encode()).hexdigest())
inspection = invoke('inspect',request)
assert len(inspection['removedRules']) == 2, inspection
request.update(expectedRemovedRules=inspection['removedRules'],machineId=inspection['machineId'])
assert invoke('apply',request)['status'] == 'pending'
confirmation = dict(attemptId=request['attemptId'],policyVersion=1,definitionVersion=1,machineId=inspection['machineId'],nonce=nonce)
assert invoke('confirm',confirmation)['observedSourceIp'] == source
rules = remote('ufw status')
assert '443/tcp' in rules and '2001:db8::/64' in rules and source in rules, rules
assert not any(str(port)+'/tcp' in line and 'Anywhere' in line for line in rules.splitlines()), rules
print('PASS IPv4/IPv6 broad-rule adoption, unrelated 443 preserved, fresh SSH confirmation',flush=True)

# The old preview is intentionally retained: automatic update checks exact
# previously applied rules, not the original broad allow-list.
request.update(attemptId='live-autosync',policyVersion=2,definitionVersion=2,cidrs=[source+'/32','192.0.2.1/32','2001:db8::/64'])
assert invoke('inspect',request)['managedRules']
assert invoke('apply',request)['status']=='pending'
confirmation.update(attemptId=request['attemptId'],policyVersion=2,definitionVersion=2)
assert invoke('confirm',confirmation)['status']=='succeeded'
print('PASS automatic policy revision follows persisted managed rules',flush=True)

request.update(attemptId='live-release-recover',policyVersion=3,definitionVersion=2,cidrs=[],release=True)
assert invoke('apply',request)['status']=='pending'
# Exercise the exact installed timer service executable, without waiting ten
# minutes. Full wall-clock expiry and host reboot remain VM validation cases.
remote('systemctl start ai-support-agent-ssh-policy-live-release-recover.service')
assert invoke('status',{'attemptId':request['attemptId']})['status']=='recovered'
assert invoke('apply',request)['status']=='recovered'
rules = remote('ufw status')
assert source in rules and '192.0.2.1' in rules and '443/tcp' in rules
remote('test -f /var/lib/ai-support-agent/ssh-policy/managed.json')
print('PASS timer-service rollback retains policy and does not reapply recovered attempt',flush=True)

request.update(attemptId='live-release-success',policyVersion=4)
inspection = invoke('inspect',request)
request['expectedRemovedRules'] = inspection['removedRules']
assert invoke('apply',request)['status']=='pending'
confirmation.update(attemptId=request['attemptId'],policyVersion=4)
assert invoke('confirm',confirmation)['status']=='succeeded'
remote('test ! -e /var/lib/ai-support-agent/ssh-policy/managed.json')
assert 'Anywhere' in remote('ufw status')
print('PASS successful explicit release clears managed marker',flush=True)

before = remote('cat /etc/ufw/user.rules /etc/ufw/user6.rules')
request.update(attemptId='live-key-only',policyVersion=5,release=False,manageSources=False,expectedRemovedRules=[])
assert invoke('apply',request)['status']=='pending'
confirmation.update(attemptId=request['attemptId'],policyVersion=5)
assert invoke('confirm',confirmation)['status']=='succeeded'
assert remote('cat /etc/ufw/user.rules /etc/ufw/user6.rules') == before
print('PASS key-only mode leaves firewall bytes unchanged',flush=True)
