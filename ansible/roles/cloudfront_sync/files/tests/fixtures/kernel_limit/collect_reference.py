"""Plan-only by default. Root review GO required before isolated Docker execution."""
from pathlib import Path
import argparse,hashlib,json,subprocess,tempfile,re
BASE=Path(__file__).resolve().parents[3]
PINS={'ufw_integrity.py':'81e455a22b53e849840b163caebf9a147ff2e7828aeb47a61d0aa489bd85171c','ufw_kernel.py':'4efaf71f7372621c3a6631d904b86dab308d8a4db78c191073fffe80c0ac8f60'}
IMAGES={'22.04':'sha256:687047a8fab8b20cc44533515d9d881cd73048d91f244bd2be514aa384601cc6','24.04':'sha256:6915d2e9d3fa37c0baf5202e03c058324127d72e0f19a80199f493797e0a79e4','26.04':'sha256:133de0a8ebb359b8b1de0cab1f6df6320fc896bf6efaba62605ae5298c498423'}
VERSIONS={'22.04':{'iptables':'iptables v1.8.7 (nf_tables)','ip6tables':'ip6tables v1.8.7 (nf_tables)','nft':'nftables v1.0.2 (Lester Gooch)'},'24.04':{'iptables':'iptables v1.8.10 (nf_tables)','ip6tables':'ip6tables v1.8.10 (nf_tables)','nft':'nftables v1.0.9 (Old Doc Yak #3)'},'26.04':{'iptables':'iptables v1.8.11 (nf_tables)','ip6tables':'ip6tables v1.8.11 (nf_tables)','nft':'nftables v1.1.6 (Commodore Bullmoose #7)'}}
GUEST=r'''
from pathlib import Path
import hashlib,json,os,shlex,stat,subprocess,sys,types
p=Path('/run/cf-runtime-limit-fixture');s=p.lstat()
if os.geteuid()!=0 or not Path('/.dockerenv').is_file() or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1 or p.read_bytes()!=b'Runtime typed limit isolated fixture only\n':raise RuntimeError('fixture_guard')
config=json.loads(Path('/proof/config.json').read_bytes())
for leaf,expected in config['source_pins'].items():
 raw=Path('/proof',leaf).read_bytes()
 if hashlib.sha256(raw).hexdigest()!=expected:raise RuntimeError('fixed_source_changed')
 name=leaf[:-3];module=types.ModuleType(name);module.__file__='/proof/'+leaf;sys.modules[name]=module;exec(compile(raw,module.__file__,'exec'),module.__dict__)
u=sys.modules['ufw_integrity'];k=sys.modules['ufw_kernel']
def run(argv,data=None):
 r=subprocess.run(argv,input=data,capture_output=True,timeout=45,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
 if r.returncode or len(r.stdout)+len(r.stderr)>8*1024*1024:raise RuntimeError('fixture_command_failed')
 return r.stdout
links=json.loads(run(['ip','-j','address','show']));fallback={'erspan0','gre0','gretap0','ip6_vti0','ip6gre0','ip6tnl0','ip_vti0','sit0','tunl0'}
if not any(x['ifname']=='lo' for x in links):raise RuntimeError('missing_loopback')
for link in links:
 if link['ifname']=='lo':
  if link.get('link_type')!='loopback' or 'LOOPBACK' not in link.get('flags',[]):raise RuntimeError('invalid_loopback_identity')
  for address in link.get('addr_info',[]):
   if (address.get('family'),address.get('local'),address.get('prefixlen'),address.get('scope')) not in {('inet','127.0.0.1',8,'host'),('inet6','::1',128,'host')}:raise RuntimeError('unexpected_loopback_address')
 elif link['ifname'] not in fallback or 'UP' in link.get('flags',[]) or link.get('addr_info'):raise RuntimeError('unexpected_isolated_link')
for flags in ([],['-6']):
 if json.loads(run(['ip','-j',*flags,'route','show'])):raise RuntimeError('unexpected_route')
versions={n:run([n,'--version']).decode().strip() for n in ('iptables','ip6tables','nft')}
if versions!=config['tool_versions']:raise RuntimeError('tool_profile_changed')
profile='nftables-'+json.loads(run(['nft','-j','list','ruleset']))['nftables'][0]['metainfo']['version']+'-schema1'
rawbase={n:Path('/proof/raw',n).read_bytes() for n in ('before.rules','before6.rules','after.rules','after6.rules','user.rules','user6.rules')}
def restore():
 for family,binary in [('4','iptables-restore'),('6','ip6tables-restore')]:run([binary],Path('/proof/selected'+family).read_bytes())
def capture():
 commands={'selected4':['iptables-save'],'selected6':['ip6tables-save'],'native':['nft','-j','list','ruleset'],'legacy4':['iptables-legacy-save'],'legacy6':['ip6tables-legacy-save']}
 def once():
  data={n:run(a) for n,a in commands.items()}
  if data['legacy4'] or data['legacy6']:raise RuntimeError('nonempty_parallel_legacy')
  identity=[k.KernelSave.parse(data[n]).canonical.hex() for n in ('selected4','selected6')]+[k.NativeRuleset.parse(data['native'],profile=profile).canonical.hex()]
  return data,identity
 a,ia=once();b,ib=once()
 if ia!=ib:raise RuntimeError('unstable_kernel_capture')
 return {n:v.hex() for n,v in a.items()}
def same_policy(a,b):
 return all(k.KernelSave.parse(bytes.fromhex(a[n]))==k.KernelSave.parse(bytes.fromhex(b[n])) for n in ('selected4','selected6')) and k.NativeRuleset.parse(bytes.fromhex(a['native']),profile=profile)==k.NativeRuleset.parse(bytes.fromhex(b['native']),profile=profile) and a['legacy4']==b['legacy4']==a['legacy6']==b['legacy6']==''
restore();baseline=capture();cases=[]
for label,sources,port in [('host',('198.51.100.130','2001:db8:feed::130'),22),('prefix',('198.51.100.128/25','2001:db8:feed::/64'),2222)]:
 restore();before=capture()
 if not same_policy(before,baseline):raise RuntimeError('case_baseline_not_restored')
 raw=dict(rawbase);rowgroups=[]
 for family,source,leaf,binary in [(4,sources[0],'user.rules','iptables'),(6,sources[1],'user6.rules','ip6tables')]:
  profile_user=u.UserFileProfile(family)
  doc=u.UserRulesDocument.parse(rawbase[leaf],profile_user)
  block=u.TupleBlock(('limit','tcp',str(port),'0.0.0.0/0' if family==4 else '::/0','any',source,'in'))
  rendered=block.render(profile_user)
  rows=[line for line in rendered.splitlines() if line.startswith(b'-A ')]
  if len(rows)!=3:raise RuntimeError('unexpected_rendered_limit_rows')
  newdoc=u.UserRulesDocument(profile_user,doc.blocks+(block,));raw[leaf]=newdoc.to_bytes()
  if u.UserRulesDocument.parse(raw[leaf],profile_user).to_bytes()!=raw[leaf]:raise RuntimeError('new_raw_roundtrip')
  argv=[shlex.split(row.decode()) for row in rows]
  for args in argv:run([binary,*args])
  rowgroups.append({'family':family,'source':source,'port':port,'tuple_fields':list(block.fields),'rendered_block_hex':rendered.hex(),'raw_rows':[r.decode() for r in rows],'actual_command_argv':[[binary,*args] for args in argv]})
 after=capture();cases.append({'name':label,'rowgroups':rowgroups,'raw_sources_hex':{n:v.hex() for n,v in raw.items()},'before':before,'after':after})
 restore()
 if not same_policy(capture(),baseline):raise RuntimeError('case_final_restore_failed')
print(json.dumps({'fixture_only':True,'tool_versions':versions,'native_argv':['nft','-j','list','ruleset'],'native_profile':profile,'raw_before_hex':{n:v.hex() for n,v in rawbase.items()},'baseline':baseline,'cases':cases,'restored_after_each_case':True},separators=(',',':')))
'''
def call(args,*,data=None,timeout=180):
 r=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
 if r.returncode or len(r.stdout)+len(r.stderr)>16*1024*1024:
  d=Path(tempfile.mkdtemp(prefix='cf-runtime-limit-error-',dir='/private/tmp'));d.chmod(0o700)
  for n,b in [('stdout.private',r.stdout),('stderr.private',r.stderr)]:p=d/n;p.write_bytes(b[:65536]);p.chmod(0o600)
  raise RuntimeError('isolated_collector_failed_private_diagnostic_saved')
 return r.stdout

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--execute',action='store_true');args=parser.parse_args()
 if not args.execute:print(json.dumps({'plan_only':True,'image_ids':IMAGES,'tool_versions':VERSIONS,'source_pins':PINS,'cases':['host22','prefix2222'],'network':'none','caps':['NET_ADMIN','NET_RAW'],'no_host_mount_or_socket':True,'requires_root_review_before_execute':True}));return
 for leaf,pin in PINS.items():
  if hashlib.sha256((BASE/leaf).read_bytes()).hexdigest()!=pin:raise RuntimeError('reviewed_source_mismatch')
 directory=Path(tempfile.mkdtemp(prefix='cf-runtime-limit-',dir='/private/tmp'));directory.chmod(0o700);guest=directory/'guest.py';guest.write_text(GUEST)
 results={}
 for os_version,image in IMAGES.items():
  call(['docker','image','inspect',image]);fixture=BASE/'tests/fixtures/kernel'/os_version
  config=directory/(os_version+'.config.json');config.write_text(json.dumps({'source_pins':PINS,'tool_versions':VERSIONS[os_version]}))
  identifier=call(['docker','create','--pull=never','--network','none','--cap-add','NET_ADMIN','--cap-add','NET_RAW',image,'sleep','300']).decode().strip()
  if re.fullmatch('[0-9a-f]{64}',identifier) is None:raise RuntimeError('invalid_created_container_id')
  try:
   info=json.loads(call(['docker','inspect',identifier]))[0];h=info['HostConfig']
   if info['Image']!=image or h['NetworkMode']!='none' or h['Privileged'] or info['Mounts'] or h['PidMode']=='host' or h['IpcMode']=='host':raise RuntimeError('isolation_mismatch')
   call(['docker','start',identifier]);call(['docker','exec',identifier,'mkdir','-p','/proof/raw'])
   transfers=[(guest,'guest.py'),(config,'config.json'),*((BASE/n,n) for n in PINS),*((fixture/('before.'+tool),'selected'+f) for f,tool in [('4','iptables-save'),('6','ip6tables-save')]),*((fixture/'stock'/n,'raw/'+n) for n in ('before.rules','before6.rules','after.rules','after6.rules')),*((fixture/('before.'+n),'raw/'+n) for n in ('user.rules','user6.rules'))]
   for src,dst in transfers:call(['docker','cp',str(src),identifier+':/proof/'+dst])
   marker="import os;p='/run/cf-runtime-limit-fixture';f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(f,b'Runtime typed limit isolated fixture only\\n');os.close(f)"
   call(['docker','exec',identifier,'python3','-c',marker])
   raw=call(['docker','exec',identifier,'python3','-B','/proof/guest.py']);result=json.loads(raw);path=directory/(os_version+'.json');path.write_bytes(raw);path.chmod(0o600)
   results[os_version]={'cases':len(result['cases']),'artifact_sha256':hashlib.sha256(raw).hexdigest(),'image_id':image}
  finally:call(['docker','rm','-f',identifier])
 print(json.dumps({'artifact_directory':str(directory),'results':results,'containers_removed':True}))
if __name__=='__main__':
 try:main()
 except BaseException:print('{"status":"failed","detail":"runtime_limit_collector_refused"}');raise SystemExit(1)
