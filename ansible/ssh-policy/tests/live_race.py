#!/usr/bin/env python3
"""Concurrent confirm/recovery in a DISPOSABLE VM/container only.
Usage: python3 live_race.py HOST PRIVATE_KEY KNOWN_HOSTS [SSH_PORT] [COUNT]
Requires existing fixture policy live-policy and allows changing its SSH sources.
"""
import hashlib
import json
import secrets
import subprocess
import sys

host,key,known=sys.argv[1:4]
port=int(sys.argv[4]) if len(sys.argv)>4 else 22
ssh=['ssh','-p',str(port),'-i',key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+known,'-o','ConnectTimeout=10','root@'+host]
helper='/usr/bin/python3 /usr/local/lib/ai-support-agent/ssh-policy.py '
def remote(command,p=None):
 r=subprocess.run(ssh+[command],input=json.dumps(p) if p is not None else '',text=True,capture_output=True,timeout=120)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout
def call(action,p):return json.loads(remote(helper+action+' "$SSH_CONNECTION"',p))
source=remote('printf "%s" "$SSH_CONNECTION"').split()[0]
results=[]
for index in range(int(sys.argv[5]) if len(sys.argv)>5 else 4):
 nonce=secrets.token_hex(32)
 new_ip='192.0.2.'+str(20+index)
 p=dict(attemptId='live-race-'+secrets.token_hex(6),policyId='live-policy',policyVersion=10+index,definitionVersion=7+index,sshHostId='fixture',port=port,username='root',cidrs=[source+'/32',new_ip+'/32','2001:db8::/64'],release=False,keyOnly=True,manageSources=True,nonceHash=hashlib.sha256(nonce.encode()).hexdigest())
 i=call('inspect',p);p.update(machineId=i['machineId'],expectedRemovedRules=i['removedRules'])
 assert call('apply',p)['status']=='pending'
 confirm=dict(attemptId=p['attemptId'],policyVersion=p['policyVersion'],definitionVersion=p['definitionVersion'],machineId=i['machineId'],nonce=nonce)
 calls=[(helper+'confirm "$SSH_CONNECTION"',json.dumps(confirm)),(helper+'recover '+p['attemptId'],'')]
 if index%2:calls.reverse()
 processes=[]
 for command,data in calls:
  proc=subprocess.Popen(ssh+[command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  proc.stdin.write(data);proc.stdin.close();proc.stdin=None;processes.append(proc)
 for proc in processes:proc.communicate(timeout=120)
 state=call('status',{'attemptId':p['attemptId']})
 assert state['status'] in ('succeeded','recovered'),state
 rules=remote('ufw status')
 assert (new_ip in rules)==(state['status']=='succeeded'),(state,rules)
 results.append(state['status'])
 print('PASS confirm/recover race',index,state['status'],'matches actual firewall',flush=True)
print('PASS all settled attempts consistent',results,flush=True)
