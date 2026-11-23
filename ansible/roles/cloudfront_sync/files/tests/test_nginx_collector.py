"""nginx Collector, admit_policy and their wiring (Snapshotter, admission, ledger, CLI).

Each test runs in a fresh interpreter with a private module graph. Files are
read from a temporary root; commands go to a fake runner (the real
ufw_observation._stream is a tripwire). No host command, network or write
outside the temporary root.
"""
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest
FILES=Path(__file__).parents[1]
PRELUDE=r'''
import contextlib,copy,dataclasses,functools,hashlib,io,json,math,os,secrets,signal,stat,sys,tempfile,types
from pathlib import Path
from unittest.mock import patch
files=Path(FILES_PATH)
if sys.platform=='linux' and os.geteuid()!=0 and hasattr(os,'O_NOATIME'):del os.O_NOATIME
for name in ('ufw_integrity','ufw_kernel','ufw_kernel_mapping','ufw_docker_kernel','ufw_docker_transition','ufw_observation','nginx_observation','cloudfront_snapshot'):
 module=types.ModuleType(name);module.__file__=str(files/(name+'.py'));sys.modules[name]=module
 exec(compile((files/(name+'.py')).read_bytes(),module.__file__,'exec'),module.__dict__)
n=sys.modules['nginx_observation'];m=sys.modules['cloudfront_snapshot'];ob=sys.modules['ufw_observation']
UID=os.geteuid()
TMP=str(Path('/tmp').resolve())
SECRET='cf-s1-origin-secret-'+secrets.token_hex(16)
SHARED='/etc/nginx/cloudfront'
GEO_INCLUDE=SHARED+'/cloudfront-geo.conf';REAL_INCLUDE=SHARED+'/cloudfront-realip.conf'
MAIN_PATH='/etc/nginx/nginx.conf';GEO_PATH='/etc/nginx/conf.d/cloudfront-origin.conf';REALIP_PATH='/etc/nginx/sites-enabled/origin.conf'
BUNDLES=((GEO_PATH,REALIP_PATH),)
CONFIG_BUNDLES=[{'geo_file':GEO_PATH,'realip_file':REALIP_PATH}]
GEO=('geo $realip_remote_addr $cloudfront_origin {\n    include '+GEO_INCLUDE+';\n    default 0;\n}\n'
     'map $http_x_origin_verify $origin_ok {\n    default 0;\n    "'+SECRET+'" 1;\n}\n').encode()
REALIP=('server {\n    listen 443 ssl;\n    include '+REAL_INCLUDE+';\n    real_ip_header X-Forwarded-For;\n'
        '    real_ip_recursive off;\n    if ($origin_ok = "0") { return 403; }\n}\n').encode()
GEO_SHARED=b'13.32.0.0/15 1;\n2600:9000::/28 1;\n'
REAL_SHARED=b'set_real_ip_from 13.32.0.0/15;\nset_real_ip_from 2600:9000::/28;\n'
RANGES=('13.32.0.0/15','2600:9000::/28')
MAIN=b'http {\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}\n'
OS_RELEASE=b'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n'
# systemctl show's ExecStart of Ubuntu's packaged nginx.service, as printed by
# systemd 249 (22.04), 255 (24.04) and 259 (26.04): argv joined by spaces, unquoted.
PACKAGED_ARGV='/usr/sbin/nginx -g daemon on; master_process on;'
def exec_start(argv=PACKAGED_ARGV,path='/usr/sbin/nginx',errors='no'):
 return ('{ path='+path+' ; argv[]='+argv+' ; ignore_errors='+errors+' ; start_time=[Mon 2026-11-23 11:08:00 JST]'
         ' ; stop_time=[Mon 2026-11-23 11:08:00 JST] ; pid=233340 ; code=exited ; status=0 }')
DAEMON=('Id=nginx.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=1234\nExecStart='+exec_start()+'\n').encode()
FILE_BYTES={GEO_INCLUDE:GEO_SHARED,REAL_INCLUDE:REAL_SHARED,GEO_PATH:GEO,REALIP_PATH:REALIP}
def dump_of(contents):
 sections=((MAIN_PATH,MAIN),(GEO_PATH,contents[GEO_PATH]),(GEO_INCLUDE,contents[GEO_INCLUDE]),
           (REALIP_PATH,contents[REALIP_PATH]),(REAL_INCLUDE,contents[REAL_INCLUDE]))
 return b''.join(b'# configuration file '+path.encode()+b':\n'+body+b'\n' for path,body in sections)
DUMP=dump_of(FILE_BYTES)
def write(root,logical,data,mode=0o644):
 path=Path(root+logical);path.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
 path.write_bytes(data);path.chmod(mode);return path
@contextlib.contextmanager
def host(contents=None,os_release=OS_RELEASE):
 """A temporary root: os-release, systemd-run and the managed files."""
 with tempfile.TemporaryDirectory(dir=TMP) as root:
  write(root,'/usr/lib/os-release',os_release)
  for executable in EXECUTABLES:write(root,executable,b'#!/bin/false\n',0o755)
  for directory in TMPFS_DIRECTORIES:Path(root+directory).mkdir(parents=True,mode=0o755)
  for logical,data in (contents or FILE_BYTES).items():write(root,logical,data)
  for directory in Path(root).rglob('*'):
   if directory.is_dir():directory.chmod(0o755)
  yield root
EXECUTABLES=('/usr/bin/systemd-run','/usr/sbin/nginx','/usr/bin/systemctl')
# The host directories TemporaryFileSystem= mounts over (the /dev ones are in the private /dev).
TMPFS_DIRECTORIES=('/run','/var/log/nginx','/var/lib/nginx')
@contextlib.contextmanager
def linux_root(root=None):
 """The sandbox precondition of a root Linux host; the real _stream is a tripwire.
 With root, the executables the precondition checks are the copies under root
 (absolute paths, as the check takes them); without, the real host paths. The
 copies belong to this (non-root) user, so EXECUTABLE_UID (0 on a host) is
 this user's uid here. Likewise the directories the sandbox mounts over."""
 executables=EXECUTABLES if root is None else tuple(root+path for path in EXECUTABLES)
 directories=TMPFS_DIRECTORIES if root is None else tuple(root+path for path in TMPFS_DIRECTORIES)
 with (patch.object(sys,'platform','linux'),patch.object(os,'geteuid',return_value=0),
       patch.object(ob,'_stream',side_effect=AssertionError('real command')),
       patch.object(n,'SANDBOX_EXECUTABLES',executables,create=True),
       patch.object(n,'SANDBOX_TMPFS_DIRECTORIES',directories,create=True),
       patch.object(n,'EXECUTABLE_UID',UID,create=True)):
  yield
def runner(dump=DUMP,stderr=b'',code=0,daemon=DAEMON,calls=None,hook=None):
 def run(argv,*,timeout,max_output):
  if calls is not None:calls.append((argv,timeout,max_output))
  if hook is not None:
   changed=hook(argv)
   if changed is not None:return changed
  if argv==n.DAEMON_STATE:return ob.CommandResult(daemon,b'',0)
  if argv==n.SANDBOX_DUMP:return ob.CommandResult(dump,stderr,code)
  raise AssertionError('unexpected argv')
 return run
def collector(root,**kwargs):
 kwargs.setdefault('runner',runner())
 return n.Collector(shared_dir=SHARED,bundles=BUNDLES,root=root,owner=UID,**kwargs)
def collect(root,**kwargs):
 with linux_root(root):return collector(root,**kwargs).collect()
OTHER_SHARED='/etc/nginx/cf-other'
def collect_elsewhere():
 """A collected, admissible observation whose shared_dir is OTHER_SHARED (the same bundle paths)."""
 def moved(value):return value.replace(SHARED.encode(),OTHER_SHARED.encode()) if type(value) is bytes else value.replace(SHARED,OTHER_SHARED)
 contents={moved(path):moved(body) for path,body in FILE_BYTES.items()}
 sections=((MAIN_PATH,MAIN),(GEO_PATH,contents[GEO_PATH]),(moved(GEO_INCLUDE),contents[moved(GEO_INCLUDE)]),
           (REALIP_PATH,contents[REALIP_PATH]),(moved(REAL_INCLUDE),contents[moved(REAL_INCLUDE)]))
 dump=b''.join(b'# configuration file '+path.encode()+b':\n'+body+b'\n' for path,body in sections)
 with host(contents) as root:
  with linux_root(root):return n.Collector(shared_dir=OTHER_SHARED,bundles=BUNDLES,root=root,owner=UID,runner=runner(dump=dump)).collect()
def no_secret(*values):
 for value in values:
  for text in (repr(value),str(value)):
   assert SECRET not in text and 'origin-secret' not in text,text[:200]
def fails(code,function,*args,**kwargs):
 try:function(*args,**kwargs)
 except n.NginxObservationError as error:
  assert type(error) is n.NginxObservationError and error.args==(code,),error.args
  assert error.__cause__ is None and error.__context__ is None and code in n.CODES
  no_secret(error,error.args)
  return error
 else:raise AssertionError('accepted, expected '+code)
'''.replace('FILES_PATH',repr(str(FILES)))


class NginxCollectorTests(unittest.TestCase):
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_fixed_argv_and_command_set(self):
  self.check('''
   # Read-only, still readable (as for nginx's own reload: OpenSSL reads
   # /proc/sys/crypto/fips_enabled): /proc/sys, /proc/sysrq-trigger (optional:
   # a kernel without CONFIG_MAGIC_SYSRQ lacks it), /sys and the cgroup tree.
   READ_ONLY=('/proc/sys','-/proc/sysrq-trigger','/sys','/sys/fs/cgroup')
   # ProcSubset=pid approximated: the non-process /proc entries seen on the
   # aarch64 22.04/24.04/26.04 VMs and the amd64 26.04 host (common-sv), plus
   # systemd 249's ProtectKernelTunables /proc entries; all optional.
   INACCESSIBLE=('-/proc/acpi','-/proc/apm','-/proc/asound','-/proc/bootconfig','-/proc/buddyinfo','-/proc/bus',
                 '-/proc/cgroups','-/proc/cmdline','-/proc/consoles','-/proc/cpuinfo','-/proc/crypto','-/proc/devices',
                 '-/proc/diskstats','-/proc/dma','-/proc/driver','-/proc/dynamic_debug','-/proc/execdomains','-/proc/fb',
                 '-/proc/filesystems','-/proc/fs','-/proc/interrupts','-/proc/iomem','-/proc/ioports','-/proc/irq',
                 '-/proc/kallsyms','-/proc/kcore','-/proc/key-users','-/proc/keys','-/proc/kpagecgroup',
                 '-/proc/kpagecount','-/proc/kpageflags','-/proc/latency_stats','-/proc/loadavg','-/proc/locks',
                 '-/proc/mdstat','-/proc/meminfo','-/proc/misc','-/proc/modules','-/proc/mtrr','-/proc/pagetypeinfo',
                 '-/proc/partitions','-/proc/pressure','-/proc/schedstat','-/proc/scsi','-/proc/slabinfo',
                 '-/proc/softirqs','-/proc/stat','-/proc/swaps','-/proc/sysvipc',
                 '-/proc/timer_list','-/proc/timer_stats','-/proc/tty','-/proc/uptime','-/proc/version',
                 '-/proc/version_signature','-/proc/vmallocinfo','-/proc/vmstat','-/proc/zoneinfo')
   # The non-process /proc entries collected (2026-11-23): aarch64 VMs and amd64 common-sv.
   SEEN={'aarch64-22.04':'acpi bootconfig buddyinfo bus cgroups cmdline consoles cpuinfo crypto devices diskstats driver '
         'dynamic_debug execdomains fb filesystems fs interrupts iomem ioports irq kallsyms kcore key-users keys kmsg '
         'kpagecgroup kpagecount kpageflags loadavg locks mdstat meminfo misc modules mounts net pagetypeinfo partitions '
         'pressure schedstat scsi self slabinfo softirqs stat swaps sys sysrq-trigger sysvipc thread-self timer_list tty '
         'uptime version version_signature vmallocinfo vmstat zoneinfo',
         'aarch64-24.04/26.04':'acpi bootconfig buddyinfo bus cgroups cmdline consoles cpuinfo crypto devices diskstats '
         'driver dynamic_debug execdomains fb filesystems fs interrupts iomem ioports irq kallsyms kcore key-users keys '
         'kmsg kpagecgroup kpagecount kpageflags latency_stats loadavg locks mdstat meminfo misc modules mounts net '
         'pagetypeinfo partitions pressure schedstat scsi self slabinfo softirqs stat swaps sys sysrq-trigger sysvipc '
         'thread-self timer_list tty uptime version version_signature vmallocinfo vmstat zoneinfo',
         'amd64-26.04 (common-sv)':'acpi bootconfig buddyinfo bus cgroups cmdline consoles cpuinfo crypto devices '
         'diskstats dma driver dynamic_debug execdomains fb filesystems fs interrupts iomem ioports irq kallsyms kcore '
         'key-users keys kmsg kpagecgroup kpagecount kpageflags latency_stats loadavg locks mdstat meminfo misc modules '
         'mounts mtrr net pagetypeinfo partitions pressure schedstat scsi self slabinfo softirqs stat swaps sys '
         'sysrq-trigger sysvipc thread-self timer_list tty uptime version version_signature vmallocinfo vmstat zoneinfo'}
   # Deliberately not hidden: self and thread-self (the process's own entries),
   # mounts and net (links into self), kmsg (ProtectKernelLogs= hides it),
   # sys and sysrq-trigger (READ_ONLY: readable, not writable).
   KEPT={'self','thread-self','mounts','net','kmsg','sys','sysrq-trigger'}
   assert n.SANDBOX_DUMP==('/usr/bin/systemd-run','--quiet','--wait','--pipe','--collect',
    '--service-type=exec','--property=ProtectSystem=strict','--property=PrivateTmp=yes',
    '--property=TemporaryFileSystem=/run /var/log/nginx /var/lib/nginx /dev/shm /dev/mqueue /dev/hugepages /dev/pts',
    '--property=BindReadOnlyPaths=-/run/systemd/resolve',
    '--property=NoNewPrivileges=yes','--property=PrivateDevices=yes','--property=PrivateIPC=yes',
    '--property=ReadOnlyPaths='+' '.join(READ_ONLY),
    '--property=InaccessiblePaths='+' '.join(INACCESSIBLE),
    '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    '--property=ProtectKernelModules=yes','--property=ProtectKernelLogs=yes',
    '--property=ProtectClock=yes','--property=ProtectHostname=yes',
    '--property=RestrictNamespaces=yes','--property=RestrictSUIDSGID=yes','--property=LockPersonality=yes',
    '--property=RestrictRealtime=yes','--property=SystemCallArchitectures=native','--property=SystemCallFilter=@system-service',
    '--property=CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_SETUID CAP_SETGID',
    '--property=RuntimeMaxSec=15',
    '--','/usr/sbin/nginx','-T','-q')
   # No ambient capabilities and no CAP_SYS_ADMIN, CAP_KILL or CAP_SYS_PTRACE in the bounding set.
   assert not [arg for arg in n.SANDBOX_DUMP if 'AmbientCapabilities' in arg or 'CAP_SYS_ADMIN' in arg
               or 'CAP_KILL' in arg or 'CAP_SYS_PTRACE' in arg]
   # Each property is set once (a later assignment of the same name would extend or override it).
   names=[arg.split('=',2)[1] for arg in n.SANDBOX_DUMP if arg.startswith('--property=')]
   assert len(names)==len(set(names))==22,names
   # Deliberately absent: PrivateNetwork and IPAddressDeny break resolving upstream names
   # through the 127.0.0.53 stub; PrivatePIDs needs a newer systemd than 22.04's 249.
   # ProtectProc, ProcSubset, ProtectKernelTunables and ProtectControlGroups imply
   # MountAPIVFS, whose /run mount makes systemd 249 drop TemporaryFileSystem=/run
   # (the host's /run stays writable); MountAPIVFS itself likewise.
   absent=('PrivateNetwork','IPAddressDeny','PrivatePIDs','ProtectProc','ProcSubset','ProtectKernelTunables',
           'ProtectControlGroups','MountAPIVFS')
   assert not [arg for arg in n.SANDBOX_DUMP for name in absent if name in arg]
   # Their effect, written out: the exact path lists, once each, in this order.
   values={arg.split('=',2)[1]:arg.split('=',2)[2] for arg in n.SANDBOX_DUMP if arg.startswith('--property=')}
   assert values['ReadOnlyPaths'].split(' ')==list(READ_ONLY) and values['InaccessiblePaths'].split(' ')==list(INACCESSIBLE)
   assert len(set(READ_ONLY))==len(READ_ONLY)==4 and len(set(INACCESSIBLE))==len(INACCESSIBLE)==58
   # No path in both lists: systemd keeps one mount per path (dropping the other
   # entry and its mandatory flag), so a read-only path must not be hidden too.
   assert not {path.lstrip('-') for path in READ_ONLY}&{path.lstrip('-') for path in INACCESSIBLE}
   # /proc/sys, /sys and the cgroup tree are mandatory (the unit fails without
   # them); every other entry is optional ('-': a kernel without it does not fail the unit).
   assert [path for path in READ_ONLY if not path.startswith('-')]==['/proc/sys','/sys','/sys/fs/cgroup']
   assert all(path.startswith('-/proc/') for path in INACCESSIBLE)
   # Every non-process entry collected is hidden or deliberately kept; nothing kept is hidden.
   hidden={path[len('-/proc/'):] for path in INACCESSIBLE}
   for where,names in SEEN.items():
    assert set(names.split(' '))-hidden==KEPT,(where,sorted(set(names.split(' '))-hidden-KEPT))
   assert not KEPT&hidden
   # TemporaryFileSystem= targets outside the private /dev are exactly the host
   # directories checked before each start (systemd would create a missing one
   # on the host); none under /var/cache (Ubuntu's nginx keeps nothing there).
   targets=values['TemporaryFileSystem'].split(' ')
   assert tuple(path for path in targets if not path.startswith('/dev/'))==n.SANDBOX_TMPFS_DIRECTORIES==TMPFS_DIRECTORIES
   assert not [path for path in targets if path.startswith('/var/cache')]
   # RuntimeMaxSec is the constant the constructor's timeout domain is built on.
   assert values['RuntimeMaxSec']==str(n.SANDBOX_RUNTIME_MAX_SEC)=='15'
   # Only these socket families: no AF_PACKET or any other.
   assert [arg for arg in n.SANDBOX_DUMP if 'RestrictAddressFamilies' in arg]==['--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK']
   # systemd names the transient unit itself (no fixed --unit to collide on), and
   # stdin is left to --pipe (no StandardInput property competing with it).
   assert not [arg for arg in n.SANDBOX_DUMP if arg.startswith('--unit') or 'StandardInput' in arg]
   # The precondition checks exactly the executables the commands run, at their host paths.
   assert n.SANDBOX_EXECUTABLES==('/usr/bin/systemd-run','/usr/sbin/nginx','/usr/bin/systemctl')
   assert {argv[0] for argv in n.COMMANDS}|{n.SANDBOX_DUMP[n.SANDBOX_DUMP.index('--')+1]}==set(n.SANDBOX_EXECUTABLES)
   assert n.DAEMON_STATE==('/usr/bin/systemctl','show','--property=Id,LoadState,ActiveState,SubState,MainPID,ExecStart','nginx.service')
   assert n.COMMANDS==frozenset((n.SANDBOX_DUMP,n.DAEMON_STATE))
   # nginx itself appears in no other argv: no unsandboxed nginx exists to fall back to.
   assert [argv for argv in n.COMMANDS if '/usr/sbin/nginx' in argv]==[n.SANDBOX_DUMP]
   with host() as root:
    started=[]
    def anything(argv,*,timeout,max_output):
     started.append(argv);return ob.CommandResult(b'',b'',0)
    c=collector(root,runner=anything);session=[0,math.inf,0]
    for argv in (('/usr/sbin/nginx','-T','-q'),list(n.SANDBOX_DUMP),n.SANDBOX_DUMP[:-1],('/usr/bin/systemctl','stop','nginx.service')):
     with linux_root():fails('nginx_observation_failed',c._command,argv,session)
    assert started==[]
  ''')
 def test_success_two_identical_passes_and_admission(self):
  self.check('''
   with host() as root:
    calls=[];value=collect(root,runner=runner(calls=calls))
   assert type(value) is n.NginxObservation
   assert (value.os_id,value.shared_dir,value.bundles,value.os_name,value.warnings)==('24.04',SHARED,BUNDLES,'ubuntu',0)
   assert dict(value.daemon)['MainPID']=='1234' and value.dump==DUMP and dict(value.managed)==FILE_BYTES
   assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP]*2
   assert all(0<timeout<=20 and 0<limit<=4*1024*1024 for _,timeout,limit in calls)
   assert n.admit_policy(value)==RANGES
   no_secret(value)
   # Only the OS id is shown: shared_dir and bundles are paths and stay out of the repr.
   assert repr(value)=="NginxObservation(os_id='24.04')",repr(value)
   assert SHARED not in repr(value) and GEO_PATH not in repr(value) and REALIP_PATH not in repr(value)
  ''')
 def test_constructor_zero_io_and_strict_options(self):
  self.check('''
   with patch.object(os,'open',side_effect=AssertionError('open')),patch.object(os,'stat',side_effect=AssertionError('stat')),linux_root():
    n.Collector(shared_dir=SHARED,bundles=BUNDLES)
   good=dict(shared_dir=SHARED,bundles=BUNDLES)
   for code,kwargs in (('nginx_shared_dir_invalid',dict(good,shared_dir='relative')),('nginx_shared_dir_invalid',dict(good,shared_dir='/etc/nginx/')),
                       ('nginx_managed_invalid',dict(good,bundles=())),('nginx_managed_invalid',dict(good,bundles=BUNDLES*2)),
                       ('nginx_managed_invalid',dict(good,bundles=[list(BUNDLES[0])])),('nginx_managed_invalid',dict(good,bundles=((GEO_INCLUDE,REALIP_PATH),))),
                       ('nginx_collector_invalid',dict(good,bundles=(('/etc/nginx/a/../g.conf',REALIP_PATH),))),
                       ('nginx_collector_invalid',dict(good,bundles=(('/etc/nginx//g.conf',REALIP_PATH),))),
                       ('nginx_collector_invalid',dict(good,root='relative')),('nginx_collector_invalid',dict(good,root='/a/../b')),
                       ('nginx_collector_invalid',dict(good,root=Path('/'))),('nginx_collector_invalid',dict(good,owner=True)),
                       ('nginx_collector_invalid',dict(good,owner=-1)),('nginx_collector_invalid',dict(good,command_timeout=0)),
                       ('nginx_collector_invalid',dict(good,command_timeout=61,whole_timeout=60)),('nginx_collector_invalid',dict(good,whole_timeout=math.inf)),
                       ('nginx_collector_invalid',dict(good,max_output=4*1024*1024+1)),('nginx_collector_invalid',dict(good,max_total=16*1024*1024+1)),
                       ('nginx_collector_invalid',dict(good,max_output=True)),('nginx_collector_invalid',dict(good,runner=1)),
                       ('nginx_collector_invalid',dict(good,clock='now'))):
    fails(code,lambda:n.Collector(**kwargs))
   # The timeouts' domain: command_timeout outlasts the unit's RuntimeMaxSec (15)
   # by at least 5 seconds; each pass runs two commands, systemctl show (given at
   # most DAEMON_STATE_TIMEOUT, 5) and the sandbox (given command_timeout), so
   # whole_timeout holds 2 * (command_timeout + 5) plus 10 seconds. The defaults
   # (20, 60) are the smallest such pair.
   for command_timeout,whole_timeout in ((20,60),(25,70),(20.5,61),(50,120),(20,120)):
    value=n.Collector(**dict(good,command_timeout=command_timeout,whole_timeout=whole_timeout))
    assert (value.command_timeout,value.whole_timeout)==(command_timeout,whole_timeout)
   for command_timeout,whole_timeout in ((19.999,60),(15,60),(16,60),(5,60),(1,2),(20,59.999),(20,50),(20,40),(25,69),(25,60),
                                         (50.5,120),(51,120),(56,120),(60,120),(120,120),(20,121),(True,60),(20,math.nan),(math.nan,60)):
    fails('nginx_collector_invalid',lambda:n.Collector(**dict(good,command_timeout=command_timeout,whole_timeout=whole_timeout)))
   assert (n.SANDBOX_RUNTIME_MAX_SEC,n.MIN_COMMAND_TIMEOUT,n.DAEMON_STATE_TIMEOUT,n.WHOLE_TIMEOUT_MARGIN)==(15,20,5,10)
   default=n.Collector(**good)
   assert (default.command_timeout,default.whole_timeout)==(20,60)
   assert default.whole_timeout==2*(default.command_timeout+n.DAEMON_STATE_TIMEOUT)+n.WHOLE_TIMEOUT_MARGIN
  ''')
 def test_sandbox_unavailable_never_starts_any_command(self):
  self.check('''
   def broken(root,executable,how):
    path=Path(root+executable)
    if how=='missing':path.unlink()
    elif how=='writable':path.chmod(0o775)
    elif how=='world_writable':path.chmod(0o757)
    elif how=='not_executable':path.chmod(0o644)
    elif how=='directory':path.unlink();path.mkdir()
    elif how=='symlink':
     target=write(root,executable+'-real',b'#!/bin/false\\n',0o755);path.unlink();path.symlink_to(target)
    elif how=='writable_ancestor':path.parent.chmod(0o775)
    elif how=='symlink_ancestor':
     path.parent.rename(str(path.parent)+'-real');path.parent.symlink_to(str(path.parent)+'-real')
   cases=[('platform',None,patch.object(sys,'platform','darwin')),('not_root',None,patch.object(os,'geteuid',return_value=1000)),
          ('sigchld',None,patch.object(signal,'getsignal',return_value=signal.SIG_IGN))]
   cases+=[(how,executable,None) for executable in EXECUTABLES
           for how in ('missing','writable','world_writable','not_executable','directory','symlink','writable_ancestor','symlink_ancestor')]
   for how,executable,extra in cases:
    with host() as root:
     if executable is not None:broken(root,executable,how)
     calls=[];read=[]
     real_open=os.open
     def spy(path,*a,**k):read.append(path);return real_open(path,*a,**k)
     with linux_root(root),(extra or contextlib.nullcontext()),patch.object(os,'open',side_effect=spy):
      fails('nginx_sandbox_unavailable',collector(root,runner=runner(calls=calls)).collect)
      # The default runner (ufw_observation._stream, a tripwire here) is not reached either.
      fails('nginx_sandbox_unavailable',collector(root,runner=None).collect)
     assert calls==[],(how,executable)
     # Nothing but the directories down to the executables was opened (no os-release, no managed file).
     assert not set(read)&{'os-release','cloudfront-geo.conf','cloudfront-realip.conf','origin.conf','cloudfront-origin.conf'},(how,read)
   # An executable of another owner (seen through stat), each in turn.
   for executable in EXECUTABLES:
    with host() as root:
     real_stat=os.stat;leaf=executable.rsplit('/',1)[1]
     def other(path,*a,**k):
      info=real_stat(path,*a,**k)
      if path!=leaf:return info
      values=list(info);values[stat.ST_UID]=UID+1;return os.stat_result(values)
     with linux_root(root),patch.object(os,'stat',side_effect=other):
      fails('nginx_sandbox_unavailable',collector(root).collect)
     assert collect(root).dump==DUMP
   # Any failure inside the safety check (an OSError, a ValueError, a check's own
   # code) is nginx_sandbox_unavailable, never another code.
   for raised in (OSError(5,'io'),ValueError('x'),n.NginxObservationError('nginx_observation_failed'),PermissionError(13,'denied')):
    with host() as root:
     real_fstat=os.fstat
     def flaky(fd,raised=raised):raise raised
     with linux_root(root),patch.object(os,'fstat',side_effect=flaky):
      fails('nginx_sandbox_unavailable',collector(root).collect)
  ''')
 def test_sandbox_checks_the_host_executables_not_the_read_root(self):
  self.check('''
   # The executables are checked at the absolute paths that run (the
   # constant tuple), never joined to the collector's file-read root: a root
   # tree holding good copies does not stand in for the host.
   with host() as root:
    missing=tempfile.mkdtemp(dir=TMP)
    try:
     absent=tuple(missing+path for path in EXECUTABLES)
     opened=[]
     real_open=os.open
     def spy(path,*a,**k):opened.append(path);return real_open(path,*a,**k)
     with linux_root(root),patch.object(n,'SANDBOX_EXECUTABLES',absent),patch.object(os,'open',side_effect=spy):
      fails('nginx_sandbox_unavailable',collector(root).collect)
     root_parts=set(Path(root).parts[1:])
     assert Path(missing).name in opened and not root_parts&set(opened)-set(Path(missing).parts[1:]),opened
    finally:os.rmdir(missing)
    # The same absolute paths under root are accepted as given (no second root prefix).
    assert collect(root).dump==DUMP
  ''')
 def test_executables_belong_to_uid_0_not_to_the_collector_owner(self):
  self.check('''
   # On a host the executables and their directories must be root's (uid 0),
   # whatever owner the collector requires of the managed files.
   assert n.EXECUTABLE_UID==0
   with host() as root:
    # The collector's owner differs from the executables' owner: the sandbox
    # precondition still holds and the commands run; the managed files (and
    # os-release) of another owner fail the observation.
    calls=[]
    with linux_root(root):
     fails('nginx_observation_failed',n.Collector(shared_dir=SHARED,bundles=BUNDLES,root=root,owner=UID+1,runner=runner(calls=calls)).collect)
    # An executable owned by the collector's owner but not by EXECUTABLE_UID.
    for executable in EXECUTABLES:
     real_stat=os.stat;leaf=executable.rsplit('/',1)[1]
     def owned(path,*a,**k):
      info=real_stat(path,*a,**k)
      if path!=leaf:return info
      values=list(info);values[stat.ST_UID]=UID+1;return os.stat_result(values)
     calls=[]
     with linux_root(root),patch.object(os,'stat',side_effect=owned):
      fails('nginx_sandbox_unavailable',n.Collector(shared_dir=SHARED,bundles=BUNDLES,root=root,owner=UID+1,runner=runner(calls=calls)).collect)
     assert calls==[],executable
    # A directory above an executable owned by the collector's owner only.
    for directory in ('bin','sbin'):
     real_open,real_fstat=os.open,os.fstat;fds=set()
     def spy_open(path,*a,directory=directory,**k):
      fd=real_open(path,*a,**k)
      if path==directory:fds.add(fd)
      return fd
     def spy_fstat(fd):
      info=real_fstat(fd)
      if fd not in fds:return info
      values=list(info);values[stat.ST_UID]=UID+1;return os.stat_result(values)
     calls=[]
     with linux_root(root),patch.object(os,'open',side_effect=spy_open),patch.object(os,'fstat',side_effect=spy_fstat):
      fails('nginx_sandbox_unavailable',n.Collector(shared_dir=SHARED,bundles=BUNDLES,root=root,owner=UID+1,runner=runner(calls=calls)).collect)
     assert calls==[] and fds,directory
    # Unpatched, the same tree is collected (owner and executables both UID here).
    assert collect(root).dump==DUMP
   # The managed files' directories belong to the collector's owner, the
   # executables' to EXECUTABLE_UID, even when the two differ: executables
   # (and their directories) seen as owned by another uid that is
   # EXECUTABLE_UID, managed files in a second tree owned by the collector's owner.
   with host() as exec_root,host() as root:
    other=UID+1
    keys={(info.st_dev,info.st_ino) for info in [os.stat(exec_root)]+[os.stat(exec_root+part) for part in ('/usr','/usr/bin','/usr/sbin')]
          +[os.stat(exec_root+path) for path in EXECUTABLES]}
    real_stat,real_fstat=os.stat,os.fstat
    def as_other(info):
     if (info.st_dev,info.st_ino) not in keys:return info
     values=list(info);values[stat.ST_UID]=other;return os.stat_result(values)
    with linux_root(exec_root),patch.object(n,'EXECUTABLE_UID',other),\
         patch.object(os,'stat',side_effect=lambda *a,**k:as_other(real_stat(*a,**k))),\
         patch.object(os,'fstat',side_effect=lambda fd:as_other(real_fstat(fd))):
     assert collector(root).collect().dump==DUMP
     # The same executables against EXECUTABLE_UID == the collector's owner are refused.
     with patch.object(n,'EXECUTABLE_UID',UID):fails('nginx_sandbox_unavailable',collector(root).collect)
  ''')
 def test_config_invalid_is_retired_every_nginx_failure_is_observation_failed(self):
  self.check('''
   # No classification of nginx's own failures: nginx_config_invalid and the
   # severe-line / sandbox-cause / systemd-exit-code tables are gone. Whatever
   # made nginx -T fail is read from nginx's (or systemd's) own logs.
   assert 'nginx_config_invalid' not in n.CODES and 'nginx_config_invalid' not in m.CODES
   assert m.NGINX_OBSERVATION_FAILURES==('nginx_sandbox_unavailable','nginx_observation_failed')
   for name in ('_config_invalid','SEVERE','SEVERE_LINES','SANDBOX_CAUSED','SYSTEMD_EXIT_CODES','NGINX_LINE'):
    assert not hasattr(n,name),name
   try:m.ComponentResult('failure','nginx_config_invalid')
   except m.SnapshotError as error:assert str(error)=='invalid_component_result'
   else:raise AssertionError('retired code constructed')
   with host() as root:
    for code,stderr in ((1,('nginx: [emerg] unknown directive "'+SECRET+'" in /etc/nginx/conf.d/x.conf:3\\n').encode()),
                        (1,b'nginx: [alert] x\\n'),(1,b'nginx: [crit] x\\n'),(1,b'nginx: [warn] a\\nnginx: [emerg] b\\n'),
                        (1,b'nginx: [emerg] open() "/etc/nginx/missing.conf" failed (2: No such file or directory)\\n'),
                        (1,b'nginx: [emerg] no "events" section in configuration\\nnginx: configuration file /etc/nginx/nginx.conf test failed\\n'),
                        (2,b'nginx: [emerg] x\\n'),(199,b'nginx: [emerg] x\\n'),(244,b'nginx: [emerg] x\\n')):
     fails('nginx_observation_failed',collect,root,runner=runner(code=code,stderr=stderr))
  ''')
 def test_sandbox_caused_and_other_failures_are_observation_failed(self):
  self.check('''
   emerg=b'nginx: [emerg] unknown directive "x"\\n'
   with host() as root:
    cases=(
     # A non-zero exit without an nginx severe line, or killed by a signal.
     (1,b''),(-9,b''),(-15,emerg),(255,b'nginx: [warn] x\\n'),(1,b'nginx: [warn] [emerg] in a warning\\n'),
     (1,b'nginx: [notice] x\\n'),(1,b'nginx: [error] x\\n'),
     # Exit 0 with a severe line (a successful nginx does not report one).
     (0,b'nginx: [emerg] x\\n'),(0,b'nginx: [alert] x\\n'),(0,b'nginx: [crit] x\\n'),(0,b'nginx: [warn] a\\nnginx: [crit] b\\n'),
     # Caused by the sandbox: a read-only file system, name resolution.
     (1,b'nginx: [emerg] open() "/var/lib/nginx/x" failed (30: Read-only file system)\\n'),
     (1,b'nginx: [emerg] mkdir() "/var/cache/nginx/a" failed (30: Read-only file system)\\n'),
     (1,b'nginx: [emerg] host not found in upstream "backend.internal:443" in /etc/nginx/conf.d/x.conf:2\\n'),
     (1,b'nginx: [emerg] host not found in resolver "dns.internal"\\n'),
     (1,b'nginx: [emerg] upstream "backend.internal" may not have port 0 could not be resolved\\n'),
     (1,b'nginx: [crit] x\\nnginx: [emerg] y (30: Read-only file system)\\n'),
     # systemd's reserved exit codes (200-243): the unit never ran nginx as configured.
     (226,b''),(203,b''),(200,emerg),(243,emerg),(226,emerg),(217,b'nginx: [crit] x\\n'),
     # systemd-run's own failures: unit collision, bus, rejected property, unit timeout.
     (1,b'Failed to start transient service unit: Unit run-u7.service already exists.\\n'),
     (1,b'Failed to connect to bus: No such file or directory\\n'),
     (1,b'Failed to start transient service unit: Cannot set property BindReadOnlyPaths, or unknown property.\\n'),
     (1,emerg+b'Job for run-u7.service failed because a timeout was exceeded.\\n'),
     (1,emerg+b'Failed to start transient service unit: Unit run-u7.service already exists.\\n'),
     (1,b'Running as unit: run-u7.service\\n'+emerg),
     (1,emerg[:-1]),(1,emerg+b'nginx: [emerg] unterminated'),(1,emerg+b'Failed to start transient service unit'),(1,b' '+emerg),(1,b'nginx:  [emerg] spacing\\n'),(1,(SECRET+'\\n').encode()))
    for code,stderr in cases:
     fails('nginx_observation_failed',collect,root,runner=runner(code=code,stderr=stderr))
  ''')
 def test_warning_only_stderr_is_accepted_and_counted_privately(self):
  self.check('''
   stderr=('nginx: [warn] the "listen ... http2" directive is deprecated in '+SECRET+'\\nnginx: [warn] second\\n').encode()
   with host() as root:value=collect(root,runner=runner(stderr=stderr))
   assert value.warnings==2 and value.stderr==stderr and n.admit_policy(value)==RANGES
   no_secret(value)
   assert 'warnings' not in repr(value)
   # Exit 0 and every line an 'nginx: [warn] ' line: accepted whatever the text after the prefix.
   with host() as root:
    for stderr,count in ((b'nginx: [warn] [emerg] in a warning\\n',1),(b'nginx: [warn] a\\nnginx: [warn] [crit] b\\n',2),(b'',0)):
     value=collect(root,runner=runner(stderr=stderr))
     assert value.warnings==count and n.admit_policy(value)==RANGES,stderr
  ''')
 def test_other_stderr_is_observation_failed(self):
  self.check('''
   with host() as root:
    for stderr in (b'nginx: [notice] x\\n',b'nginx: [error] x\\n',b'Running as unit: x\\n',b'nginx: [warn] no newline',
                   b'\\n',b'nginx: [warn] a\\n\\n',b' nginx: [warn] indented\\n',b'nginx:  [warn] spacing\\n',(SECRET+'\\n').encode()):
     fails('nginx_observation_failed',collect,root,runner=runner(stderr=stderr))
  ''')
 def test_runner_failures_timeouts_and_output_budget(self):
  self.check('''
   with host() as root:
    for raised in (ob.ObservationError('command_timeout'),ob.ObservationError('command_output_budget'),
                   RuntimeError(SECRET),n.NginxObservationError('nginx_config_invalid'),n.NginxObservationError('nginx_sandbox_unavailable')):
     def hook(argv,raised=raised):
      if argv==n.SANDBOX_DUMP:raise raised
     fails('nginx_observation_failed',collect,root,runner=runner(hook=hook))
    for result in (b'',ob.CommandResult('text',b'',0),ob.CommandResult(b'',b'',True),ob.CommandResult(b'',bytearray(),0),types.SimpleNamespace(stdout=DUMP,stderr=b'',returncode=0)):
     fails('nginx_observation_failed',collect,root,runner=runner(hook=lambda argv,result=result:result if argv==n.SANDBOX_DUMP else None))
    # A result larger than the limit the runner was given.
    fails('nginx_observation_failed',collect,root,runner=runner(),max_output=len(DUMP)-1)
    fails('nginx_observation_failed',collect,root,runner=runner(stderr=b'nginx: [warn] '+b'x'*64+b'\\n'),max_output=len(DUMP)+10)
    assert collect(root,max_output=len(DUMP)).dump==DUMP
  ''')
 def test_whole_budget_and_clock(self):
  self.check('''
   with host() as root:
    c=collector(root);session=[0,math.inf,0]
    with linux_root(root):c._pass(session)
    one=session[0]
    # The charge itself refuses the byte past the whole budget.
    small=collector(root,max_total=100);session=[0,math.inf,0]
    small._charge(session,100)
    fails('nginx_observation_failed',small._charge,session,1)
    assert collect(root,max_total=2*one).dump==DUMP
    fails('nginx_observation_failed',collect,root,max_total=2*one-1)
    fails('nginx_observation_failed',collect,root,max_total=one+one//2)
    def clock(values):
     values=iter(values);last=[0]
     def now():
      last[0]=next(values,last[0]);return last[0]
     return now
    # Past the whole deadline during the second pass: the first pass completes
    # (its sandbox started with the whole command_timeout left), the clock then
    # passes the deadline while the second pass reads os-release, before its
    # systemctl show: the deadline refuses, no second command is started.
    now=[0.0];calls=[];reads=[]
    real_open=os.open
    def first_pass_done(argv):
     if argv==n.SANDBOX_DUMP:now[0]+=10
    def reading(path,*a,**k):
     if path=='os-release':
      reads.append(now[0])
      if len(reads)==2:now[0]=60
     return real_open(path,*a,**k)
    with patch.object(os,'open',side_effect=reading):
     fails('nginx_observation_failed',collect,root,runner=runner(calls=calls,hook=first_pass_done),clock=lambda:now[0],
           command_timeout=20,whole_timeout=60)
    assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP] and reads==[0.0,10.0],(calls,reads)
    # The same run with the deadline one second later is collected (the guard would
    # not have refused the second pass either: 49 seconds were left at its start).
    now=[0.0];calls=[];reads=[]
    def reading_in_time(path,*a,**k):
     if path=='os-release':
      reads.append(now[0])
      if len(reads)==2:now[0]=11
     return real_open(path,*a,**k)
    with patch.object(os,'open',side_effect=reading_in_time):
     assert collect(root,runner=runner(calls=calls,hook=first_pass_done),clock=lambda:now[0],command_timeout=20,whole_timeout=60).dump==DUMP
    assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP]*2
    # Past the whole deadline after the second sandbox run started in time (during the
    # managed reads): the deadline itself refuses, not the sandbox start guard.
    now=[0.0];dumps=[]
    def late(argv):
     if argv==n.SANDBOX_DUMP:
      dumps.append(now[0]);now[0]+=0 if len(dumps)==1 else 61
    fails('nginx_observation_failed',collect,root,runner=runner(hook=late),clock=lambda:now[0],command_timeout=20,whole_timeout=60)
    assert dumps==[0.0,0.0],dumps
    # A clock that runs backwards, and one that is not a finite number.
    backwards=[10.0]
    def reverse():
     backwards[0]-=1.0;return backwards[0]
    fails('nginx_observation_failed',collect,root,clock=reverse)
    for bad in (math.nan,math.inf,'1',None):
     fails('nginx_observation_failed',collect,root,clock=lambda bad=bad:bad)
    # The timeouts passed on: the sandbox always command_timeout, systemctl show
    # the smaller of DAEMON_STATE_TIMEOUT and the remaining time.
    calls=[];collect(root,runner=runner(calls=calls),command_timeout=25,whole_timeout=70)
    assert [(argv,timeout) for argv,timeout,_ in calls]==[(n.DAEMON_STATE,5),(n.SANDBOX_DUMP,25)]*2,calls
  ''')
 def test_sandbox_dump_not_started_with_less_than_command_timeout_left(self):
  # A shorter client timeout would kill only systemd-run and leave the unit
  # running until RuntimeMaxSec: the sandbox is started only with the whole
  # command_timeout left, and always given exactly that timeout.
  self.check('''
   with host() as root:
    for second,ok in ((10,True),(11,False),(10.5,False)):
     now=[0.0];steps=iter((30,second));calls=[]
     def hook(argv):
      if argv==n.DAEMON_STATE:now[0]+=next(steps)
     if ok:
      assert collect(root,runner=runner(calls=calls,hook=hook),clock=lambda:now[0],command_timeout=20,whole_timeout=60).dump==DUMP
      assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP]*2
     else:
      fails('nginx_observation_failed',collect,root,runner=runner(calls=calls,hook=hook),clock=lambda:now[0],command_timeout=20,whole_timeout=60)
      # The second pass stops before the sandbox: no systemd-run is started with less left.
      assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP,n.DAEMON_STATE],calls
     assert [timeout for argv,timeout,_ in calls if argv==n.SANDBOX_DUMP]==[20]*(2 if ok else 1)
    # systemctl show is not a transient unit: it still runs with whatever is left
    # when that is below DAEMON_STATE_TIMEOUT.
    now=[0.0];calls=[]
    def hook(argv):
     if argv==n.SANDBOX_DUMP:now[0]+=56
    fails('nginx_observation_failed',collect,root,runner=runner(calls=calls,hook=hook),clock=lambda:now[0],command_timeout=20,whole_timeout=60)
    assert [(argv,timeout) for argv,timeout,_ in calls]==[(n.DAEMON_STATE,5),(n.SANDBOX_DUMP,20),(n.DAEMON_STATE,4)],calls
  ''')
 def test_whole_timeout_holds_every_command_at_its_full_timeout(self):
  # Each pass runs two commands with a timeout: systemctl show and the sandbox.
  # At the smallest whole_timeout the domain admits for a command_timeout, a run
  # in which every command takes its whole timeout is still collected (the
  # second sandbox starts with its whole command_timeout left), and just below
  # the domain it would not be.
  self.check('''
   with host() as root:
    for command_timeout in (20,25,30.5,50):
     whole_timeout=2*(command_timeout+n.DAEMON_STATE_TIMEOUT)+n.WHOLE_TIMEOUT_MARGIN
     now=[0.0];calls=[]
     def slow(argv,now=now,calls=calls):
      now[0]+=calls[-1][1]
     assert collect(root,runner=runner(calls=calls,hook=slow),clock=lambda:now[0],
                    command_timeout=command_timeout,whole_timeout=whole_timeout).dump==DUMP
     assert [(argv,timeout) for argv,timeout,_ in calls]==[(n.DAEMON_STATE,5),(n.SANDBOX_DUMP,command_timeout)]*2,calls
     assert now[0]==whole_timeout-n.WHOLE_TIMEOUT_MARGIN,(now[0],whole_timeout)
  ''')
 def test_sandbox_not_started_unless_its_tmpfs_directories_exist(self):
  # systemd creates a missing TemporaryFileSystem= target on the host before
  # mounting over it (measured on 22.04/24.04/26.04): the sandbox is started
  # only when each target outside the private /dev is a directory itself (lstat:
  # a symbolic link, even to a directory, is refused; what systemd does with
  # one is not relied on). Checked with the sandbox precondition, before any
  # command or managed read (nginx_sandbox_unavailable), and again right before
  # every systemd-run (nginx_observation_failed when it no longer holds).
  self.check('''
   assert n.SANDBOX_TMPFS_DIRECTORIES==('/run','/var/log/nginx','/var/lib/nginx')
   def broken(root,directory,how):
    path=Path(root+directory)
    if how=='missing':path.rmdir()
    elif how=='file':path.rmdir();path.write_bytes(b'')
    elif how=='dangling':path.rmdir();path.symlink_to(root+'/nowhere')
    elif how=='symlink_to_directory':
     target=Path(root+directory+'-real');path.rename(target);path.symlink_to(target)
   real_open=os.open
   for directory in TMPFS_DIRECTORIES:
    for how in ('missing','file','dangling','symlink_to_directory'):
     with host() as root:
      broken(root,directory,how);calls=[];read=[]
      def spy(path,*a,**k):read.append(path);return real_open(path,*a,**k)
      with linux_root(root),patch.object(os,'open',side_effect=spy):
       fails('nginx_sandbox_unavailable',collector(root,runner=runner(calls=calls)).collect)
       fails('nginx_sandbox_unavailable',collector(root,runner=None).collect)
      # Neither systemctl show nor systemd-run ran, nothing managed was read.
      assert calls==[],(directory,how,calls)
      assert not set(read)&{'os-release','cloudfront-geo.conf','cloudfront-realip.conf','origin.conf','cloudfront-origin.conf'},(how,read)
      assert how=='symlink_to_directory' or not Path(root+directory).is_dir(),(directory,how)
    # Gone, or replaced by a symbolic link to a directory, before the second
    # pass: its systemd-run is not started (nginx_observation_failed).
    for how in ('missing','symlink_to_directory'):
     with host() as root:
      calls=[]
      def change(argv,directory=directory,how=how,calls=calls):
       if argv==n.SANDBOX_DUMP and len(calls)==2:broken(root,directory,how)
      fails('nginx_observation_failed',collect,root,runner=runner(calls=calls,hook=change))
      assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP,n.DAEMON_STATE],(directory,how,calls)
   # Any error while checking: nginx_sandbox_unavailable at the precondition,
   # nginx_observation_failed at the re-check before a start.
   with host() as root:
    paths=tuple(root+directory for directory in TMPFS_DIRECTORIES)
    real_lstat,real_stat=os.lstat,os.stat;calls=[];failing=[True]
    def flaky_lstat(path,*a,**k):
     if failing[0] and path in paths:raise PermissionError(13,'denied')
     return real_lstat(path,*a,**k)
    def flaky_stat(path,*a,**k):
     if failing[0] and path in paths:raise PermissionError(13,'denied')
     return real_stat(path,*a,**k)
    with patch.object(os,'lstat',side_effect=flaky_lstat),patch.object(os,'stat',side_effect=flaky_stat):
     with linux_root(root):fails('nginx_sandbox_unavailable',collector(root,runner=runner(calls=calls)).collect)
     assert calls==[],calls
     failing[0]=False
     def fail_later(argv):
      if argv==n.SANDBOX_DUMP and len(calls)==2:failing[0]=True
     fails('nginx_observation_failed',collect,root,runner=runner(calls=calls,hook=fail_later))
     assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP,n.DAEMON_STATE],calls
   with host() as root:assert collect(root).dump==DUMP
  ''')
 def test_passes_must_be_identical(self):
  self.check('''
   with host() as root:
    count=[0]
    def daemon_moves(argv):
     if argv==n.DAEMON_STATE:
      count[0]+=1
      return ob.CommandResult(DAEMON.replace(b'1234',str(1234+count[0]).encode()),b'',0)
    fails('nginx_observation_failed',collect,root,runner=runner(hook=daemon_moves))
    seen=[0]
    def warning_appears(argv):
     if argv==n.SANDBOX_DUMP:
      seen[0]+=1
      return ob.CommandResult(DUMP,b'nginx: [warn] x\\n' if seen[0]==2 else b'',0)
    fails('nginx_observation_failed',collect,root,runner=runner(hook=warning_appears))
    # A managed file rewritten between the passes, with a dump that matches the new bytes.
    changed=dict(FILE_BYTES);changed[GEO_PATH]=GEO.replace(SECRET.encode(),b'other-value');dumps=[0]
    def rewrite(argv):
     if argv==n.SANDBOX_DUMP:
      dumps[0]+=1
      if dumps[0]==2:
       write(root,GEO_PATH,changed[GEO_PATH]);return ob.CommandResult(dump_of(changed),b'',0)
    fails('nginx_observation_failed',collect,root,runner=runner(hook=rewrite))
  ''')
 def test_dump_not_bound_to_managed_bytes(self):
  self.check('''
   with host() as root:
    missing=DUMP[:DUMP.index(b'# configuration file '+REAL_INCLUDE.encode())]
    other=dict(FILE_BYTES);other[REALIP_PATH]=REALIP+b'# loaded text differs\\n'
    for dump in (b'',missing,dump_of(other),DUMP+b'# configuration file '+GEO_PATH.encode()+b':\\n'+GEO+b'\\n',b'not a dump\\n'):
     fails('nginx_observation_failed',collect,root,runner=runner(dump=dump))
  ''')
 def test_unsafe_or_unreadable_managed_files(self):
  self.check('''
   def big(root):write(root,GEO_PATH,b'#'*(2*1024*1024+1))
   def hardlink(root):os.link(root+REALIP_PATH,root+'/etc/nginx/origin-copy.conf')
   def symlink_leaf(root):
    target=write(root,'/etc/nginx/real-origin.conf',REALIP);Path(root+REALIP_PATH).unlink();Path(root+REALIP_PATH).symlink_to(target)
   def symlink_ancestor(root):
    Path(root+'/etc/nginx/sites-enabled').rename(root+'/etc/nginx/sites-available');Path(root+'/etc/nginx/sites-enabled').symlink_to(root+'/etc/nginx/sites-available')
   def writable_file(root):Path(root+GEO_INCLUDE).chmod(0o664)
   def world_file(root):Path(root+GEO_INCLUDE).chmod(0o646)
   def writable_ancestor(root):Path(root+'/etc/nginx').chmod(0o775)
   def missing(root):Path(root+REAL_INCLUDE).unlink()
   def directory(root):Path(root+REAL_INCLUDE).unlink();Path(root+REAL_INCLUDE).mkdir()
   def fifo(root):Path(root+REAL_INCLUDE).unlink();os.mkfifo(root+REAL_INCLUDE)
   def os_release_symlink(root):
    Path(root+'/usr/lib/os-release').unlink();Path(root+'/usr/lib/os-release').symlink_to(root+GEO_PATH)
   for change in (big,hardlink,symlink_leaf,symlink_ancestor,writable_file,world_file,writable_ancestor,missing,directory,fifo,os_release_symlink):
    with host() as root:
     change(root)
     fails('nginx_observation_failed',collect,root)
   # Each refusal below holds even when the dump matches what was read, so
   # only the file check itself stands between the collector and acceptance.
   big_geo=GEO+b'#'*(2*1024*1024+1-len(GEO))
   bound=dict(FILE_BYTES);bound[GEO_PATH]=big_geo
   with host(bound) as root:
    fails('nginx_observation_failed',collect,root,runner=runner(dump=dump_of(bound)),max_total=16*1024*1024)
   empty=dict(FILE_BYTES);empty[GEO_PATH]=b''
   with host(empty) as root:
    Path(root+GEO_PATH).unlink();os.mkfifo(root+GEO_PATH,0o644)
    fails('nginx_observation_failed',collect,root,runner=runner(dump=dump_of(empty)))
   with host() as root:
    target=write(root,'/etc/nginx/real-origin.conf',REALIP);Path(root+REALIP_PATH).unlink();Path(root+REALIP_PATH).symlink_to(target)
    fails('nginx_observation_failed',collect,root)
   with host() as root:
    # A file of another owner, seen consistently by stat and fstat.
    real_stat,real_fstat,real_open,real_close=os.stat,os.fstat,os.open,os.close;fds=set()
    def fake_close(fd):
     fds.discard(fd);return real_close(fd)
    def other(info):
     values=list(info);values[stat.ST_UID]=UID+1;return os.stat_result(values)
    def fake_stat(path,*a,**k):
     info=real_stat(path,*a,**k);return other(info) if path=='cloudfront-geo.conf' else info
    def fake_open(path,*a,**k):
     fd=real_open(path,*a,**k)
     if path=='cloudfront-geo.conf':fds.add(fd)
     return fd
    def fake_fstat(fd):
     info=real_fstat(fd);return other(info) if fd in fds else info
    with patch.object(os,'stat',side_effect=fake_stat),patch.object(os,'open',side_effect=fake_open),patch.object(os,'fstat',side_effect=fake_fstat),patch.object(os,'close',side_effect=fake_close):
     fails('nginx_observation_failed',collect,root)
    # Without the patches the same tree is accepted: only the owner differed.
    assert collect(root).dump==DUMP
    # Files of another owner (the owner the collector requires differs): a
    # failed observation, not an unavailable sandbox (the executables are
    # checked against EXECUTABLE_UID, never against the collector's owner).
    with linux_root(root):fails('nginx_observation_failed',n.Collector(shared_dir=SHARED,bundles=BUNDLES,root=root,owner=UID+1,runner=runner()).collect)
    # A file replaced while it is read (identity before and after differs).
    real_read=os.read;done=[False]
    def swap(fd,size):
     data=real_read(fd,size)
     if data and not done[0] and data.startswith(b'geo '):
      done[0]=True;path=Path(root+GEO_PATH);path.unlink();write(root,GEO_PATH,GEO)
     return data
    with patch.object(os,'read',side_effect=swap):fails('nginx_observation_failed',collect,root)
    assert done[0]
  ''')
 def test_daemon_and_os_release_shapes(self):
  self.check('''
   with host() as root:
    for daemon in (b'',DAEMON[:-1],DAEMON+b'Id=nginx.service\\n',DAEMON.replace(b'Id=nginx.service',b'Id=other.service'),
                   DAEMON.replace(b'MainPID=1234',b'MainPID=x'),DAEMON.replace(b'LoadState=loaded\\n',b''),DAEMON+b'Extra=1\\n',
                   DAEMON.replace(b'SubState=running',b'SubState=RUNNING'),DAEMON.replace(b'\\n',b'\\r\\n'),
                   DAEMON[:DAEMON.index(b'ExecStart=')],DAEMON+DAEMON[DAEMON.index(b'ExecStart='):]):
     fails('nginx_observation_failed',collect,root,runner=runner(daemon=daemon))
    for result in (ob.CommandResult(DAEMON,b'x\\n',0),ob.CommandResult(DAEMON,b'',1)):
     fails('nginx_observation_failed',collect,root,runner=runner(hook=lambda argv,result=result:result if argv==n.DAEMON_STATE else None))
   for os_release in (b'ID=ubuntu\\n',b'VERSION_ID="24.04"\\n',OS_RELEASE+b'ID=ubuntu\\n',b'ID=ubuntu\\nVERSION_ID="24.04\\n',
                      b'ID=ubuntu\\nVERSION_ID=24 04\\n',b'ID=ubuntu\\nVERSION_ID\\n','ID=ubuntu\\nVERSION_ID="24.04"\\nNAME=\\u00fc\\n'.encode()):
    with host(os_release=os_release) as root:
     fails('nginx_observation_failed',collect,root)
  ''')
 def test_admit_policy_os_daemon_and_policy(self):
  self.check('''
   with host() as root:
    good=collect(root)
    assert n.admit_policy(good)==RANGES
    for daemon in (DAEMON.replace(b'LoadState=loaded',b'LoadState=not-found'),DAEMON.replace(b'ActiveState=active',b'ActiveState=inactive'),
                   DAEMON.replace(b'SubState=running',b'SubState=dead'),DAEMON.replace(b'SubState=running',b'SubState=exited'),
                   DAEMON.replace(b'MainPID=1234',b'MainPID=0'),DAEMON.replace(b'ActiveState=active',b'ActiveState=reloading')):
     value=collect(root,runner=runner(daemon=daemon))
     fails('nginx_policy_unsupported',n.admit_policy,value)
   for os_release in (b'ID=ubuntu\\nVERSION_ID="20.04"\\n',b'ID=debian\\nVERSION_ID="24.04"\\n',b'ID=ubuntu\\nVERSION_ID="25.10"\\n'):
    with host(os_release=os_release) as root:
     fails('nginx_policy_unsupported',n.admit_policy,collect(root))
   for os_id in ('22.04','26.04'):
    with host(os_release=('ID=ubuntu\\nVERSION_ID="'+os_id+'"\\n').encode()) as root:
     assert n.admit_policy(collect(root))==RANGES
   # The dump-wide policy: a bundle without real_ip_recursive off.
   weak=dict(FILE_BYTES);weak[REALIP_PATH]=REALIP.replace(b'    real_ip_recursive off;\\n',b'')
   with host(weak) as root:
    fails('nginx_policy_unsupported',n.admit_policy,collect(root,runner=runner(dump=dump_of(weak))))
   # A shared include that differs between the two files.
   uneven=dict(FILE_BYTES);uneven[GEO_INCLUDE]=b'13.32.0.0/15 1;\\n52.46.0.0/18 1;\\n2600:9000::/28 1;\\n'
   with host(uneven) as root:
    fails('nginx_policy_unsupported',n.admit_policy,collect(root,runner=runner(dump=dump_of(uneven))))
   # Not an observation, or one whose bytes were changed: the dump is parsed again.
   duck=types.SimpleNamespace(**{f.name:getattr(good,f.name) for f in dataclasses.fields(good)})
   for value in (None,object(),duck,dataclasses.asdict(good),dataclasses.replace(good,dump=good.dump.replace(b'default 0;',b'default 1;')),
                 dataclasses.replace(good,managed=good.managed+(good.managed[0],)),dataclasses.replace(good,managed=good.managed[1:]),
                 dataclasses.replace(good,daemon=good.daemon[:-1]),dataclasses.replace(good,daemon=(('Id',),)),
                 dataclasses.replace(good,shared_dir='/etc/nginx/other'),dataclasses.replace(good,bundles=()),
                 dataclasses.replace(good,os_name=b'ubuntu'),dataclasses.replace(good,os_id=24.04)):
    fails('nginx_policy_unsupported',n.admit_policy,value)
  ''')
 def test_exec_start_as_printed_on_the_supported_hosts_is_admitted(self):
  self.check(r"""
   # Verbatim systemctl show output (property order as printed) of the 22.04
   # (systemd 249), 24.04 (255) and 26.04 (259) VMs' packaged nginx.service.
   outputs=(b'MainPID=26494\nExecStart={ path=/usr/sbin/nginx ; argv[]=/usr/sbin/nginx -g daemon on; master_process on; ; ignore_errors=no ; start_time=[Mon 2026-11-23 11:07:59 JST] ; stop_time=[Mon 2026-11-23 11:07:59 JST] ; pid=26493 ; code=exited ; status=0 }\nId=nginx.service\nLoadState=loaded\nActiveState=active\nSubState=running\n',
            b'MainPID=24824\nExecStart={ path=/usr/sbin/nginx ; argv[]=/usr/sbin/nginx -g daemon on; master_process on; ; ignore_errors=no ; start_time=[Mon 2026-11-23 11:06:23 JST] ; stop_time=[Mon 2026-11-23 11:06:23 JST] ; pid=24822 ; code=exited ; status=0 }\nId=nginx.service\nLoadState=loaded\nActiveState=active\nSubState=running\n',
            b'Id=nginx.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=233342\nExecStart={ path=/usr/sbin/nginx ; argv[]=/usr/sbin/nginx -g daemon on; master_process on; ; ignore_errors=no ; start_time=[Mon 2026-11-23 11:08:00 JST] ; stop_time=[Mon 2026-11-23 11:08:00 JST] ; pid=233340 ; code=exited ; status=0 }\n')
   with host() as root:
    for output in outputs:
     value=collect(root,runner=runner(daemon=output))
     assert n.admit_policy(value)==RANGES
     assert dict(value.daemon)['ExecStart']==output.decode().split('ExecStart=',1)[1].split('\n',1)[0]
    # nginx without options, and ignore_errors=yes ('-' prefix), name no other configuration either.
    for line in (exec_start('/usr/sbin/nginx'),exec_start(errors='yes'),
                 exec_start().replace('start_time=[Mon 2026-11-23 11:08:00 JST] ; stop_time=[Mon 2026-11-23 11:08:00 JST] ; pid=233340 ; code=exited ; status=0',
                                      'start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0')):
     daemon=DAEMON.replace(exec_start().encode(),line.encode())
     assert daemon!=DAEMON or line==exec_start()
     assert n.admit_policy(collect(root,runner=runner(daemon=daemon)))==RANGES,line
  """)
 def test_admit_policy_requires_the_packaged_nginx_command_line(self):
  self.check(r"""
   # verified covers the configuration nginx -T reads (/etc/nginx/nginx.conf):
   # a daemon started with -c, -p or -g (other than the package's own
   # 'daemon on; master_process on;') runs another configuration.
   other=('/usr/sbin/nginx -c /etc/nginx/other.conf -g daemon on; master_process on;',
          '/usr/sbin/nginx -c/etc/nginx/other.conf',
          '/usr/sbin/nginx -c /etc/nginx/nginx.conf',
          '/usr/sbin/nginx -p /srv/nginx/ -g daemon on; master_process on;',
          '/usr/sbin/nginx -p/srv/nginx/',
          '/usr/sbin/nginx -g daemon on; master_process on; include /etc/nginx/extra.conf;',
          '/usr/sbin/nginx -g daemon off;',
          '/usr/sbin/nginx -gdaemon on; master_process on;',
          '/usr/sbin/nginx -g daemon on; master_process on; -c /etc/nginx/other.conf',
          '/usr/sbin/nginx -e stderr -g daemon on; master_process on;',
          'nginx -g daemon on; master_process on;',
          '/usr/local/sbin/nginx -g daemon on; master_process on;')
   lines=[exec_start(argv) for argv in other]
   lines+=[exec_start(path='/usr/local/sbin/nginx'),exec_start(path='/usr/sbin/nginx-debug')]
   # Not parsable: fail-closed, never read as the packaged command line.
   lines+=['','garbage',exec_start()[:-2],exec_start()[2:],exec_start()+' '+exec_start(),
           exec_start(errors='maybe'),exec_start().replace(' ; argv[]=',' ; argv=',1),
           exec_start().replace('{ path=','{path=',1),
           '{ path=/usr/sbin/nginx ; argv[]=/usr/sbin/nginx ; ignore_errors=no ; }',
           exec_start(PACKAGED_ARGV+' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 } { path=/usr/sbin/nginx ; argv[]=/usr/sbin/nginx -c /tmp/x.conf'),
           exec_start('/usr/sbin/nginx -c /tmp/x.conf ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 } { path=/usr/sbin/nginx ; argv[]='+PACKAGED_ARGV)]
   with host() as root:
    for line in lines:
     daemon=DAEMON.replace(exec_start().encode(),line.encode())
     assert daemon!=DAEMON,line
     value=collect(root,runner=runner(daemon=daemon))
     assert type(value) is n.NginxObservation
     fails('nginx_policy_unsupported',n.admit_policy,value)
    good=collect(root)
    assert n.admit_policy(good)==RANGES
    # The daemon tuple carries the ExecStart value; replacing it is refused like any other field.
    for daemon in (tuple((k,v) for k,v in good.daemon if k!='ExecStart'),
                   tuple((k,exec_start(other[0]) if k=='ExecStart' else v) for k,v in good.daemon)):
     fails('nginx_policy_unsupported',n.admit_policy,dataclasses.replace(good,daemon=daemon))
  """)
 def test_raw_passes_are_compared_before_the_dump_is_parsed_once(self):
  self.check(r"""
   real=n.parse_dump
   def counting(record):
    def parse(dump,managed):
     record.append((dump,dict(managed)))
     return real(dump,managed)
    return parse
   with host() as root:
    # Two identical passes: the dump is parsed exactly once, bound to the managed bytes.
    parsed=[];calls=[]
    with patch.object(n,'parse_dump',counting(parsed)):value=collect(root,runner=runner(calls=calls))
    assert parsed==[(DUMP,FILE_BYTES)],len(parsed)
    assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP]*2
    assert n.admit_policy(value)==RANGES
    # Passes that differ (daemon, dump, stderr or a managed file): nginx_observation_failed, never parsed.
    count=[0]
    def daemon_moves(argv):
     if argv==n.DAEMON_STATE:
      count[0]+=1
      return ob.CommandResult(DAEMON.replace(b'MainPID=1234',('MainPID='+str(1234+count[0])).encode()),b'',0)
    dumps=[0]
    def dump_changes(argv):
     if argv==n.SANDBOX_DUMP:
      dumps[0]+=1
      return ob.CommandResult(DUMP if dumps[0]==1 else b'not a dump\n',b'',0)
    warned=[0]
    def warning_appears(argv):
     if argv==n.SANDBOX_DUMP:
      warned[0]+=1
      return ob.CommandResult(DUMP,b'nginx: [warn] x\n' if warned[0]==2 else b'',0)
    for hook in (daemon_moves,dump_changes,warning_appears):
     parsed=[];calls=[]
     with patch.object(n,'parse_dump',counting(parsed)):
      fails('nginx_observation_failed',collect,root,runner=runner(calls=calls,hook=hook))
     assert parsed==[],hook
     assert [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP]*2,hook
    # Identical passes whose dump is not bound to the managed bytes: parsed once, refused.
    other=dict(FILE_BYTES);other[REALIP_PATH]=REALIP+b'# loaded text differs\n'
    parsed=[];calls=[]
    with patch.object(n,'parse_dump',counting(parsed)):
     fails('nginx_observation_failed',collect,root,runner=runner(dump=dump_of(other),calls=calls))
    assert len(parsed)==1 and [argv for argv,_,_ in calls]==[n.DAEMON_STATE,n.SANDBOX_DUMP]*2
  """)
 def test_snapshotter_maps_collection_to_components(self):
  self.check('''
   class Fixed:
    def __init__(self,outcome):self.outcome=outcome
    def collect(self):
     if isinstance(self.outcome,BaseException):raise self.outcome
     return self.outcome
   def component(outcome,backend='none'):
    return m.Snapshotter(backend=backend,nginx_enabled=True,nginx_shared_dir=SHARED,nginx_bundles=CONFIG_BUNDLES,nginx_collector=Fixed(outcome)).collect().nginx
   with host() as root:good=collect(root)
   assert component(good)==m.ComponentResult('observed','nginx_observed',good) and component(good).evidence is good
   for code in ('nginx_sandbox_unavailable','nginx_observation_failed'):
    assert component(n.NginxObservationError(code))==m.ComponentResult('failure',code)
   class Sub(n.NginxObservationError):pass
   for outcome in (n.NginxObservationError('nginx_dump_mismatch'),n.NginxObservationError('nginx_policy_unsupported'),
                   n.NginxObservationError('nginx_config_invalid'),n.NginxObservationError('nginx_observation_failed','x'),
                   Sub('nginx_sandbox_unavailable'),RuntimeError(SECRET),
                   None,object(),types.SimpleNamespace(**{f.name:getattr(good,f.name) for f in dataclasses.fields(good)}),
                   dataclasses.replace(good,shared_dir='/etc/nginx/other'),dataclasses.replace(good,bundles=((GEO_PATH,'/etc/nginx/x.conf'),))):
    value=component(outcome)
    assert value==m.ComponentResult('failure','nginx_observation_failed') and value.evidence is None
    no_secret(value)
   # The firewall failing does not stop the nginx branch.
   class Broken:
    def collect(self):raise RuntimeError(SECRET)
   snapshot=m.Snapshotter(backend='ufw',nginx_enabled=True,collector=Broken(),nginx_shared_dir=SHARED,nginx_bundles=CONFIG_BUNDLES,nginx_collector=Fixed(good)).collect()
   assert snapshot.firewall.code=='firewall_observation_failed' and snapshot.nginx.code=='nginx_observed'
   no_secret(snapshot,snapshot.nginx)
  ''')
 def test_every_admission_branch_carries_the_decided_nginx(self):
  self.check('''
   import base64
   class Fixed:
    def __init__(self,outcome):self.outcome=outcome
    def collect(self):return self.outcome
   with host() as root:good=collect(root)
   weak=dict(FILE_BYTES);weak[REALIP_PATH]=REALIP.replace(b'    real_ip_recursive off;\\n',b'')
   with host(weak) as root:bad=collect(root,runner=runner(dump=dump_of(weak)))
   def p(backend='none'):
    return m.parse_p(json.dumps({'integrity_format':'pt-kernel-v1','backend':backend,'config_hash':'a'*64,'enrollment_id':'b'*32,
                                 'profile_id':'none','inventory':None,'owned_rules':[]},sort_keys=True,separators=(',',':')).encode())
   class Broken:
    def collect(self):raise RuntimeError('firewall')
   for evidence,expected in ((good,('admitted','nginx_policy_verified')),(bad,('failure','nginx_policy_unsupported'))):
    def snap(backend):
     return m.Snapshotter(backend=backend,nginx_enabled=True,collector=Broken(),nginx_shared_dir=SHARED,
                          nginx_bundles=CONFIG_BUNDLES,nginx_collector=Fixed(evidence)).collect()
    results=[m.admit_snapshot(snap('none')),                                                      # baseline_required
             m.admit_snapshot(snap('none'),p(),config_hash='a'*64,enrollment_id='b'*32),          # none admitted
             m.admit_snapshot(snap('none'),p(),config_hash='c'*64,enrollment_id='b'*32),          # baseline_context_mismatch
             m.admit_snapshot(snap('ufw'))]                                                       # firewall_observation_failed
    assert [r.firewall.code if type(r.firewall) is m.ComponentResult else 'not_applicable' for r in results]==[
     'baseline_required','not_applicable','baseline_context_mismatch','firewall_observation_failed']
    for result in results:
     assert type(result.nginx) is m.ComponentResult and (result.nginx.status,result.nginx.code)==expected
     assert result.nginx.evidence is evidence
     no_secret(result,result.nginx)
   # A failed observation passes through unchanged.
   failed=m.ComponentResult('failure','nginx_sandbox_unavailable')
   snapshot=m.ObservationSnapshot('none',True,m.NotApplicable('firewall'),failed)
   assert m.admit_snapshot(snapshot).nginx is failed
  ''')
 def test_forged_or_retired_components_are_refused(self):
  self.check('''
   with host() as root:good=collect(root)
   for code in ('nginx_readonly_not_connected','nginx_fixture_observed'):
    assert code not in m.CODES
    try:m.ComponentResult('failure',code)
    except m.SnapshotError as error:assert str(error)=='invalid_component_result'
    else:raise AssertionError('retired code constructed')
   forged=(m.ComponentResult('admitted','nginx_policy_verified',good),m.ComponentResult('failure','nginx_policy_unsupported',good),
           m.ComponentResult('failure','nginx_sandbox_unavailable',good),m.ComponentResult('observed','nginx_observed'),
           m.ComponentResult('observed','nginx_observed',object()),m.ComponentResult('observed','nginx_sandbox_unavailable',good),
           m.ComponentResult('failure','firewall_observation_failed'),m.NotApplicable('nginx'),m.NotApplicable('context'),None)
   for nginx in forged:
    try:m.admit_snapshot(m.ObservationSnapshot('none',True,m.NotApplicable('firewall'),nginx))
    except m.SnapshotError as error:assert str(error)=='invalid_nginx_component'
    else:raise AssertionError('forged enabled component accepted')
   for nginx in (m.ComponentResult('failure','nginx_sandbox_unavailable'),m.ComponentResult('observed','nginx_observed',good),m.NotApplicable('firewall')):
    try:m.admit_snapshot(m.ObservationSnapshot('none',False,m.NotApplicable('firewall'),nginx))
    except m.SnapshotError as error:assert str(error)=='invalid_nginx_component'
    else:raise AssertionError('component accepted for a disabled nginx')
  ''')
 def test_ledger_input_only_from_an_admitted_component(self):
  self.check('''
   with host() as root:good=collect(root)
   weak=dict(FILE_BYTES);weak[REALIP_PATH]=REALIP.replace(b'    real_ip_recursive off;\\n',b'')
   with host(weak) as root:bad=collect(root,runner=runner(dump=dump_of(weak)))
   admitted=m.ComponentResult('admitted','nginx_policy_verified',good)
   data=m.nginx_ledger_input(admitted)
   assert data=={'observation_code':'nginx_observed','before_shared':{'cloudfront-geo.conf':GEO_SHARED,'cloudfront-realip.conf':REAL_SHARED},
                 'before_bundles':{GEO_PATH:GEO,REALIP_PATH:REALIP}}
   assert m.nginx_ledger_input(m.NotApplicable('nginx'))=={'observation_code':'not_applicable','before_shared':{},'before_bundles':{}}
   for component in (m.ComponentResult('observed','nginx_observed',good),m.ComponentResult('failure','nginx_policy_unsupported',bad),
                     m.ComponentResult('admitted','nginx_policy_verified',bad),m.ComponentResult('admitted','stock_evidence_verified',good),
                     m.ComponentResult('failure','nginx_sandbox_unavailable'),m.NotApplicable('firewall'),{'observation_code':'nginx_observed'},None):
    try:m.nginx_ledger_input(component)
    except m.SnapshotError as error:assert str(error)=='ledger_nginx_not_admitted';no_secret(error,error.args)
    else:raise AssertionError('non-admitted nginx became ledger input')
   # The input compiles into a ledger for the matching config; the wire carries no secret in its repr.
   cfg={'host_address':'192.0.2.10','firewall':{'backend':'none','ports':[443]},'nginx':{'enabled':True,'shared_dir':SHARED,'bundles':CONFIG_BUNDLES},
        'limits':{'max_changes':10,'min_ratio':.8},'notify_unit':''}
   def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
   p={'integrity_format':'pt-kernel-v1','backend':'none','config_hash':hashlib.sha256(enc(cfg)).hexdigest(),'enrollment_id':'b'*32,
      'profile_id':'none','inventory':None,'owned_rules':[],'protected_context':None}
   args={'config_bytes':enc(cfg),'before_state_bytes':None,'baseline_bytes':enc(p),'before':None,'protected_context':None,
         'target':{'ranges':list(RANGES),'aws_sync_token':'11'},'nginx':data,'code_generation':'c'*64,'created_at':10,'companions':{}}
   result=m.compile_ledger(**args)
   assert result.disposition=='validated_data_only' and result==m.validate_ledger(result.wire,code_generation='c'*64,companions={})
   no_secret(result)
   # Ledger refusals carry fixed codes only, never the secret bytes they were given.
   other=dict(cfg);other['nginx']=dict(cfg['nginx'],bundles=[{'geo_file':GEO_PATH,'realip_file':'/etc/nginx/x.conf'}])
   for changed in (dict(args,config_bytes=enc(other)),dict(args,nginx=dict(data,observation_code='nginx_readonly_not_connected')),
                   dict(args,nginx=dict(data,before_shared={'cloudfront-geo.conf':GEO}))):
    try:m.compile_ledger(**changed)
    except m.SnapshotError as error:
     no_secret(error,error.args);assert error.__cause__ is None and error.__context__ is None or SECRET not in repr(error.__context__)
    else:raise AssertionError('mismatched ledger input accepted')
  ''')
 def test_snapshotter_nginx_options_refused_by_the_collector_fail_only_nginx(self):
  self.check('''
   # Options that the nginx Collector refuses at construction fail the nginx
   # component only (nginx_observation_failed, nothing read or run); the
   # firewall component is still observed.
   class Counting:
    calls=0
    def collect(self):
     Counting.calls+=1;raise RuntimeError('firewall')
   bundle={'geo_file':GEO_PATH,'realip_file':REALIP_PATH}
   for shared,bundles in ((SHARED+'/',[bundle]),(SHARED+'/.',[bundle]),('/etc/nginx/./cloudfront',[bundle]),('relative',[bundle]),('/',[bundle]),
                          (SHARED,[bundle,bundle]),(SHARED,[{'geo_file':GEO_INCLUDE,'realip_file':REALIP_PATH}]),
                          (SHARED,[{'geo_file':GEO_PATH,'realip_file':REAL_INCLUDE}]),
                          (SHARED,[{'geo_file':'/etc/nginx/a/../geo.conf','realip_file':REALIP_PATH}])):
    Counting.calls=0
    with (patch.object(os,'open',side_effect=AssertionError('open')),patch.object(ob,'_stream',side_effect=AssertionError('command'))):
     snapshotter=m.Snapshotter(backend='ufw',nginx_enabled=True,collector=Counting(),nginx_shared_dir=shared,nginx_bundles=bundles)
     snapshot=snapshotter.collect()
    assert Counting.calls==1,(shared,bundles)
    assert snapshot.firewall==m.ComponentResult('failure','firewall_observation_failed')
    assert snapshot.nginx==m.ComponentResult('failure','nginx_observation_failed') and snapshot.nginx.evidence is None,(shared,bundles)
    admission=m.admit_snapshot(snapshot)
    assert admission.nginx==m.ComponentResult('failure','nginx_observation_failed')
   # The option shapes the Snapshotter itself checks still refuse construction.
   for shared,bundles in ((None,[bundle]),(b'/etc/nginx/cloudfront',[bundle]),(SHARED,[]),(SHARED,[{'geo_file':GEO_PATH}]),(SHARED,bundle)):
    try:m.Snapshotter(backend='none',nginx_enabled=True,nginx_shared_dir=shared,nginx_bundles=bundles)
    except m.SnapshotError as error:assert str(error)=='invalid_snapshot_options'
    else:raise AssertionError('bad option shape accepted')
  ''')
 def test_only_observations_collect_returned_are_admitted(self):
  self.check('''
   import pickle
   with host() as root:
    good=collect(root)
    c=collector(root);session=[0,math.inf,0]
    # One pass's raw evidence made into an observation that collect() did not return.
    with linux_root(root):os_name,os_id,daemon,dump,stderr,warnings,managed=c._pass(session)
    unissued=n.NginxObservation(os_id,c.shared_dir,c.bundles,os_name,daemon,dump,stderr,warnings,managed)
   assert n.admit_policy(good)==RANGES
   fields={f.name:getattr(good,f.name) for f in dataclasses.fields(good)}
   handmade=n.NginxObservation(**fields)
   clones=[handmade,unissued,dataclasses.replace(good),copy.copy(good),copy.deepcopy(good),pickle.loads(pickle.dumps(good))]
   for value in clones:
    fails('nginx_policy_unsupported',n.admit_policy,value)
   def snapshot_of(value,expected=(SHARED,BUNDLES)):
    return m.ObservationSnapshot('none',True,m.NotApplicable('firewall'),m.ComponentResult('observed','nginx_observed',value),expected)
   for value in clones:
    assert m.admit_snapshot(snapshot_of(value)).nginx==m.ComponentResult('failure','nginx_policy_unsupported',value)
    try:m.nginx_ledger_input(m.ComponentResult('admitted','nginx_policy_verified',value))
    except m.SnapshotError as error:assert str(error)=='ledger_nginx_not_admitted'
    else:raise AssertionError('unissued observation became ledger input')
   # The Snapshotter refuses an unissued observation its collector returns.
   class Fixed:
    def __init__(self,value):self.value=value
    def collect(self):return self.value
   for value in clones:
    snap=m.Snapshotter(backend='none',nginx_enabled=True,nginx_shared_dir=SHARED,nginx_bundles=CONFIG_BUNDLES,nginx_collector=Fixed(value)).collect()
    assert snap.nginx==m.ComponentResult('failure','nginx_observation_failed')
   # A collected observation of another shared_dir is not this Snapshotter's observation.
   elsewhere=collect_elsewhere()
   assert n.admit_policy(elsewhere)==RANGES
   snap=m.Snapshotter(backend='none',nginx_enabled=True,nginx_shared_dir=SHARED,nginx_bundles=CONFIG_BUNDLES,nginx_collector=Fixed(elsewhere)).collect()
   assert snap.nginx==m.ComponentResult('failure','nginx_observation_failed')
   assert m.admit_snapshot(snapshot_of(elsewhere)).nginx==m.ComponentResult('failure','nginx_policy_unsupported',elsewhere)
   # Admission compares the observation with the Snapshotter's configured shared_dir and bundles.
   snap=m.Snapshotter(backend='none',nginx_enabled=True,nginx_shared_dir=SHARED,nginx_bundles=CONFIG_BUNDLES,nginx_collector=Fixed(good)).collect()
   assert m.admit_snapshot(snap).nginx==m.ComponentResult('admitted','nginx_policy_verified',good)
   for expected in (None,(SHARED+'/x',BUNDLES),(SHARED,((REALIP_PATH,GEO_PATH),)),(SHARED,BUNDLES+((GEO_PATH+'.2',REALIP_PATH+'.2'),)),(SHARED,),'x'):
    assert m.admit_snapshot(snapshot_of(good,expected)).nginx==m.ComponentResult('failure','nginx_policy_unsupported',good),expected
   assert m.admit_snapshot(snapshot_of(good)).nginx==m.ComponentResult('admitted','nginx_policy_verified',good)
   # A field changed in place on the issued instance is refused as well, even
   # to an equal value held by another object.
   for name,value in (('warnings',1),('os_id','22.04'),('shared_dir',(SHARED+'x')[:-1]),('bundles',tuple(list(BUNDLES))),
                      ('dump',bytes(bytearray(DUMP))),('managed',tuple(list(good.managed))),('daemon',tuple(list(good.daemon)))):
    with host() as root:changed=collect(root)
    # Admitted before the change, for every field (warnings and os_id included).
    assert n.admit_policy(changed)==RANGES,name
    assert getattr(changed,name)==value or name in ('warnings','os_id'),name
    object.__setattr__(changed,name,value)
    fails('nginx_policy_unsupported',n.admit_policy,changed)
   no_secret(*clones)
  ''')
 def test_ledger_accepts_only_issued_nginx_inputs(self):
  self.check('''
   def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
   def ledger_args(data,shared=SHARED,bundles=CONFIG_BUNDLES,enabled=True):
    cfg={'host_address':'192.0.2.10','firewall':{'backend':'none','ports':[443]},'nginx':{'enabled':enabled,'shared_dir':shared,'bundles':bundles if enabled else []},
         'limits':{'max_changes':10,'min_ratio':.8},'notify_unit':''}
    p={'integrity_format':'pt-kernel-v1','backend':'none','config_hash':hashlib.sha256(enc(cfg)).hexdigest(),'enrollment_id':'b'*32,
       'profile_id':'none','inventory':None,'owned_rules':[],'protected_context':None}
    return {'config_bytes':enc(cfg),'before_state_bytes':None,'baseline_bytes':enc(p),'before':None,'protected_context':None,
            'target':{'ranges':list(RANGES),'aws_sync_token':'11'},'nginx':data,'code_generation':'c'*64,'created_at':10,'companions':{}}
   def refused(code,args):
    try:m.compile_ledger(**args)
    except m.SnapshotError as error:assert str(error)==code,str(error);no_secret(error,error.args)
    else:raise AssertionError('ledger accepted, expected '+code)
   with host() as root:good=collect(root)
   data=m.nginx_ledger_input(m.ComponentResult('admitted','nginx_policy_verified',good))
   assert m.compile_ledger(**ledger_args(data)).disposition=='validated_data_only'
   none=m.nginx_ledger_input(m.NotApplicable('nginx'))
   assert m.compile_ledger(**ledger_args(none,enabled=False)).disposition=='validated_data_only'
   # Hand-made, copied or changed inputs are refused, the not_applicable one included.
   import pickle
   for value,enabled in ((dict(data),True),(copy.deepcopy(data),True),(pickle.loads(pickle.dumps(data)),True),
                         ({'observation_code':'nginx_observed','before_shared':dict(data['before_shared']),'before_bundles':dict(data['before_bundles'])},True),
                         ({'observation_code':'not_applicable','before_shared':{},'before_bundles':{}},False),(dict(none),False),(copy.copy(none),False)):
    refused('ledger_nginx_not_issued',ledger_args(value,enabled=enabled))
   changed=m.nginx_ledger_input(m.ComponentResult('admitted','nginx_policy_verified',good))
   changed['before_bundles'][GEO_PATH]=b'other bytes'
   refused('ledger_nginx_not_issued',ledger_args(changed))
   changed=m.nginx_ledger_input(m.ComponentResult('admitted','nginx_policy_verified',good))
   changed['observation_code']='not_applicable'
   refused('ledger_nginx_not_issued',ledger_args(changed))
   # The observation's shared_dir and bundles must be the configured ones.
   other_shared=OTHER_SHARED
   elsewhere=collect_elsewhere()
   assert n.admit_policy(elsewhere)==RANGES
   moved_input=m.nginx_ledger_input(m.ComponentResult('admitted','nginx_policy_verified',elsewhere))
   # The same file names and bundle paths: only the shared_dir differs from the config.
   assert set(moved_input['before_shared'])==set(data['before_shared']) and set(moved_input['before_bundles'])==set(data['before_bundles'])
   refused('ledger_nginx_shared_dir',ledger_args(moved_input))
   assert m.compile_ledger(**ledger_args(moved_input,shared=other_shared)).disposition=='validated_data_only'
   # Bundles paired differently (the same set of paths) are not the observed bundles.
   swapped=[{'geo_file':REALIP_PATH,'realip_file':GEO_PATH}]
   refused('ledger_nginx_bundle_evidence',ledger_args(data,bundles=swapped))
   # A disabled config takes only the issued not_applicable input.
   refused('ledger_nginx_none',ledger_args(data,enabled=False))
   # classify_frontier compares only an issued current input (nginx_ledger_input
   # of the current admitted observation) of the ledger's shared_dir and bundles.
   result=m.compile_ledger(**ledger_args(data))
   def classify(current):return m.classify_frontier(result,None,code_generation='c'*64,companions={},nginx_current=current)
   current=m.nginx_ledger_input(m.ComponentResult('admitted','nginx_policy_verified',good))
   assert classify(data)=='exact_frontier_data_only' and classify(current)=='exact_frontier_data_only'
   for value in (dict(current),copy.deepcopy(current),pickle.loads(pickle.dumps(current)),
                 {'observation_code':'nginx_observed','before_shared':dict(data['before_shared']),'before_bundles':dict(data['before_bundles'])},
                 none,moved_input,None):
    assert classify(value)=='manual_divergence',type(value)
   disabled=m.compile_ledger(**ledger_args(none,enabled=False))
   assert m.classify_frontier(disabled,None,code_generation='c'*64,companions={},nginx_current=none)=='exact_frontier_data_only'
   for value in (dict(none),{'observation_code':'not_applicable','before_shared':{},'before_bundles':{}},data,
                 m._issue_nginx_ledger_input({'observation_code':'not_applicable','before_shared':{},'before_bundles':{}},(SHARED,BUNDLES))):
    assert m.classify_frontier(disabled,None,code_generation='c'*64,companions={},nginx_current=value)=='manual_divergence'
  ''')
 def test_cli_inspect_runtime_outputs_only_fixed_codes(self):
  self.check('''
   import importlib.util
   spec=importlib.util.spec_from_file_location('cli_fixture',files/'cloudfront-sync.py');cf=importlib.util.module_from_spec(spec);spec.loader.exec_module(cf)
   cfg={'host_address':'192.0.2.10','firewall':{'backend':'none','ports':[443]},'nginx':{'enabled':True,'shared_dir':SHARED,'bundles':CONFIG_BUNDLES},
        'limits':{'max_changes':10,'min_ratio':.8},'notify_unit':''}
   evidence=types.SimpleNamespace(disposition='private_directory_absent',state=None,journal=None,state_files_read=True)
   real=n.Collector
   def inspect(root,run,contents=None):
    out,err=io.StringIO(),io.StringIO()
    made=lambda **kw:real(**kw,root=root,owner=UID,runner=run)
    with (linux_root(root),patch.object(cf,'_bundle_runtime',return_value={'cloudfront_snapshot':m}),
          patch.object(cf,'_bundle_config',return_value=copy.deepcopy(cfg)),
          patch.object(cf,'exclusive_lock',side_effect=lambda *a,**k:contextlib.nullcontext()),
          patch.object(m,'read_private_state',return_value=evidence),patch.object(n,'Collector',side_effect=made) as built,
          contextlib.redirect_stdout(out),contextlib.redirect_stderr(err)):
     code=cf.main(['inspect-runtime'])
    built.assert_called_once_with(shared_dir=SHARED,bundles=BUNDLES)
    for text in (out.getvalue(),err.getvalue()):
     assert SECRET not in text and 'origin-secret' not in text and 'cloudfront-origin' not in text and 'map ' not in text,text
    return code,out.getvalue(),err.getvalue()
   with host() as root:
    for run,expected in ((runner(),{'status':'admitted','code':'nginx_policy_verified'}),
                         (runner(code=1,stderr=('nginx: [emerg] '+SECRET+'\\n').encode()),{'status':'failure','code':'nginx_observation_failed'}),
                         (runner(stderr=('nginx: [warn] '+SECRET+'\\n').encode()),{'status':'admitted','code':'nginx_policy_verified'}),
                         (runner(stderr=(SECRET+'\\n').encode()),{'status':'failure','code':'nginx_observation_failed'}),
                         (runner(hook=lambda argv:(_ for _ in ()).throw(RuntimeError(SECRET))),{'status':'failure','code':'nginx_observation_failed'}),
                         (runner(daemon=DAEMON.replace(b'ActiveState=active',b'ActiveState=inactive')),{'status':'failure','code':'nginx_policy_unsupported'})):
     code,out,err=inspect(root,run)
     assert code==0 and err=='',err
     result=json.loads(out)
     assert result['nginx']==expected,result
     assert set(result['nginx'])=={'status','code'} and result['firewall']=={'status':'failure','code':'baseline_required'}
  ''')


if __name__=='__main__':unittest.main()
