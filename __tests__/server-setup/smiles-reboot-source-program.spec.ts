/** Public synthetic Python platform facade; executes no SSH or real helper. */
import {spawnSync} from 'child_process'
import {SOURCE_PROGRAM,SOURCE_HELPER_SHA256,sourceKeyStageCode} from '../../src/server-setup/smiles-reboot-source-program'
function run(mode:'stable'|'before'|'after'){
 const expected='11111111-1111-4111-8111-111111111111'
 const profile={stepId:'start-source',runId:'a'.repeat(32),oldTransportRunId:'b'.repeat(32),sourceBootId:expected,publicInput:{public_contract:{run_id:'a'.repeat(32)}}}
 const fixtureProgram=SOURCE_PROGRAM.replace(JSON.stringify(sourceKeyStageCode()),JSON.stringify("def consume(profile,start):start('SYNTHETIC_SOURCE_LOCAL_KEY')\n"))
 const script=`import sys,io,json,types,pathlib,hashlib,importlib.util,resource,stat,os
raw=sys.stdin.buffer.read();request=json.loads(raw);sys.stdin=types.SimpleNamespace(buffer=io.BytesIO(raw));calls=[];ticks=[0]
class P:
 parents=()
 def __init__(self,*a):pass
 def lstat(self):return types.SimpleNamespace(st_uid=0,st_mode=0o100600)
 def stat(self):return types.SimpleNamespace(st_mode=0o100600,st_nlink=1,st_dev=1,st_ino=2)
pathlib.Path=P
hashlib.sha256=lambda *a:types.SimpleNamespace(hexdigest=lambda:'${SOURCE_HELPER_SHA256}')
def boot():
 ticks[0]+=1
 if '${mode}'=='before':return 'different'
 if '${mode}'=='after' and calls:return 'different'
 return '${expected}'
created={}
def start(run,payload):calls.append(run);created.update(boot_id='${expected}',public=payload['public'])
import builtins
builtins.fixture_boot=boot;builtins.fixture_start=start;builtins.fixture_created=created
helper=b"import builtins\\nSOURCE_IP='140.227.124.149'\\ndef preflight():pass\\ndef run_id(x):return x\\ndef boot():return builtins.fixture_boot()\\ndef validate_public(*a):pass\\ndef start(run,payload):builtins.fixture_start(run,payload)\\ndef selected(run):return None,builtins.fixture_created\\n"
os.open=lambda *a:999;os.close=lambda *a:None;os.read=lambda *a:helper
os.fstat=lambda *a:types.SimpleNamespace(st_dev=1,st_ino=2,st_size=len(helper),st_mtime_ns=1)
fixture_exit=0
try:exec(${JSON.stringify(fixtureProgram)})
except SystemExit as e:fixture_exit=e.code
sys.stderr.write(json.dumps({'start_calls':len(calls)}));sys.exit(fixture_exit)
`
 return spawnSync('python3',['-I','-B','-c',script],{input:JSON.stringify({profile}),encoding:'utf8',timeout:10000,maxBuffer:65536})
}
describe('expected source boot before and after key startup',()=>{
 test('same boot emits only typed successful result',()=>{const r=run('stable');expect(r.status).toBe(0);expect(JSON.parse(r.stdout).status).toBe('started');expect(JSON.parse(r.stderr)).toEqual({start_calls:1});expect(r.stdout).not.toContain('PRIVATE')})
 test('changed boot before startup refuses without starting',()=>{const r=run('before');expect(r.status).toBe(1);expect(JSON.parse(r.stderr)).toEqual({start_calls:0});expect(JSON.parse(r.stdout)).toEqual({status:'refused',code:'SMILES_REBOOT_SOURCE_REFUSED'})})
 test('second reboot after startup cannot publish admission',()=>{const r=run('after');expect(r.status).toBe(1);expect(JSON.parse(r.stderr)).toEqual({start_calls:1});expect(JSON.parse(r.stdout).status).toBe('refused');expect(r.stdout).not.toContain('PRIVATE')})
})
