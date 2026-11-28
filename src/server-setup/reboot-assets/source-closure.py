"""Read-only old-run inspection plus a NEW reboot-closure receipt.
Never changes a source tunnel journal, sends signals, or starts/stops a unit.
This revision is deliberately NOT accepted by the legacy cleaned/start chain.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import time

REVISION='smiles-source-reboot-closure-v1'
SOURCE_SHA='f8f3c09150ca501f224346d004fb21296c4dca1bd7e0d47d728bd032884b5353'
SOURCE=Path('/usr/local/libexec/smiles-reverse-tunnel-source.py')
ROOT=Path('/var/lib/smiles-source-tunnel')
RECEIPTS=Path('/var/lib/smiles-source-reboot-closures')
UNITS=Path('/etc/systemd/system')
UNIT_ROOTS=(Path('/etc/systemd/system'),Path('/run/systemd/system'),Path('/usr/lib/systemd/system'),Path('/lib/systemd/system'))
class Refused(RuntimeError):
 def __init__(self):super().__init__('SOURCE_REBOOT_CLOSURE_REFUSED')
def require(value):
 if not value:raise Refused()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
def digest(value):return hashlib.sha256(value).hexdigest()
def identity(value):require(type(value) is str and re.fullmatch('[a-f0-9]{32}',value) is not None);return value
def uuid(value):return type(value) is str and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',value) is not None
def hex64(value):return type(value) is str and re.fullmatch('[a-f0-9]{64}',value) is not None
def unit_name(run):return 'smiles-reverse-source-'+identity(run)+'.service'
def watchdog_names(run):return ['smiles-reverse-source-expiry-'+identity(run)+'.service','smiles-reverse-source-expiry-'+run+'.timer']
def safe(path,directory=False):
 for ancestor in list(path.parents)[::-1]+[path]:
  value=ancestor.lstat();is_dir=ancestor!=path or directory
  require(value.st_uid==0 and value.st_gid==0 and not stat.S_IMODE(value.st_mode)&0o022 and (stat.S_ISDIR(value.st_mode) if is_dir else stat.S_ISREG(value.st_mode) and value.st_nlink==1))
 return path
def read(path,limit=65536):
 safe(path);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);require(before.st_uid==0 and before.st_gid==0 and before.st_nlink==1 and stat.S_ISREG(before.st_mode));require(before.st_size<=limit)
  data=bytearray()
  while True:
   chunk=os.read(fd,min(65536,limit+1-len(data)))
   if not chunk:break
   data.extend(chunk);require(len(data)<=limit)
  after=os.fstat(fd);named=path.lstat();require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) and (named.st_dev,named.st_ino)==(after.st_dev,after.st_ino))
  return bytes(data)
 finally:os.close(fd)
def private_json(path):
 require(stat.S_IMODE(path.lstat().st_mode)==0o600);return json.loads(read(path))
def props(name):
 result=subprocess.run(['systemctl','show',name,'--property=Id','--property=LoadState','--property=ActiveState','--property=MainPID','--property=FragmentPath','--property=DropInPaths','--property=NeedDaemonReload'],capture_output=True,timeout=10,check=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
 require(len(result.stdout)<=8192 and len(result.stderr)<=8192)
 values={}
 for line in result.stdout.decode('ascii').splitlines():
  key,value=line.split('=',1);require(key not in values);values[key]=value
 return values
def stopped(value,name):
 require(type(value) is dict and set(value)<= {'Id','LoadState','ActiveState','MainPID','FragmentPath','DropInPaths','NeedDaemonReload'} and value.get('Id')==name and value.get('LoadState')=='loaded' and value.get('ActiveState') in ('inactive','failed'))
 require(value.get('MainPID')=='0' if name.endswith('.service') else value.get('MainPID','0')=='0')
 require(value.get('FragmentPath')==str(UNITS/name) and value.get('DropInPaths')=='' and value.get('NeedDaemonReload')=='no')
def validate(state,facts,run):
 """Pure finite proof; no state mutation or assumption based on PID number."""
 identity(run)
 require(type(state) is dict and state.get('revision')=='smiles-reverse-tunnel-source-v1' and state.get('run_id')==run and state.get('helper_sha256')==SOURCE_SHA)
 require(state.get('phase') in ('prepared','connecting','running','stopped','expired','cleaned') and not state.get('cleanup_unknown_reason'))
 require(uuid(state.get('boot_id')) and type(facts) is dict and set(facts)=={'source_ip','os_id','os_version','current_boot_id','runtime_absent','unit','watchdogs','files_sha256','source_sha256','active_run_id','dropins_absent'})
 require(facts['source_ip']=='140.227.124.149' and facts['os_id']=='ubuntu' and facts['os_version']=='18.04' and facts['source_sha256']==SOURCE_SHA and facts['active_run_id']==run)
 require(uuid(facts['current_boot_id']) and state['boot_id']!=facts['current_boot_id'] and facts['runtime_absent'] is True and facts['dropins_absent'] is True)
 public=state.get('public');require(type(public) is dict and public.get('run_id')==run and public.get('source_ip')=='140.227.124.149' and public.get('target_ip')=='133.18.114.57' and public.get('ssh_user')=='smiles-tunnel')
 require(type(public.get('source_key_fingerprint')) is str and re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}',public['source_key_fingerprint']) is not None)
 require(type(public.get('deadline_utc')) is int and public['deadline_utc']>0)
 for name in ('ssh','worker'):
  if name in state:
   item=state[name];require(type(item) is dict and set(item)=={'pid','ticks','boot'} and type(item['pid']) is int and item['pid']>1 and type(item['ticks']) is int and item['ticks']>0 and item['boot']==state['boot_id'])
 stopped(facts['unit'],unit_name(run))
 expected_watchdogs={str(UNITS/name) for name in watchdog_names(run)}
 require(type(state.get('watchdog')) is dict and set(state['watchdog'])==expected_watchdogs and all(hex64(v) for v in state['watchdog'].values()))
 require(type(facts['watchdogs']) is dict and set(facts['watchdogs'])==set(watchdog_names(run)))
 for name,value in facts['watchdogs'].items():stopped(value,name)
 unit_path=str(UNITS/unit_name(run));require(hex64(state.get('unit_sha256')))
 require(facts['files_sha256']=={unit_path:state['unit_sha256'],**state['watchdog']})
 return {'revision':REVISION,'run_id':run,'source_ip':'140.227.124.149','helper_sha256':SOURCE_SHA,'old_boot_id':state['boot_id'],'new_boot_id':facts['current_boot_id'],'old_phase':state['phase'],'source_key_fingerprint':public['source_key_fingerprint'],'private_runtime_absent':True,'old_boot_processes_absent':True,'unit_main_pid':0,'watchdogs_stopped':True,'old_journal_mutated':False,'legacy_start_admitted':False}

def collect(run,state):
 release=dict(line.split('=',1) for line in read(Path('/usr/lib/os-release'),8192).decode('ascii').splitlines() if '=' in line)
 result=subprocess.run(['/sbin/ip','-j','-4','address','show'],capture_output=True,timeout=10,check=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'});require(len(result.stdout)<=65536)
 addresses=json.loads(result.stdout);require('140.227.124.149' in [a['local'] for item in addresses for a in item.get('addr_info',[])])
 runtime=Path('/run')/('smiles-reverse-source-'+run);absent=not runtime.exists() and not runtime.is_symlink()
 names=watchdog_names(run)
 for name in [unit_name(run)]+names:
  for base in UNIT_ROOTS:
   path=base/(name+'.d');require(not path.exists() and not path.is_symlink())
 files={str(UNITS/unit_name(run)):digest(read(UNITS/unit_name(run)))}
 files.update({str(UNITS/name):digest(read(UNITS/name)) for name in names})
 return {'source_ip':'140.227.124.149','os_id':release.get('ID','').strip('"'),'os_version':release.get('VERSION_ID','').strip('"'),'current_boot_id':read(Path('/proc/sys/kernel/random/boot_id'),128).decode('ascii').strip(),'runtime_absent':absent,'dropins_absent':True,'unit':props(unit_name(run)),'watchdogs':{name:props(name) for name in names},'files_sha256':files,'source_sha256':digest(read(SOURCE,1024*1024)),'active_run_id':private_json(ROOT/'active.json').get('run_id')}
@contextlib.contextmanager
def locks(run):
 opened=[]
 try:
  for path in (ROOT/'selection.lock',ROOT/run/'operation.lock'):
   safe(path);require(stat.S_IMODE(path.lstat().st_mode)==0o600);fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK);opened.append(fd);value=os.fstat(fd);named=path.lstat();require(stat.S_ISREG(value.st_mode) and value.st_nlink==1 and value.st_uid==0 and value.st_gid==0 and stat.S_IMODE(value.st_mode)==0o600 and (value.st_dev,value.st_ino)==(named.st_dev,named.st_ino));fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  yield
 finally:
  for fd in reversed(opened):os.close(fd)
def capture(run):
 identity(run);require(os.getuid()==os.geteuid()==0 and os.getgid()==os.getegid()==0 and sys.platform=='linux')
 with locks(run):
  path=ROOT/run/'state.json';raw=read(path);require(stat.S_IMODE(path.lstat().st_mode)==0o600);state=json.loads(raw)
  first=validate(state,collect(run,state),run);second=validate(state,collect(run,state),run)
  require(first==second and read(path)==raw)
  receipt={**first,'source_state_sha256':digest(raw),'observed_at_utc':int(time.time())}
  # Only this separate new receipt tree is created. Old journals remain exact.
  if not RECEIPTS.exists():safe(RECEIPTS.parent,True);RECEIPTS.mkdir(mode=0o700)
  safe(RECEIPTS,True);require(stat.S_IMODE(RECEIPTS.stat().st_mode)==0o700)
  target=RECEIPTS/(run+'.json');fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  try:
   data=canonical(receipt);view=memoryview(data)
   while view:
    count=os.write(fd,view);require(count>0);view=view[count:]
   os.fsync(fd)
  finally:os.close(fd)
  directory=os.open(RECEIPTS,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:os.fsync(directory)
  finally:os.close(directory)
  require(read(path)==raw and read(Path('/proc/sys/kernel/random/boot_id'),128).decode('ascii').strip()==receipt['new_boot_id'])
  return receipt
def main():
 try:
  resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077);require(len(sys.argv)==3 and sys.argv[1]=='capture');result=capture(identity(sys.argv[2]));print(json.dumps(result,sort_keys=True));return 0
 except BaseException:print('{"status":"refused","code":"SOURCE_REBOOT_CLOSURE_REFUSED"}');return 1
if __name__=='__main__':raise SystemExit(main())
