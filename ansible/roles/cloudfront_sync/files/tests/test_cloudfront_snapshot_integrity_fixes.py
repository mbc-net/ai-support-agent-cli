"""Regression tests for two cloudfront_snapshot integrity gaps.

1. read_private_state rechecked every captured private file only by its
   metadata (_fs_identity: size, mtime/ctime, ...). On a filesystem whose
   timestamp granularity is coarse, a same-size rewrite inside one tick keeps
   the metadata identical, so a changed file was accepted as captured. After
   every file is captured, the final recheck must also compare each file's
   content again (bounded, with the same safe opens), and a file that
   disappears before that recheck is private_state_file_changed. The
   before_recheck hook assumes the reader closes each capture descriptor
   and reopens the file by name for that final recheck.
2. There was no public config-hash function: the ledger computed
   sha256(_canonical(config)) inline and the CLI borrowed the private
   _canonical. cloudfront_snapshot.config_hash(config) is the one definition,
   and its value must stay byte-for-byte the value already persisted.
3. Review 7 (PrivateStateReaderBoundaryTests): the directory is listed
   again after the content recheck; every ancestor OSError is the fixed
   private_state_unavailable (only the leaf's absence is a disposition); a
   name replaced between the listing and the capture is
   private_state_file_changed as at the recheck; and the recheck shares the
   capture's bounded read, including its post-read identity match.
4. Review 9 (PrivateStateReaderReview9Tests): replacement is decided by
   identity, never by errno. Each known name's identity is recorded by the
   listing itself (its DirEntry lstat). A name that is not a regular file
   in the listing is private_state_unsafe_file; one that is rebound later
   (to a symlink, directory, FIFO or socket, or removed) is
   private_state_file_changed. After any OSError of an open or read the name
   is lstat-ed again: vanished or another identity is
   private_state_file_changed, the same identity is
   private_state_unavailable (an injected ELOOP/ENXIO/EISDIR with the name
   unchanged is not a replacement). The private directory is decided the
   same way after an OSError of its open.
5. Review 10 (PrivateStateReaderReview10Tests): the ancestors are compared
   again only by (st_dev, st_ino, st_mode, st_uid, st_gid), so an unrelated
   entry created or removed in /var/lib or the parent while the namespace is
   read is not private_state_parent_changed, while an ancestor replaced by
   another directory of the same name is; the private directory itself keeps
   its full identity.

Like the other snapshot tests, each body runs in an independent interpreter
with a private module graph.

Relation to test_cloudfront_snapshot.py
test_private_state_reader_rechecks_every_file_after_complete_capture: that
test rewrites with real timestamps and relies on the clock advancing, so it
is timing dependent on Linux. The tests here cover the same requirement
deterministically by pinning the timestamps the reader observes.
"""
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest
FILES=Path(__file__).parents[1]
PRELUDE=r'''
import contextlib,errno,hashlib,importlib.util,json,os,stat,sys,tempfile,types
from pathlib import Path
from unittest.mock import patch
files=Path(FILES_PATH)
# Same unprivileged-run adjustment as test_cloudfront_snapshot.py: Linux
# refuses O_NOATIME on root-owned ancestors (/, /tmp) for a non-root caller.
if sys.platform=='linux' and os.geteuid()!=0 and hasattr(os,'O_NOATIME'):del os.O_NOATIME
for name in ('ufw_integrity','ufw_kernel','ufw_kernel_mapping','ufw_docker_kernel','ufw_docker_transition','ufw_observation','nginx_observation','cloudfront_snapshot'):
 module=types.ModuleType(name);module.__file__=str(files/(name+'.py'));sys.modules[name]=module
 exec(compile((files/(name+'.py')).read_bytes(),module.__file__,'exec'),module.__dict__)
m=sys.modules['cloudfront_snapshot']
TMP=str(Path('/tmp').resolve())
with tempfile.TemporaryDirectory(dir=TMP) as _probe:GROUP=os.stat(_probe).st_gid
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()

# --- coarse-timestamp filesystem model and I/O hooks -------------------------
# The model: a filesystem whose timestamps do not advance between writes
# (coarse granularity, every write inside one tick). Every stat result the
# reader can observe (os.stat, os.lstat, os.fstat, os.scandir DirEntry.stat)
# has its access/modify/change/birth times pinned to one constant, so an
# in-place same-size rewrite (same inode) is metadata-identical to the
# original. The OS calls are patched, not _fs_identity, so the model does not
# depend on which helper the reader compares metadata with.
_real_stat,_real_lstat,_real_fstat,_real_scandir=os.stat,os.lstat,os.fstat,os.scandir
_real_open,_real_read,_real_close=os.open,os.read,os.close
_SEQ=os.stat_result.n_sequence_fields
_PINNED={'st_atime':0.0,'st_mtime':0.0,'st_ctime':0.0,'st_atime_ns':0,'st_mtime_ns':0,'st_ctime_ns':0,'st_birthtime':0.0,'st_birthtime_ns':0}
def _coarse(info,stable_dir=False):
    seq=list(tuple(info)[:_SEQ]);seq[7]=seq[8]=seq[9]=0
    # stable_dir: also a directory whose size and link count do not track its
    # file entries (ext4 within one directory block; APFS counts entries in
    # st_nlink), so adding, removing or rebinding a file name keeps the
    # directory metadata identical too.
    if stable_dir and stat.S_ISDIR(info.st_mode):seq[3]=2;seq[6]=0
    extra={key:getattr(info,key) for key in dir(info) if key.startswith('st_') and key not in
           ('st_mode','st_ino','st_dev','st_nlink','st_uid','st_gid','st_size')}
    extra.update({key:value for key,value in _PINNED.items() if key in extra})
    return os.stat_result(seq,extra)

def hook(trigger,when,action):
    """A one-shot action on the reader's I/O for the private file ``trigger``.

    when='captured': at the first end-of-file os.read or the first os.close of
    the descriptor the reader opened for ``trigger`` (its capture), whichever
    comes first.
    when='before_recheck': after that capture descriptor is closed, right
    before the next os.stat/os.lstat/os.open naming ``trigger`` by dir_fd
    (the start of any later recheck of that file).
    when='before_capture': before the first os.stat/os.lstat/os.open naming
    ``trigger`` by dir_fd (between the directory listing, which records the
    name's identity through DirEntry.stat, and the capture).
    when='before_open': before the first os.open naming ``trigger`` by dir_fd
    (right before the capture's open).
    when='before_recheck_open': after the capture descriptor is closed, right
    before the next os.open naming ``trigger`` by dir_fd (right before the
    recheck's reopen).
    when='rechecked': at the first end-of-file os.read of a descriptor opened
    for ``trigger`` after the capture descriptor was closed (the recheck's
    bounded read has just ended).
    when='capture_fstat': right after the first os.fstat of the capture
    descriptor of ``trigger`` returns (its identity was just matched; the
    bounded read has not started).
    The action runs in place of nothing: an exception it raises (an OSError
    modelling a failed call) propagates from that I/O call.
    """
    return {'trigger':trigger,'when':when,'action':action,'fds':set(),'rfds':set(),'closed':False,'done':False}

def raiser(code):
    """An action failing the I/O call it precedes with ``code`` and the name."""
    def action():raise OSError(code,os.strerror(code),'/secret/path/'+code_name(code))
    return action
def code_name(code):return errno.errorcode[code]

def harness(*hooks,coarse=True,stable_dir=False):
    def fire(h):
        if not h['done']:h['done']=True;h['action']()
    def access(op,path,kwargs):
        if kwargs.get('dir_fd') is not None:
            for h in hooks:
                if path!=h['trigger']:continue
                if ((h['when']=='before_recheck' and h['closed'])
                        or (h['when']=='before_capture' and not h['closed'])
                        or (h['when']=='before_open' and not h['closed'] and op=='open')
                        or (h['when']=='before_recheck_open' and h['closed'] and op=='open')):fire(h)
    def pin(info):return _coarse(info,stable_dir) if coarse else info
    def stat_(path,*args,**kwargs):access('stat',path,kwargs);return pin(_real_stat(path,*args,**kwargs))
    def lstat_(path,*args,**kwargs):access('lstat',path,kwargs);return pin(_real_lstat(path,*args,**kwargs))
    def fstat_(fd):
        info=pin(_real_fstat(fd))
        for h in hooks:
            if fd in h['fds'] and h['when']=='capture_fstat':fire(h)
        return info
    def open_(path,flags,*args,**kwargs):
        access('open',path,kwargs);fd=_real_open(path,flags,*args,**kwargs)
        if kwargs.get('dir_fd') is not None:
            for h in hooks:
                if path==h['trigger'] and not h['closed'] and not h['done']:h['fds'].add(fd)
                elif path==h['trigger'] and h['closed'] and not h['done']:h['rfds'].add(fd)
        return fd
    def read_(fd,size):
        chunk=_real_read(fd,size)
        if not chunk:
            for h in hooks:
                if fd in h['fds'] and h['when']=='captured':fire(h)
                if fd in h['rfds'] and h['when']=='rechecked':fire(h)
        return chunk
    def close_(fd):
        result=_real_close(fd)
        for h in hooks:
            h['rfds'].discard(fd)
            if fd in h['fds']:
                h['fds'].discard(fd);h['closed']=True
                if h['when']=='captured':fire(h)
        return result
    class Entry:
        def __init__(self,entry):self._entry=entry;self.name=entry.name;self.path=entry.path
        def __fspath__(self):return self._entry.__fspath__()
        def inode(self):return self._entry.inode()
        def is_dir(self,**kwargs):return self._entry.is_dir(**kwargs)
        def is_file(self,**kwargs):return self._entry.is_file(**kwargs)
        def is_symlink(self):return self._entry.is_symlink()
        def stat(self,**kwargs):return pin(self._entry.stat(**kwargs))
    class Scan:
        def __init__(self,scan):self._scan=scan
        def __enter__(self):return self
        def __exit__(self,*exc):self._scan.close()
        def __iter__(self):return (Entry(entry) for entry in self._scan)
        def __next__(self):return Entry(next(self._scan))
        def close(self):self._scan.close()
    def scandir_(*args,**kwargs):return Scan(_real_scandir(*args,**kwargs))
    stack=contextlib.ExitStack()
    for name,value in (('stat',stat_),('lstat',lstat_),('fstat',fstat_),('scandir',scandir_),('open',open_),('read',read_),('close',close_)):
        stack.enter_context(patch.object(os,name,value))
    return stack

def rewrite(path,replacement,*,identical=False):
    """In-place rewrite: same inode, same size (builtin open, not os.*)."""
    def action():
        original=path.read_bytes()
        assert len(original)==len(replacement) and (original==replacement)==identical,'bad test rewrite'
        with open(path,'r+b') as handle:handle.write(replacement)
    return action

def private_dir(td,files):
    private=Path(td)/'private';private.mkdir(mode=0o700)
    for name,raw in files.items():
        path=private/name;path.write_bytes(raw);path.chmod(0o600)
    return private

def read(private,**options):
    return m.read_private_state(private,owner=os.geteuid(),group=GROUP,**options)

def require_fired(hooks,label):
    for h in hooks:
        if not h['done']:
            raise AssertionError('TEST HOOK DID NOT FIRE ('+label+', '+h['when']+' '+h['trigger']
                                 +'): the reader I/O path is not the one this test models; not a verdict on the reader')

def expect_rejected(private,hooks,code,label,stable_dir=False,**options):
    with harness(*hooks,stable_dir=stable_dir):
        try:result=read(private,**options)
        except m.SnapshotError as exc:error=str(exc)
        else:error=None
    require_fired(hooks,label)
    if error is None:
        raise AssertionError(label+' accepted as captured: companions='+repr({k:v[:40] for k,v in result.companions})
                             +' state='+repr(result.state and result.state.raw)+' journal='+repr(result.journal and result.journal.raw))
    assert error==code,label+': expected '+code+', got '+error

def expect_accepted(private,hooks,label,stable_dir=False,**options):
    with harness(*hooks,stable_dir=stable_dir):result=read(private,**options)
    require_fired(hooks,label)
    return result

# --- config hash --------------------------------------------------------------
spec=importlib.util.spec_from_file_location('cloudfront_sync_cli',files/'cloudfront-sync.py')
cf=importlib.util.module_from_spec(spec);spec.loader.exec_module(cf)
def base_config():
    return {'host_address':'192.0.2.10','firewall':{'backend':'none','ports':[443]},
            'nginx':{'enabled':False,'shared_dir':'/etc/nginx/cloudfront','bundles':[]},
            'limits':{'max_changes':10,'min_ratio':.8},'notify_unit':''}
# sha256 of the canonical base_config() as the ledger (_ledger_basic_p) has
# computed and persisted it so far. Pinned so that the public function cannot
# change the value of P/state/journal config_hash already on hosts.
BASE_CONFIG_HASH='c8c88ad9e204b1405008cc5c1dbe8083b460c1a171ff849fd636eded5443344f'
def realistic_configs():
    """Configs the CLI's validate_config accepts, for the none backend the
    ledger compiles without host evidence."""
    variants=[]
    def variant(**changes):
        c=base_config()
        for path,value in changes.items():
            node=c;keys=path.split('__')
            for key in keys[:-1]:node=node[key]
            node[keys[-1]]=value
        variants.append(c)
    variant()
    variant(host_address='2001:db8::10')
    variant(firewall__ports=[8443,443,80])
    variant(firewall__ports=[65535,1])
    variant(limits__max_changes=1000,limits__min_ratio=1)
    variant(limits__max_changes=1,limits__min_ratio=1.0)
    variant(limits__min_ratio=0.000001)
    variant(notify_unit='mail-alert@cloudfront-sync.service')
    variant(nginx__shared_dir='/etc/common-sv/nginx/cloudfront')
    for c in variants:cf.validate_config(c)
    return variants
def none_ledger_args(c,config_hash):
    p={'integrity_format':'pt-kernel-v1','backend':'none','config_hash':config_hash,'enrollment_id':'b'*32,
       'profile_id':'none','inventory':None,'owned_rules':[],'protected_context':None}
    return {'config_bytes':encoded(c),'before_state_bytes':None,'baseline_bytes':encoded(p),'before':None,'protected_context':None,
            'target':{'ranges':['192.0.2.0/24','2001:db8::/32'],'aws_sync_token':'11'},
            'nginx':m.nginx_ledger_input(m.NotApplicable('nginx')),
            'code_generation':'c'*64,'created_at':10,'companions':{}}
def require_public():
    assert callable(getattr(m,'config_hash',None)),'cloudfront_snapshot.config_hash is missing'
'''.replace('FILES_PATH',repr(str(FILES)))


class PrivateStateContentRecheckTests(unittest.TestCase):
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_model_pins_every_stat_path(self):
  # Guards the model: under the harness an in-place same-size rewrite is
  # metadata-identical through os.stat, os.lstat, os.fstat and DirEntry.stat.
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,{'pending.json':b'{"version":1}'})
    with harness():
     dfd=os.open(private,os.O_RDONLY|os.O_DIRECTORY)
     def views():
      fd=os.open('pending.json',os.O_RDONLY,dir_fd=dfd)
      try:fstat=m._fs_identity(os.fstat(fd))
      finally:os.close(fd)
      with os.scandir(dfd) as scan:entry=[m._fs_identity(e.stat(follow_symlinks=False)) for e in scan]
      return (m._fs_identity(os.stat('pending.json',dir_fd=dfd,follow_symlinks=False)),
              m._fs_identity(os.lstat('pending.json',dir_fd=dfd)),fstat,entry[0])
     before=views()
     rewrite(private/'pending.json',b'{"version":2}')()
     after=views()
     os.close(dfd)
    assert len(set(before))==1 and before==after,(before,after)
  ''')
 def test_same_metadata_change_of_each_file_right_after_its_capture(self):
  # Each captured file (first, middle, last in capture order) is rewritten
  # right after its own capture.
  self.check('''
   names={'intent.json':b'{"version":1}','operation-receipt.json':b'{"version":1}','pending.json':b'{"version":1}'}
   for target in sorted(names):
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,names)
     expect_rejected(private,[hook(target,'captured',rewrite(private/target,b'{"version":2}'))],
                     'private_state_file_changed','same-metadata change of '+target)
  ''')
 def test_earlier_file_changed_after_the_last_capture_needs_final_recheck(self):
  # The earlier files are rewritten only once the LAST file has been
  # captured: a per-file re-read right after each capture cannot see it;
  # only a recheck after every file is captured can.
  self.check('''
   names={'intent.json':b'{"version":1}','operation-receipt.json':b'{"version":1}','pending.json':b'{"version":1}'}
   last=sorted(names)[-1]
   for target in sorted(names)[:-1]:
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,names)
     expect_rejected(private,[hook(last,'captured',rewrite(private/target,b'{"version":2}'))],
                     'private_state_file_changed','change of '+target+' after the last capture')
  ''')
 def test_large_file_last_byte_change_is_rejected(self):
  # Larger than one 64 KiB read chunk; only the final byte differs.
  self.check('''
   size=70000;first=b'{"pad":"'+b'a'*(size-11)+b'"}\\n';second=first[:-1]+b' '
   assert len(first)==size and len(second)==size
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,{'pending.json':first})
    expect_rejected(private,[hook('pending.json','captured',rewrite(private/'pending.json',second))],
                    'private_state_file_changed','last-byte change of a 70000-byte file')
  ''')
 def test_state_json_same_metadata_change_is_rejected(self):
  self.check('''
   first=encoded({'version':1,'initialized':True});second=encoded({'version':3,'initialized':True})
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,{'state.json':first})
    expect_rejected(private,[hook('state.json','captured',rewrite(private/'state.json',second))],
                    'private_state_file_changed','same-metadata state.json change')
  ''')
 def test_journal_json_same_metadata_change_is_rejected(self):
  self.check('''
   p={'integrity_format':'pt-kernel-v1','backend':'none','config_hash':'a'*64,'enrollment_id':'b'*32,
      'profile_id':'none','inventory':None,'owned_rules':[]}
   def journal(transaction):
    return encoded({'version':2,'journal_format':'pt-kernel-v1','generation_id':'c'*64,'config_hash':'a'*64,'enrollment_id':'b'*32,
                    'transaction_id':transaction*64,'phase':'prepared','frontier':0,'step_count':0,'baseline':p})
   first,second=journal('d'),journal('e')
   assert m.parse_journal(first).disposition==m.parse_journal(second).disposition=='manual_ledger_not_connected'
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,{'journal.json':first})
    expect_rejected(private,[hook('journal.json','captured',rewrite(private/'journal.json',second))],
                    'private_state_file_changed','same-metadata journal.json change')
  ''')
 def test_file_removed_after_capture_is_file_changed(self):
  # Decided: a captured file that is gone when it is rechecked is
  # private_state_file_changed (not private_state_unavailable).
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   for target in sorted(names):
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,names)
     expect_rejected(private,[hook(target,'before_recheck',(private/target).unlink)],
                     'private_state_file_changed','removal of '+target+' before its recheck')
  ''')
 def test_symlink_or_inode_swap_after_capture_is_rejected(self):
  # Regression guard: name rebinding is caught even with pinned timestamps.
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   def symlink_swap(private,target):
    def action():
     outside=private.parent/'outside';outside.write_bytes(names[target]);outside.chmod(0o600)
     link=private.parent/'link';os.symlink(outside,link);os.replace(link,private/target)
    return action
   def inode_swap(private,target):
    def action():
     fresh=private/'fresh';fresh.write_bytes(names[target]);fresh.chmod(0o600);os.replace(fresh,private/target)
    return action
   for swap in (symlink_swap,inode_swap):
    for target in sorted(names):
     with tempfile.TemporaryDirectory(dir=TMP) as td:
      private=private_dir(td,names)
      expect_rejected(private,[hook(target,'before_recheck',swap(private,target))],
                      'private_state_file_changed',swap.__name__+' of '+target)
  ''')
 def test_unchanged_and_identical_rewrite_are_accepted(self):
  # No false positive: unchanged content, and an in-place rewrite with the
  # identical bytes after capture, are both accepted under the same model.
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,names)
    result=expect_accepted(private,[],'unchanged')
    assert result.disposition=='pending_or_companion_manual',result.disposition
    assert dict(result.companions)==names
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,names)
    result=expect_accepted(private,[hook('pending.json','captured',rewrite(private/'intent.json',b'{"version":1}',identical=True))],'identical rewrite')
    assert dict(result.companions)==names
  ''')
 def test_exact_total_budget_is_not_double_counted(self):
  # The re-read must not be charged against max_total again: a namespace
  # whose capture is exactly max_total (and each file exactly max_record)
  # is accepted.
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":2}'}
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,names)
    result=expect_accepted(private,[],'exact budget',max_record=13,max_total=26)
    assert dict(result.companions)==names
  ''')


class ConfigHashTests(unittest.TestCase):
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_public_config_hash_value_is_the_persisted_form(self):
  # Bare 64-digit lowercase hex (parse_p checks _hex(config_hash)), equal to
  # sha256(_canonical(config)) and to the pinned golden value, so baselines,
  # states and journals already persisted stay valid.
  self.check('''
   require_public()
   assert m.config_hash(base_config())==BASE_CONFIG_HASH,m.config_hash(base_config())
   for c in realistic_configs():
    value=m.config_hash(c)
    assert type(value) is str and m._hex(value),value
    assert value==hashlib.sha256(m._canonical(c)).hexdigest(),c
  ''')
 def test_config_hash_is_what_the_ledger_accepts(self):
  self.check('''
   require_public()
   configs=realistic_configs()
   assert len({m.config_hash(c) for c in configs})==len(configs),'distinct configs share a hash'
   for c in configs:
    assert m.compile_ledger(**none_ledger_args(c,m.config_hash(c))).disposition=='validated_data_only'
    other=('0' if m.config_hash(c)[0]!='0' else '1')+m.config_hash(c)[1:]
    try:m.compile_ledger(**none_ledger_args(c,other))
    except m.SnapshotError as exc:assert str(exc)=='ledger_p_context',str(exc)
    else:raise AssertionError('ledger accepted a config_hash that is not config_hash(config)')
  ''')
 def test_ledger_derives_the_hash_from_the_public_function(self):
  # With config_hash replaced, the ledger follows the replacement: it uses
  # the public function, not an inline computation of its own.
  self.check('''
   require_public()
   c=base_config();real=hashlib.sha256(m._canonical(c)).hexdigest()
   with patch.object(m,'config_hash',lambda config:'f'*64):
    assert m.compile_ledger(**none_ledger_args(c,'f'*64)).disposition=='validated_data_only'
    try:m.compile_ledger(**none_ledger_args(c,real))
    except m.SnapshotError as exc:assert str(exc)=='ledger_p_context',str(exc)
    else:raise AssertionError('ledger accepted the inline sha256(_canonical(config)) instead of config_hash(config)')
  ''')
 def test_cli_delegates_to_the_public_function(self):
  # The CLI depends only on the snapshot module's public config_hash: no
  # re-implementation and no use of its private _canonical.
  self.check('''
   fake=types.SimpleNamespace(config_hash=lambda config:'e'*64)
   for c in realistic_configs():
    try:value=cf.snapshot_config_hash(fake,c)
    except AttributeError as exc:raise AssertionError('snapshot_config_hash needs more than config_hash: '+str(exc))
    assert value=='e'*64,value
  ''')

class PrivateStateReaderBoundaryTests(unittest.TestCase):
 """Review 7: the listing is final, every OSError is a fixed code, and
 replacement between listing and capture reads like replacement at recheck."""
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_private_name_changed_during_recheck_is_directory_changed(self):
  # The directory is listed again after the content recheck. stable_dir models
  # a directory whose metadata does not change when a name is added or
  # removed, so only the names themselves can reveal it.
  self.check('''
   def create(private,name):
    def action():
     path=private/name;path.write_bytes(b'{"version":9}');path.chmod(0o600)
    return action
   for name in ('intent.json','stray'):
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,{'pending.json':b'{"version":1}'})
     expect_rejected(private,[hook('pending.json','before_recheck',create(private,name))],
                     'private_state_directory_changed','creation of '+name+' during the recheck',stable_dir=True)
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=private_dir(td,{'intent.json':b'{"version":1}','pending.json':b'{"version":1}'})
    expect_rejected(private,[hook('pending.json','before_recheck',(private/'intent.json').unlink)],
                    'private_state_directory_changed','removal of a rechecked file during the recheck',stable_dir=True)
  ''')
 def test_ancestor_failures_are_a_fixed_code_and_absence_stays_a_disposition(self):
  self.check('''
   def expect_unavailable(path,label,patched=None):
    with (patch.object(os,'open',patched) if patched else contextlib.nullcontext()):
     try:result=read(path)
     except m.SnapshotError as exc:
      assert exc.args==('private_state_unavailable',),label+': '+repr(exc.args)
      assert exc.__cause__ is None and exc.__suppress_context__,label+': chained cause'
     except OSError as exc:raise AssertionError(label+': raw '+type(exc).__name__+' leaked') from None
     else:raise AssertionError(label+' read as '+result.disposition)
   def failing(part,code):
    def open_(path,flags,*args,**kwargs):
     if path==part:raise OSError(code,os.strerror(code),'/secret/'+part)
     return _real_open(path,flags,*args,**kwargs)
    return open_
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    base=Path(td)
    expect_unavailable(base/'missing'/'private','missing ancestor')
    (base/'file').write_bytes(b'x')
    expect_unavailable(base/'file'/'private','regular-file ancestor')
    real=base/'real';real.mkdir(mode=0o700);(base/'link').symlink_to(real)
    expect_unavailable(base/'link'/'private','symlink ancestor')
    gate=base/'gate';gate.mkdir(mode=0o700)
    for code in (errno.EACCES,errno.EIO,errno.ENOENT,errno.ENOTDIR):
     expect_unavailable(gate/'private',code_name(code)+' opening an ancestor',failing('gate',code))
    if os.geteuid()!=0:
     gate.chmod(0)
     try:expect_unavailable(gate/'private','unreadable ancestor')
     finally:gate.chmod(0o700)
    # Only the leaf's absence below an intact parent is a disposition.
    assert read(gate/'private').disposition=='private_directory_absent'
  ''')
 def test_replacement_between_listing_and_capture_is_file_changed(self):
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   def symlink_swap(private,target):
    def action():
     outside=private.parent/'outside';outside.write_bytes(names[target]);outside.chmod(0o600)
     link=private.parent/'link';os.symlink(outside,link);os.replace(link,private/target)
    return action
   for target in sorted(names):
    cases=[('before_capture',lambda private:(private/target).unlink,'private_state_file_changed','removal after the listing'),
           ('before_open',lambda private:(private/target).unlink,'private_state_file_changed','removal before its open'),
           ('before_open',lambda private:symlink_swap(private,target),'private_state_file_changed','symlink swap before its open'),
           # An errno alone is never a replacement: the name still has the
           # listed identity, so the cause stays visible as unavailable.
           ('before_capture',lambda private:raiser(errno.ENOENT),'private_state_unavailable','injected ENOENT, name unchanged'),
           ('before_open',lambda private:raiser(errno.ELOOP),'private_state_unavailable','injected ELOOP, name unchanged'),
           ('before_open',lambda private:raiser(errno.EISDIR),'private_state_unavailable','injected EISDIR, name unchanged'),
           ('before_open',lambda private:raiser(errno.ENXIO),'private_state_unavailable','injected ENXIO, name unchanged'),
           ('before_capture',lambda private:raiser(errno.EACCES),'private_state_unavailable','EACCES after the listing'),
           ('before_open',lambda private:raiser(errno.EACCES),'private_state_unavailable','EACCES at its open'),
           ('before_open',lambda private:raiser(errno.EIO),'private_state_unavailable','EIO at its open')]
    for when,make,code,label in cases:
     with tempfile.TemporaryDirectory(dir=TMP) as td:
      private=private_dir(td,names)
      expect_rejected(private,[hook(target,when,make(private))],code,label+' of '+target)
  ''')
 def test_recheck_open_failures_are_classified_like_the_capture(self):
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   for target in sorted(names):
    cases=[(lambda private:(private/target).unlink,'private_state_file_changed','removal before the recheck open'),
           (lambda private:raiser(errno.ENXIO),'private_state_unavailable','injected ENXIO at the recheck open, name unchanged'),
           (lambda private:raiser(errno.ELOOP),'private_state_unavailable','injected ELOOP at the recheck open, name unchanged'),
           (lambda private:raiser(errno.EACCES),'private_state_unavailable','EACCES at the recheck open'),
           (lambda private:raiser(errno.EIO),'private_state_unavailable','EIO at the recheck open')]
    for make,code,label in cases:
     with tempfile.TemporaryDirectory(dir=TMP) as td:
      private=private_dir(td,names)
      expect_rejected(private,[hook(target,'before_recheck_open',make(private))],code,label+' of '+target)
  ''')
 def test_recheck_matches_identity_again_after_its_read(self):
  # The name is rebound to a fresh inode with identical bytes once the
  # recheck's bounded read has ended: the bytes match, so only the
  # post-read identity match (as in the capture) can see it. os.replace
  # unlinks the read inode (its fstat link count drops to 0); moving it
  # aside keeps that inode's fstat identity, so only the name's lstat
  # differs.
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   def replace_swap(private,target):
    def action():
     fresh=private/'fresh';fresh.write_bytes(names[target]);fresh.chmod(0o600);os.replace(fresh,private/target)
    return action
   def move_aside_swap(private,target):
    def action():
     os.rename(private/target,private.parent/'moved')
     fresh=private/target;fresh.write_bytes(names[target]);fresh.chmod(0o600)
    return action
   for swap in (replace_swap,move_aside_swap):
    for target in sorted(names):
     with tempfile.TemporaryDirectory(dir=TMP) as td:
      private=private_dir(td,names)
      expect_rejected(private,[hook(target,'rechecked',swap(private,target))],
                      'private_state_file_changed',swap.__name__+' after the recheck read of '+target,stable_dir=True)
   for target in sorted(names):
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,names)
     result=expect_accepted(private,[hook(target,'rechecked',lambda:None)],'no change after the recheck read of '+target,stable_dir=True)
     assert dict(result.companions)==names
  ''')

class PrivateStateReaderReview8Tests(unittest.TestCase):
 """Review 8: the private directory replaced between its lstat and its open
 is private_state_directory_changed; a read past an already checked size
 is a concurrent change; no descriptor leaks when an fstat fails."""
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_directory_replaced_between_its_lstat_and_open_is_directory_changed(self):
  self.check('''
   def aside(private):
    def action():os.rename(private,private.parent/'aside')
    return action
   def symlink_swap(private):
    def action():os.rename(private,private.parent/'aside');os.symlink(private.parent/'aside',private)
    return action
   def file_swap(private):
    def action():os.rename(private,private.parent/'aside');private.write_bytes(b'x');private.chmod(0o600)
    return action
   cases=[(aside,'private_state_directory_changed','directory moved away'),
          (symlink_swap,'private_state_directory_changed','directory rebound to a symlink'),
          (file_swap,'private_state_directory_changed','directory rebound to a regular file'),
          # An errno alone is never a replacement: the directory still has
          # the lstat-ed identity, so the cause stays visible as unavailable.
          (lambda private:raiser(errno.ENOENT),'private_state_unavailable','injected ENOENT at its open, name unchanged'),
          (lambda private:raiser(errno.ELOOP),'private_state_unavailable','injected ELOOP at its open, name unchanged'),
          (lambda private:raiser(errno.ENOTDIR),'private_state_unavailable','injected ENOTDIR at its open, name unchanged'),
          (lambda private:raiser(errno.EACCES),'private_state_unavailable','EACCES at its open'),
          (lambda private:raiser(errno.EIO),'private_state_unavailable','EIO at its open')]
   # The leaf is not named 'private': on macOS the ancestor /private (of
   # /private/tmp) would match the hook's trigger name.
   def leaf_dir(td):
    leaf=Path(td)/'cfleaf';leaf.mkdir(mode=0o700)
    path=leaf/'pending.json';path.write_bytes(b'{"version":1}');path.chmod(0o600)
    return leaf
   for make,code,label in cases:
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=leaf_dir(td)
     hooks=[hook('cfleaf','before_open',make(private))]
     with harness(*hooks):
      try:result=read(private)
      except m.SnapshotError as exc:error=exc
      else:raise AssertionError(label+' read as '+result.disposition)
     require_fired(hooks,label)
     assert error.args==(code,),label+': expected '+code+', got '+repr(error.args)
     # The OSError (with its path) is never chained into the fixed code.
     assert error.__cause__ is None and error.__suppress_context__,label+': chained cause'
  ''')
 def test_read_past_a_checked_size_is_file_changed(self):
  # The lstat already checked each size against max_record and the
  # remaining whole budget, and the descriptor's fstat matched that lstat:
  # a byte appended after that match is a concurrent change, never a
  # budget verdict.
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":2}'}
   def append(path):
    def action():
     with open(path,'ab') as handle:handle.write(b' ')
    return action
   for target,options,label in (('pending.json',{'max_record':13,'max_total':26},'last file at exactly the remaining whole budget'),
                                ('pending.json',{'max_record':13,'max_total':100},'last file at exactly max_record'),
                                ('intent.json',{'max_record':13,'max_total':26},'first file at exactly max_record')):
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,names)
     expect_rejected(private,[hook(target,'capture_fstat',append(private/target))],
                     'private_state_file_changed',label,**options)
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,names)
     result=expect_accepted(private,[hook(target,'capture_fstat',lambda:None)],label+' unchanged',**options)
     assert dict(result.companions)==names
  ''')
 def test_no_descriptor_leaks_when_any_fstat_fails(self):
  # Every os.fstat of a read (the root and each ancestor in both parent
  # walks, the directory and every capture/recheck descriptor) is failed in
  # turn; every descriptor opened by os.open must be closed again.
  self.check('''
   def run(private,fail_at,failing='fstat'):
    opened=set();calls={'fstat':0,'close':0}
    def open_(path,flags,*args,**kwargs):
     fd=_real_open(path,flags,*args,**kwargs);opened.add(fd);return fd
    def close_(fd):
     # Linux semantics: the descriptor is released even when close fails.
     opened.discard(fd);result=_real_close(fd);calls['close']+=1
     if failing=='close' and calls['close']==fail_at:raise OSError(errno.EIO,os.strerror(errno.EIO))
     return result
    def fstat_(fd):
     calls['fstat']+=1
     if failing=='fstat' and calls['fstat']==fail_at:raise OSError(errno.EIO,os.strerror(errno.EIO))
     return _real_fstat(fd)
    with patch.object(os,'open',open_),patch.object(os,'close',close_),patch.object(os,'fstat',fstat_):
     try:result=read(private)
     except m.SnapshotError as exc:outcome=str(exc)
     except OSError as exc:outcome='raw '+code_name(exc.errno)
     else:outcome=result.disposition
    return calls[failing],sorted(opened),outcome
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    present=private_dir(td,{'intent.json':b'{"version":1}','pending.json':b'{"version":1}'})
    absent=Path(td)/'absent'/'private';absent.parent.mkdir(mode=0o700)
    for private,disposition in ((present,'pending_or_companion_manual'),(absent,'private_directory_absent')):
     total,leaked,outcome=run(private,0)
     assert (leaked,outcome)==([],disposition),(private.name,leaked,outcome)
     assert total>=len(private.parts),(private,total)
     for fail_at in range(1,total+1):
      _,leaked,outcome=run(private,fail_at)
      assert leaked==[],'fstat #%d of %d leaked %r (%s)'%(fail_at,total,leaked,outcome)
      assert outcome=='private_state_unavailable','fstat #%d: %s'%(fail_at,outcome)
     # A failing close (the walk closes each parent once its child is held)
     # must not leak the descriptor the walk holds either.
     closes,_,_=run(private,0,'close')
     for fail_at in range(1,closes+1):
      _,leaked,outcome=run(private,fail_at,'close')
      assert leaked==[],'close #%d of %d leaked %r (%s)'%(fail_at,closes,leaked,outcome)
  ''')


SWAPS=r'''
import socket
def _make(kind,path,stack):
 if kind=='symlink':
  outside=path.parent.parent/('outside-'+path.name);outside.write_bytes(b'{"version":1}');outside.chmod(0o600);os.symlink(outside,path)
 elif kind=='directory':path.mkdir(mode=0o700)
 elif kind=='fifo':os.mkfifo(path,0o600)
 elif kind=='socket':
  sock=stack.enter_context(socket.socket(socket.AF_UNIX,socket.SOCK_STREAM));sock.bind(str(path))
 else:raise AssertionError(kind)
def _kind(kind):
 def make(private,name,stack,aside=False):
  def action():
   if aside:os.rename(private/name,private.parent/('aside-'+name))
   _make(kind,private/name,stack)
  return action
 return make
KINDS={kind:_kind(kind) for kind in ('symlink','directory','fifo','socket')}
'''

class PrivateStateReaderReview9Tests(unittest.TestCase):
 """Review 9: replacement is decided by a fresh lstat compared with the
 identity the listing recorded, never by an errno allow-list."""
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+SWAPS+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_non_regular_name_in_the_listing_is_unsafe_file(self):
  # Already a symlink, directory, FIFO or socket when listed: an unsafe file
  # was placed there; nothing changed while it was read.
  self.check('''
   for kind in KINDS:
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,{'intent.json':b'{"version":1}'})
     with contextlib.ExitStack() as stack:
      KINDS[kind](private,'pending.json',stack)()
      expect_rejected(private,[],'private_state_unsafe_file',kind+' listed as pending.json')
  ''')
 def test_rebinding_after_the_listing_is_file_changed(self):
  # A regular file in the listing, rebound before its capture or before its
  # recheck: the listing's identity no longer matches, so the name changed
  # while it was read (never private_state_unsafe_file, never an open errno).
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   for when in ('before_capture','before_recheck_open'):
    for kind in KINDS:
     for target in sorted(names):
      with tempfile.TemporaryDirectory(dir=TMP) as td:
       private=private_dir(td,names)
       with contextlib.ExitStack() as stack:
        expect_rejected(private,[hook(target,when,KINDS[kind](private,target,stack,aside=True))],
                        'private_state_file_changed',kind+' rebound '+when+' of '+target)
  ''')
 def test_read_error_rechecks_the_name(self):
  # An OSError of the bounded read itself (not of the open) is decided the
  # same way: the name rebound meanwhile is file_changed; unchanged it is
  # unavailable.
  self.check('''
   names={'intent.json':b'{"version":1}','pending.json':b'{"version":1}'}
   for target in sorted(names):
    for rebind,code in ((False,'private_state_unavailable'),(True,'private_state_file_changed')):
     with tempfile.TemporaryDirectory(dir=TMP) as td:
      private=private_dir(td,names)
      def action(private=private,target=target,rebind=rebind):
       if rebind:
        fresh=private/'fresh';fresh.write_bytes(names[target]);fresh.chmod(0o600);os.replace(fresh,private/target)
       raise OSError(errno.EIO,os.strerror(errno.EIO),'/secret/'+target)
      expect_rejected(private,[hook(target,'capture_fstat',action)],code,('rebound' if rebind else 'unchanged')+' EIO after the open of '+target)
  ''')
 def test_directory_open_error_rechecks_the_directory(self):
  # The private directory rebound between its lstat and its open, with an
  # injected open error: the fresh lstat sees another identity.
  self.check('''
   def leaf_dir(td):
    leaf=Path(td)/'cfleaf';leaf.mkdir(mode=0o700)
    path=leaf/'pending.json';path.write_bytes(b'{"version":1}');path.chmod(0o600)
    return leaf
   for code in (errno.EACCES,errno.EIO,errno.ENOENT):
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=leaf_dir(td)
     def action(private=private,code=code):
      os.rename(private,private.parent/'aside');private.mkdir(mode=0o700)
      raise OSError(code,os.strerror(code),'/secret/cfleaf')
     hooks=[hook('cfleaf','before_open',action)]
     with harness(*hooks):
      try:result=read(private)
      except m.SnapshotError as exc:error=exc
      else:raise AssertionError('rebound directory read as '+result.disposition)
     require_fired(hooks,code_name(code))
     assert error.args==('private_state_directory_changed',),code_name(code)+': '+repr(error.args)
     assert error.__cause__ is None and error.__suppress_context__,'chained cause'
  ''')
 def test_name_gone_before_its_listing_lstat_is_file_changed(self):
  # Listed by readdir, removed before the listing's own lstat (DirEntry.stat).
  self.check('''
   for target in ('intent.json','pending.json'):
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     private=private_dir(td,{'intent.json':b'{"version":1}','pending.json':b'{"version":1}'})
     class Entry:
      def __init__(self,entry):self._entry=entry;self.name=entry.name
      def stat(self,**kwargs):
       if self.name==target:(private/target).unlink()
       return self._entry.stat(**kwargs)
     class Scan:
      def __init__(self,scan):self._scan=scan
      def __enter__(self):return self
      def __exit__(self,*exc):self._scan.close()
      def __iter__(self):return (Entry(entry) for entry in self._scan)
     with patch.object(os,'scandir',lambda fd:Scan(_real_scandir(fd))):
      try:result=read(private)
      except m.SnapshotError as exc:error=str(exc)
      else:raise AssertionError('accepted as '+result.disposition)
     assert error=='private_state_file_changed',target+': '+error
  ''')
 def test_errno_allow_lists_are_gone(self):
  self.check('''
   for name in ('_REPLACED_ERRNOS','_DIRECTORY_REPLACED_ERRNOS'):
    assert not hasattr(m,name),name+' still decides replacement by errno'
  ''')

ANCESTORS=r'''
def tree(td,with_leaf=True):
 # td/varlib stands for /var/lib, td/varlib/cfsync for its parent
 # /var/lib/cloudfront-sync, and cfleaf for the private directory (not named
 # 'private': on macOS the ancestor /private of /private/tmp matches a hook).
 varlib=Path(td)/'varlib';parent=varlib/'cfsync';parent.mkdir(parents=True,mode=0o755)
 varlib.chmod(0o755);parent.chmod(0o755)
 (varlib/'old-entry').write_bytes(b'x')
 leaf=parent/'cfleaf'
 if with_leaf:
  leaf.mkdir(mode=0o700)
  path=leaf/'pending.json';path.write_bytes(b'{"version":1}');path.chmod(0o600)
 return varlib,parent,leaf
def unrelated(varlib,parent):
 # Creation and removal of unrelated entries (mtime, ctime, size and, for a
 # directory, the link count of the ancestor change) plus a plain touch.
 def action():
  (varlib/'unrelated-dir').mkdir();(varlib/'old-entry').unlink()
  (parent/'unrelated-file').write_bytes(b'y')
  os.utime(varlib,ns=(10**9,10**9));os.utime(parent,ns=(10**9,10**9))
 return action
def replace(ancestor,child=None):
 # The ancestor replaced by another directory of the same name, mode and
 # owner (another inode); its child, if any, is moved into the new one.
 def action():
  old=ancestor.with_name(ancestor.name+'-old');mode=stat.S_IMODE(os.lstat(ancestor).st_mode)
  os.rename(ancestor,old);ancestor.mkdir();ancestor.chmod(mode)
  if child is not None:os.rename(old/child,ancestor/child)
 return action
def outcome(path,hooks,coarse):
 with harness(*hooks,coarse=coarse):
  try:result=read(path)
  except m.SnapshotError as exc:result=exc.args[0]
  else:result=result.disposition
 require_fired(hooks,'ancestor')
 return result
'''

class PrivateStateReaderReview10Tests(unittest.TestCase):
 '''Review 10: the ancestors ('/', ..., /var/lib, the parent) are held only
 to what replacement changes (st_dev, st_ino, st_mode, st_uid, st_gid); an
 unrelated entry created or removed in them (mtime, ctime, nlink, size) is
 no private_state_parent_changed. The private directory itself stays held to
 its full identity.'''
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+ANCESTORS+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_unrelated_entries_in_ancestors_while_reading_are_accepted(self):
  # Real timestamps (coarse=False): the ancestors' metadata really changes.
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    varlib,parent,leaf=tree(td)
    got=outcome(leaf,[hook('pending.json','captured',unrelated(varlib,parent))],coarse=False)
    assert got=='pending_or_companion_manual','present: '+got
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    varlib,parent,leaf=tree(td,with_leaf=False)
    got=outcome(leaf,[hook('cfleaf','before_capture',unrelated(varlib,parent))],coarse=False)
    assert got=='private_directory_absent','absent: '+got
  ''')
 def test_ancestor_replaced_by_another_directory_is_parent_changed(self):
  self.check('''
   cases=(('parent',lambda varlib,parent:replace(parent)),
          ('/var/lib',lambda varlib,parent:replace(varlib,'cfsync')))
   for label,make in cases:
    with tempfile.TemporaryDirectory(dir=TMP) as td:
     varlib,parent,leaf=tree(td,with_leaf=False)
     got=outcome(leaf,[hook('cfleaf','before_capture',make(varlib,parent))],coarse=False)
     assert got=='private_state_parent_changed','absent leaf, '+label+' replaced: '+got
   # The private directory moved into the new parent keeps its identity
   # under the coarse model (pinned times): only the parent's inode differs.
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    varlib,parent,leaf=tree(td)
    got=outcome(leaf,[hook('pending.json','captured',replace(parent,'cfleaf'))],coarse=True)
    assert got=='private_state_parent_changed','present leaf, parent replaced: '+got
   # A mode or owner change of an ancestor is still a change.
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    varlib,parent,leaf=tree(td,with_leaf=False)
    got=outcome(leaf,[hook('cfleaf','before_capture',lambda:parent.chmod(0o750))],coarse=False)
    assert got=='private_state_parent_changed','parent mode changed: '+got
  ''')
 def test_private_directory_itself_is_still_held_to_its_full_identity(self):
  # A name added to the private directory changes only its own metadata
  # (mtime/ctime/size/nlink); the leaf comparison must keep seeing it.
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    varlib,parent,leaf=tree(td)
    def touch():os.utime(leaf,ns=(10**9,10**9))
    got=outcome(leaf,[hook('pending.json','rechecked',touch)],coarse=False)
    assert got=='private_state_directory_changed','leaf touched: '+got
  ''')

if __name__=='__main__':unittest.main()
