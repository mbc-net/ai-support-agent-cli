/** Real temporary FD/filesystem operations; systemd, boot and keygen are finite public facades. */
import {spawnSync} from 'child_process'
import {join} from 'path'
import {sourceKeyStageCode} from '../../src/server-setup/smiles-reboot-source-program'
test('Source-only stage lifecycle: prearmed expiry, binding, no adoption, cleanup and no private output',()=>{
 const script=`import importlib.util,sys,os,tempfile,pathlib,unittest,json,stat,time,ast,threading
code=pathlib.Path(sys.argv[1]).read_bytes();ast.parse(code,feature_version=(3,8))
ns={'__name__':'fixture_stage'};exec(compile(code,'key-stage','exec'),ns)
k=type('Stage',(),ns)
PUBLIC='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
PRIVATE=b'-----BEGIN OPENSSH PRIVATE KEY-----\\nSYNTHETIC_PRIVATE_NEVER_OUTPUT\\n-----END OPENSSH PRIVATE KEY-----\\n'
class Cases(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.events=[]
  ns['BASE']=self.root/'stages';ns['UNITS']=self.root/'units';ns['UNITS'].mkdir(mode=0o700)
  ns['UID']=os.geteuid();ns['boot']=lambda:'11111111-1111-4111-8111-111111111111';ns['ancestors']=lambda p:None
  self.p={'runId':'a'*32,'jobId':'22222222-2222-4222-8222-222222222222','accountOwnerRunId':ns['OWNER'],'sourceBootId':ns['boot'](),'publicInput':{'source_key_receipt':None,'public_contract':{'public_key':PUBLIC}}}
  def call(args):
   self.events.append(args)
   if args[0]=='/usr/bin/ssh-keygen':return PUBLIC+'\\n'
   if args[1]=='start' and args[2].startswith('smiles-reboot-keygen-'):
    self.assertTrue(any(x[1:3]==['start','smiles-reboot-key-expire-'+'a'*32+'.timer'] for x in self.events))
    self.assertIn('ConditionPathExists=!',(ns['UNITS']/args[2]).read_text())
    d=ns['BASE']/'a'.__mul__(32);ns['write'](d/'identity',PRIVATE);ns['write'](d/'identity.pub',(PUBLIC+'\\n').encode());return ''
   if 'is-active' in args:return 'active\\n'
   if '--property=FragmentPath' in args:return str(ns['UNITS']/args[2])+'\\n'
   if '--property=NeedDaemonReload' in args:return 'no\\n'
   if '--property=MainPID' in args:return '0\\n'
   if '--property=Result' in args:return 'success\\n'
   return ''
  ns['call']=call
 def tearDown(self):self.tmp.cleanup()
 def make(self):
  r=ns['prepare'](self.p,code);self.p['publicInput']['source_key_receipt']=r;return r
 def test_roundtrip(self):
  r=self.make();self.assertNotIn('PRIVATE',json.dumps(r));self.assertEqual(r['job_id'],self.p['jobId']);seen=[]
  ns['consume'](self.p,lambda private:seen.append(private));self.assertEqual(seen,[PRIVATE.decode()]);self.assertFalse((ns['BASE']/('a'*32)/'identity').exists())
  with self.assertRaises(RuntimeError):ns['consume'](self.p,lambda x:None)
  with self.assertRaises(FileExistsError):ns['prepare'](self.p,code)
 def test_binding_and_expiry(self):
  self.make();original=dict(self.p)
  for field,value in [('jobId','33333333-3333-4333-8333-333333333333'),('sourceBootId','44444444-4444-4444-8444-444444444444'),('accountOwnerRunId','b'*32)]:
   self.p[field]=value
   with self.assertRaises(RuntimeError):ns['consume'](self.p,lambda x:self.fail('must not hand off'))
   self.p=original.copy()
  old=ns['time'].time
  try:
   ns['time'].time=lambda:self.p['publicInput']['source_key_receipt']['deadline_utc']+1
   with self.assertRaises(RuntimeError):ns['consume'](self.p,lambda x:self.fail('expired'))
  finally:ns['time'].time=old
 def test_expiry_partial_before_receipt(self):
  self.make();d=ns['BASE']/('a'*32);(d/'receipt.json').unlink();ns['expire']('a'*32)
  self.assertFalse((d/'identity').exists());self.assertFalse((d/'identity.pub').exists());ns['expire']('a'*32)
 def test_failed_handoff_consumes_once_and_clears_stage(self):
  self.make();d=ns['BASE']/('a'*32)
  def fail(private):raise RuntimeError('synthetic partial handoff')
  with self.assertRaises(RuntimeError):ns['consume'](self.p,fail)
  self.assertFalse((d/'identity').exists());self.assertTrue((d/'consumed.json').exists())
 def test_hung_handoff_cannot_block_independent_expiry(self):
  self.make();entered=threading.Event();release=threading.Event();done=threading.Event();errors=[]
  def handoff(private):entered.set();self.assertTrue(release.wait(2))
  def consume():
   try:ns['consume'](self.p,handoff)
   except BaseException as e:errors.append(type(e).__name__)
  def expiry():
   try:ns['expire']('a'*32);done.set()
   except BaseException as e:errors.append(type(e).__name__)
  a=threading.Thread(target=consume);a.start();self.assertTrue(entered.wait(1));b=threading.Thread(target=expiry);b.start();self.assertTrue(done.wait(1));self.assertFalse((ns['BASE']/('a'*32)/'identity').exists());release.set();a.join(2);b.join(2)
  self.assertFalse(a.is_alive() or b.is_alive());self.assertEqual(errors,[]);self.assertTrue(done.is_set());self.assertFalse((ns['BASE']/('a'*32)/'identity').exists())
 def test_expiry_during_keygen_ack_gap_cannot_leave_or_recreate_key(self):
  real=ns['call'];generated=threading.Event();drained=threading.Event();outcomes=[]
  def call(args):
   if args[1]=='stop' and args[2].startswith('smiles-reboot-keygen-'):drained.set()
   result=real(args)
   if args[1]=='start' and args[2].startswith('smiles-reboot-keygen-'):
    generated.set();self.assertTrue(drained.wait(2))
   return result
  ns['call']=call
  def preparation():
   try:ns['prepare'](self.p,code);outcomes.append('UNSAFE_SUCCESS')
   except BaseException:outcomes.append('HOLD')
  thread=threading.Thread(target=preparation);thread.start();self.assertTrue(generated.wait(1));ns['expire']('a'*32);thread.join(2)
  self.assertFalse(thread.is_alive());self.assertEqual(outcomes,['HOLD']);d=ns['BASE']/('a'*32);self.assertFalse((d/'identity').exists());self.assertFalse((d/'identity.pub').exists())
 def test_unarmed_timer_never_generates_key(self):
  real=ns['call']
  def fail(args):return 'inactive' if 'is-active' in args else real(args)
  ns['call']=fail
  with self.assertRaises(RuntimeError):ns['prepare'](self.p,code)
  self.assertFalse(any(x[1]=='start' and x[2].startswith('smiles-reboot-keygen-') for x in self.events))
 def test_unknown_and_link_refused(self):
  self.make();d=ns['BASE']/('a'*32);(d/'identity').unlink();(d/'identity').symlink_to(self.root/'absent')
  with self.assertRaises(RuntimeError):ns['consume'](self.p,lambda x:self.fail('link'))
  with self.assertRaises(RuntimeError):ns['expire']('a'*32)
 def test_receipt_tamper_rejected(self):
  self.make();self.p['publicInput']['source_key_receipt']['stage_nonce']='0'*64
  with self.assertRaises(RuntimeError):ns['consume'](self.p,lambda x:self.fail('tamper'))
unittest.main(argv=['fixture'],verbosity=0)
`
 const r=spawnSync('python3',['-I','-B','-c',script,join(__dirname,'../../src/server-setup/reboot-assets/source-key-stage.py')],{encoding:'utf8',timeout:10000,maxBuffer:65536})
 expect(r.stdout).toBe('');expect(r.status).toBe(0);expect(r.stderr).not.toContain('SYNTHETIC_PRIVATE')
 if(r.status!==0)throw new Error(r.stderr)
 expect(sourceKeyStageCode()).not.toContain('shell=True')
})
