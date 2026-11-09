"""Destructive LOCAL fixture: run only in the dedicated disposable native-test container.
Requires the native test server, /work roles, recipe path argument, installed Agent2.
Never run on a VPS. No credentials or PSKs are printed.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request
import yaml

assert os.environ.get('ZABBIX_PSK_TEST_ALLOW_LOCAL') == 'yes', 'Dedicated disposable fixture only'
assert Path('/.dockerenv').exists(), 'Dedicated container required'
recipe = yaml.safe_load(Path(sys.argv[1]).read_text())
api_url = 'http://127.0.0.1:8080/api_jsonrpc.php'
token = None

def api(method, params):
    req = urllib.request.Request(api_url, json.dumps({'jsonrpc':'2.0', 'id':1, 'method':method, 'params':params}).encode(), {'Content-Type':'application/json'})
    if token: req.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req, timeout=20) as response: result = json.load(response)
    assert 'error' not in result, 'Fixture API rejected ' + method
    return result['result']

native = yaml.safe_load(Path('/work/tests/zabbix-native.yml').read_text())[0]['vars']
token = api('user.login', {'username':'Admin', 'password': native['zn_p2']})
binding = 'fixture-' + secrets.token_hex(6)
psk = secrets.token_hex(32)
identity = binding
hostid = None
groupid = api('hostgroup.create', {'name': binding})['groupids'][0]
try:
    hostid = api('host.create', {'host':'ais-' + binding, 'groups':[{'groupid':groupid}], 'tls_accept':2, 'tls_connect':2, 'tls_psk_identity':identity, 'tls_psk':psk})['hostids'][0]
    itemid = api('item.create', {'hostid':hostid, 'name':'Fixture active ping', 'key_':'agent.ping', 'type':7, 'value_type':3, 'delay':'1s'})['itemids'][0]
    subprocess.run(['zabbix_server','-R','config_cache_reload'], check=True, capture_output=True)
    before_version = subprocess.check_output(['dpkg-query','-W','-f=${Version}','zabbix-agent2']).decode()
    with tempfile.TemporaryDirectory(prefix='psk-live-') as tmp:
        work = Path(tmp)
        variables = {'ZABBIX_BINDING_ID':binding, 'ZABBIX_SERVER_ACTIVE':'127.0.0.1:10051', 'ZABBIX_PSK_IDENTITY':identity, 'ZABBIX_PSK':psk, 'ZABBIX_EXPECTED_MACHINE_ID':Path('/etc/machine-id').read_text().strip()}
        play = work/'play.yml'
        play.write_text(yaml.safe_dump([{'hosts':'localhost','gather_facts':True,'vars':variables,'tasks':yaml.safe_load(recipe['body'])}],sort_keys=False))
        play.chmod(0o600)
        env = dict(os.environ, ANSIBLE_ROLES_PATH='/work/roles', ANSIBLE_CALLBACK_PLUGINS='/work/callback_plugins', ANSIBLE_STDOUT_CALLBACK='json', AI_SUPPORT_AGENT_PROGRESS_FILE=str(work/'progress.jsonl'), ANSIBLE_NOCOLOR='1', ANSIBLE_VERBOSITY='0', ANSIBLE_DIFF_ALWAYS='false')
        backup_hash = None
        for attempt in range(2):
            result = subprocess.run(['/opt/ai-support-zabbix-ansible/bin/ansible-playbook','-i','localhost,','-c','local',str(play)],env=env,capture_output=True,text=True,timeout=240)
            assert psk not in result.stdout + result.stderr
            if result.returncode:
                Path('/tmp/psk-live-failure.json').write_text(result.stdout)
                raise AssertionError('Recipe failed; inspect secret-redacted /tmp/psk-live-failure.json')
            parsed = json.loads(result.stdout)
            assert parsed['plays'] and all(not host.get('failed') and not host.get('unreachable') for play_result in parsed['plays'] for task in play_result['tasks'] for host in task.get('hosts', {}).values())
            assert psk not in (work/'progress.jsonl').read_text()
            backup = Path('/var/backups/ai-support-zabbix')/binding/'original.tar.gz'
            digest = hashlib.sha256(backup.read_bytes()).hexdigest()
            if backup_hash: assert digest == backup_hash, 'Retry replaced original backup'
            backup_hash = digest
            assert subprocess.check_output(['dpkg-query','-W','-f=${Version}','zabbix-agent2']).decode() == before_version
            print('recipe_apply_%s=passed; json/progress_secret_redaction=passed' % (attempt+1), flush=True)
        correct = work/'correct.psk'; correct.write_text(psk); correct.chmod(0o600)
        wrong = work/'wrong.psk'; wrong.write_text(secrets.token_hex(32)); wrong.chmod(0o600)
        args = ['zabbix_get','-s','127.0.0.1','-k','agent.ping','--tls-connect','psk','--tls-psk-identity',identity,'--tls-psk-file']
        assert subprocess.run(args+[str(correct)],capture_output=True,text=True).stdout.strip() == '1'
        assert subprocess.run(args+[str(wrong)],capture_output=True,text=True).returncode != 0
        assert subprocess.run(['zabbix_get','-s','127.0.0.1','-k','agent.ping'],capture_output=True,text=True).returncode != 0
        deadline = time.monotonic()+150
        while time.monotonic()<deadline:
            item = api('item.get',{'itemids':[itemid],'output':['lastclock','lastvalue']})[0]
            if int(item['lastclock'])>0 and item['lastvalue']=='1': break
            time.sleep(3)
        else: raise AssertionError('No active PSK item received')
        print('correct_psk=passed; wrong_psk=refused; plaintext=refused; active_item=received; package_unchanged=passed; backup_retry=passed')
finally:
    if hostid: api('host.delete',[hostid])
    api('hostgroup.delete',[groupid])
