/** Fixed public-only Python38 wrapper. Source-local keys never leave Source. */
import {createHash} from 'crypto'
import {readFileSync} from 'fs'
import {join} from 'path'

export const SOURCE_HELPER_SHA256='f8f3c09150ca501f224346d004fb21296c4dca1bd7e0d47d728bd032884b5353'
export const SOURCE_CLOSURE_SHA256='fd619c602eaa512ce8b9bea824df7d127dcdde040794176201515f8d8efc6c48'
export const SOURCE_KEY_STAGE_SHA256='d4ef845e20ab96bbc1889aa33e9c0b9be1e6ff22530b0867037d69bb6b86f5b2'
export function sourceKeyStageCode():string {
 const raw=readFileSync(join(__dirname,'reboot-assets/source-key-stage.py'))
 if(createHash('sha256').update(raw).digest('hex')!==SOURCE_KEY_STAGE_SHA256)throw new Error('SMILES_REBOOT_PROFILE_REFUSED')
 return raw.toString('utf8')
}
function closureCode():string {
 const raw=readFileSync(join(__dirname,'reboot-assets/source-closure.py'))
 if(createHash('sha256').update(raw).digest('hex')!==SOURCE_CLOSURE_SHA256)throw new Error('SMILES_REBOOT_PROFILE_REFUSED')
 return raw.toString('utf8')
}
export const SOURCE_PROGRAM=`import resource
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
import hashlib,json,os,stat,sys
from pathlib import Path
try:
 p=Path('/usr/local/libexec/smiles-reverse-tunnel-source.py')
 for node in (p,*p.parents):
  s=node.lstat();assert s.st_uid==0 and not s.st_mode&0o022 and not stat.S_ISLNK(s.st_mode)
 s=p.stat();assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before_file=os.fstat(fd);assert (before_file.st_dev,before_file.st_ino)==(s.st_dev,s.st_ino)
  code=os.read(fd,1048577);assert len(code)<=1048576 and hashlib.sha256(code).hexdigest()=='${SOURCE_HELPER_SHA256}'
  after_file=os.fstat(fd);assert (before_file.st_dev,before_file.st_ino,before_file.st_size,before_file.st_mtime_ns)==(after_file.st_dev,after_file.st_ino,after_file.st_size,after_file.st_mtime_ns)
 finally:os.close(fd)
 namespace={'__name__':'source_profile_helper','__file__':str(p)};exec(compile(code,str(p),'exec'),namespace);m=type('SourceProfileHelper',(),namespace)
 m.preflight()
 raw=sys.stdin.buffer.read(65537);assert len(raw)<=65536;request=json.loads(raw)
 assert set(request)=={'profile'};profile=request['profile'];step=profile['stepId'];old=m.run_id(profile['oldTransportRunId']);new=m.run_id(profile['runId'])
 expected=profile['sourceBootId'];before=m.boot();public=profile['publicInput']['public_contract']
 if step=='source-observe':
  assert m.boot()==before
  result={'status':'observed','source_boot_id':before,'source_ip':m.SOURCE_IP,'helper_sha256':'${SOURCE_HELPER_SHA256}'}
 else:
  assert before==expected
  if step in ('source-proof','close-source'):
   directory,state=m.selected(old);assert state['phase']=='cleaned' and state.get('cleanup_confirmed') is True
   assert state['public']['public_key']==public['public_key'] and state['public']['target_host_key']==public['target_host_key']
   assert state['public']['source_key_fingerprint']==m.fingerprint(public['public_key'])
   if step=='source-proof':
    namespace={'__name__':'source_reboot_readonly_profile'}
    exec(compile(${JSON.stringify(closureCode())},'source-reboot-closure','exec'),namespace)
    c=type('Closure',(),namespace)
    with c.locks(old):
     statepath=c.ROOT/old/'state.json';blob=c.read(statepath);original=json.loads(blob)
     first=c.validate(original,c.collect(old,original),old);second=c.validate(original,c.collect(old,original),old)
     assert first==second and c.read(statepath)==blob and first['new_boot_id']==expected and m.boot()==expected
     receipt={**first,'source_state_sha256':hashlib.sha256(blob).hexdigest(),'observed_at_utc':int(c.time.time())}
    closed={'revision':'smiles-source-tunnel-closure-v1','run_id':old,'helper_sha256':'${SOURCE_HELPER_SHA256}','source_ip':m.SOURCE_IP,'unit':m.unit_name(old),'source_key_fingerprint':receipt['source_key_fingerprint'],'phase':'cleaned','cleanup_confirmed':True,'unit_main_pid':0,'private_runtime_absent':True,'owned_ssh_absent':True,'watchdogs_stopped':True,'observed_at_utc':receipt['observed_at_utc']}
    result={'status':'proved','receipt':receipt,'source_closure':closed}
   else:
    # This profile never turns an unclean old boot into a fabricated cleaned
    # journal. Hard/unclean reboot remains an explicit operator HOLD.
    assert m.boot()==expected
    result={'status':'cleaned','run_id':old,'source_boot_id':expected,'helper_sha256':'${SOURCE_HELPER_SHA256}'}
  elif step in ('source-keygen','start-source'):
   stagecode=${JSON.stringify(sourceKeyStageCode())}
   namespace={'__name__':'source_key_stage_profile'};exec(compile(stagecode,'source-key-stage','exec'),namespace);k=type('KeyStage',(),namespace)
   if step=='source-keygen':result=k.prepare(profile,stagecode.encode())
   else:
    m.validate_public(public,new);assert m.boot()==expected
    k.consume(profile,lambda private:m.start(new,{'public':public,'private_key':private}))
    _,created=m.selected(new);assert created['boot_id']==expected and m.boot()==expected
    assert created['public']==public
    result={'status':'started','run_id':new,'source_boot_id':expected,'helper_sha256':'${SOURCE_HELPER_SHA256}'}
  else:raise RuntimeError()
  assert m.boot()==expected
 print(json.dumps(result,sort_keys=True,separators=(',',':')))
except BaseException:
 print('{"status":"refused","code":"SMILES_REBOOT_SOURCE_REFUSED"}');sys.exit(1)
`
export const SOURCE_PROGRAM_SHA256=createHash('sha256').update(SOURCE_PROGRAM).digest('hex')
export const SOURCE_COMMAND="sudo -n /usr/bin/python3.8 -I -S -B -c '"+SOURCE_PROGRAM.replace(/'/g,"'\\''")+"'"
