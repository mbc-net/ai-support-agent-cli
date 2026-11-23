"""Concrete B0 read-only components and private data readers; no actors.

Observation, stock evidence validation and persisted baseline validation are
separate. Docker/context integration is not authorized here. The nginx
component is observed by nginx_observation.Collector (read-only, sandboxed
nginx -T) and admitted only by nginx_observation.admit_policy.
The B0 private-state reader is read-only: it never creates a directory, changes
policy or recovers a journal. The standalone B2 context collector reads fixed
host/SSH evidence only; it never grants admission. Existing pure kernel
mappers read their hash-pinned sibling profile assets during semantic
reconstruction; none performs host policy operations.
"""
import base64
from dataclasses import dataclass, field
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import weakref
import ufw_observation as observation
import nginx_observation
from ufw_integrity import UfwInventory, ManagedTuple, UserFileProfile, UserRulesDocument

MAX_RECORD = 16*1024*1024
MAX_WHOLE = 32*1024*1024
FORMAT = 'pt-kernel-v1'
# nginx: observation (nginx_observed or one of NGINX_OBSERVATION_FAILURES),
# then admission (nginx_policy_verified / nginx_policy_unsupported).
NGINX_OBSERVATION_FAILURES = ('nginx_sandbox_unavailable','nginx_observation_failed')
CODES = frozenset(('firewall_observed','firewall_observation_failed',
                   'nginx_observed',*NGINX_OBSERVATION_FAILURES,'nginx_policy_verified','nginx_policy_unsupported',
                   'stock_evidence_verified','stock_evidence_unsupported','nonstock_or_docker_not_authorized',
                   'baseline_required','persistent_baseline_mismatch','baseline_context_mismatch','snapshot_invalid'))

class SnapshotError(ValueError):
    """Fixed non-sensitive reader/validation failure codes."""

@dataclass(frozen=True)
class NotApplicable:
    component: str
    def __post_init__(self):
        if type(self.component) is not str or self.component not in ('firewall','nginx','context'):
            raise SnapshotError('invalid_component')

@dataclass(frozen=True)
class ComponentResult:
    status: str
    code: str
    evidence: object = field(default=None,repr=False)
    def __post_init__(self):
        if type(self.status) is not str or self.status not in ('observed','admitted','failure') or type(self.code) is not str or self.code not in CODES:
            raise SnapshotError('invalid_component_result')

@dataclass(frozen=True)
class ObservationSnapshot:
    backend: str
    nginx_enabled: bool
    firewall: object = field(repr=False)
    nginx: object = field(repr=False)
    # (shared_dir, bundle pairs) the Snapshotter was configured with, when nginx
    # is enabled; admission requires the observation to carry exactly these.
    nginx_expected: object = field(default=None,repr=False)

@dataclass(frozen=True)
class StockEvidence:
    observation: object = field(repr=False)
    proof: object = field(repr=False)

@dataclass(frozen=True)
class Admission:
    firewall: object = field(repr=False)
    nginx: object = field(repr=False)
    # No overall healthy/authorized bool: B0 does not grant any actor.

@dataclass(frozen=True)
class PersistentP:
    raw: bytes = field(repr=False)
    backend: str = field(repr=False)
    config_hash: str = field(repr=False)
    enrollment_id: str = field(repr=False)
    profile_id: str = field(repr=False)
    inventory: object = field(repr=False)
    owned_rules: tuple = field(repr=False)

@dataclass(frozen=True)
class StateData:
    # Shape/context only. B1 must bind ranges/ports/ownership/protected domain.
    disposition: str
    raw: bytes = field(repr=False)
    baseline: object = field(default=None,repr=False)
    generation_id: object = field(default=None,repr=False)
    config_hash: object = field(default=None,repr=False)
    enrollment_id: object = field(default=None,repr=False)
    ranges: tuple = field(default=(),repr=False)
    aws_sync_token: object = field(default=None,repr=False)
    last_success: object = field(default=None,repr=False)

@dataclass(frozen=True)
class JournalData:
    disposition: str
    raw: bytes = field(repr=False)
    # Even the recognized header is manual until B1 validates its full ledger.

@dataclass(frozen=True)
class PrivateStateEvidence:
    """Read-only bounded view of the fixed private namespace; never authority.

    ``state_files_read`` tells what a None ``state``/``journal`` means: True
    when state.json and journal.json are known not to exist unless parsed
    here (the directory is absent, or every file was read), False when the
    files were never read (unknown entries stop after the listing), so a
    state.json or journal.json may exist.
    """
    disposition: str
    directory_identity: tuple = field(default=(),repr=False)
    entries: tuple = field(default=(),repr=False)
    state: object = field(default=None,repr=False)
    journal: object = field(default=None,repr=False)
    companions: tuple = field(default=(),repr=False)
    state_files_read: bool = False


_PRIVATE_FILES = ('backup.json','install-journal.json','intent.json','journal.json',
                  'operation-receipt.json','pending.json','state.json')

def _fs_identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,
            info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def _open_private_parent(target,owner):
    """Open the parent of ``target`` by a no-follow walk from '/'.

    Exactly one descriptor (the parent's) is open on return, and none after
    any exception: each descriptor is owned by one try block from the moment
    os.open returns it, so a failing os.fstat/os.close cannot leak it.
    """
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|getattr(os,'O_NOFOLLOW',0))
    try:
        chain=[_fs_identity(os.fstat(fd))]
        for part in target.parts[1:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|getattr(os,'O_NOATIME',0),dir_fd=fd)
            try:
                info=os.fstat(child);sticky=part=='tmp' and info.st_uid==0 and info.st_mode&stat.S_ISVTX
                if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0,owner)
                        or (info.st_mode&0o022 and not sticky)):
                    raise SnapshotError('private_state_unsafe_parent')
            except BaseException:
                os.close(child);raise
            # The child is the walk's descriptor before the parent is closed.
            parent,fd=fd,child;os.close(parent);chain.append(_fs_identity(info))
        return fd,tuple(chain)
    except BaseException:
        os.close(fd);raise

def _ancestor_identity(identity):
    """What replacing an ancestor changes: (st_dev, st_ino, st_mode, st_uid, st_gid).

    The link count, size, mtime and ctime of '/', /var, /var/lib and the
    parent change whenever an unrelated entry is created or removed in them,
    so they are not compared; only the private directory itself (the leaf)
    is held to its full _fs_identity.
    """
    return identity[:5]

def _revalidate_private_name(target,expected_chain,owner,expected_directory):
    """Walk to the parent again: every ancestor must be the same directory
    (_ancestor_identity, else private_state_parent_changed) and the leaf must
    still be absent (``expected_directory`` None) or have exactly the full
    identity ``expected_directory`` (else private_state_directory_changed)."""
    fd,chain=_open_private_parent(target,owner)
    try:
        if [_ancestor_identity(item) for item in chain]!=[_ancestor_identity(item) for item in expected_chain]:
            raise SnapshotError('private_state_parent_changed')
        try:current=os.stat(target.name,dir_fd=fd,follow_symlinks=False)
        except FileNotFoundError:
            if expected_directory is None:return
            raise SnapshotError('private_state_directory_changed')
        if expected_directory is None or _fs_identity(current)!=expected_directory:
            raise SnapshotError('private_state_directory_changed')
    finally:os.close(fd)

def _private_names(directory_fd):
    names=[]
    with os.scandir(directory_fd) as scan:
        for entry in scan:
            if len(names)>=64:raise SnapshotError('private_state_entry_budget')
            names.append(entry.name)
    return tuple(sorted(names))

def _private_listing(directory_fd):
    """List the private directory: its sorted names and, for each known name,
    the lstat the listing itself made (DirEntry.stat without following).

    That lstat is the identity the name is held to from then on. A name gone
    before its DirEntry lstat is private_state_file_changed.
    """
    names=[];listed={}
    with os.scandir(directory_fd) as scan:
        for entry in scan:
            if len(names)>=64:raise SnapshotError('private_state_entry_budget')
            names.append(entry.name)
            if entry.name in _PRIVATE_FILES:
                try:listed[entry.name]=entry.stat(follow_symlinks=False)
                except FileNotFoundError:raise SnapshotError('private_state_file_changed') from None
    return tuple(sorted(names)),listed

# Replacement is decided by identity, never by errno: after an OSError the
# name is lstat-ed again and compared with the identity it is held to. An
# errno (ELOOP, ENXIO, EISDIR, ENOENT, ...) with the name unchanged is the
# I/O failure it reports (private_state_unavailable), not a replacement.

def _lstat_private(dfd,name):
    """lstat one private name; its removal is private_state_file_changed."""
    try:return os.stat(name,dir_fd=dfd,follow_symlinks=False)
    except FileNotFoundError:raise SnapshotError('private_state_file_changed') from None

def _require_same_private_name(dfd,name,identity):
    """After an OSError on ``name``: gone or another identity is
    private_state_file_changed; otherwise the caller re-raises that OSError
    (private_state_unavailable)."""
    if _fs_identity(_lstat_private(dfd,name))!=identity:raise SnapshotError('private_state_file_changed') from None

def _read_bounded(dfd,name,identity,limit):
    """Read one private file, bound to the identity the listing recorded.

    Shared by the capture and the final recheck: a no-follow, non-blocking
    open, the descriptor's fstat must match ``identity``, at most ``limit``
    bytes are read, and after the read both the descriptor's fstat and the
    name's lstat must still match ``identity``. Any OSError of the open or
    of the read lstats the name again (_require_same_private_name): rebound
    or removed is private_state_file_changed, unchanged is the OSError
    (private_state_unavailable). The caller has already checked the size in
    ``identity`` against ``limit`` (the budget verdict is that listing check
    alone), so reading more than ``limit`` bytes means the file grew after
    its fstat matched: private_state_file_changed.
    """
    try:source=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|getattr(os,'O_NOATIME',0),dir_fd=dfd)
    except OSError:
        _require_same_private_name(dfd,name,identity);raise
    try:
        try:
            if _fs_identity(os.fstat(source))!=identity:raise SnapshotError('private_state_file_changed')
            data=bytearray()
            while True:
                chunk=os.read(source,min(65536,limit+1-len(data)))
                if not chunk:break
                data.extend(chunk)
                if len(data)>limit:raise SnapshotError('private_state_file_changed')
            if _fs_identity(os.fstat(source))!=identity or _fs_identity(_lstat_private(dfd,name))!=identity:
                raise SnapshotError('private_state_file_changed')
        except OSError:
            _require_same_private_name(dfd,name,identity);raise
        return bytes(data)
    finally:os.close(source)

def _recheck_private_file(dfd,name,expected_identity,captured,max_record):
    """Final recheck of one captured private file: identity, then bytes.

    The reread is the capture's _read_bounded (same open, the same identity
    match before and after the read, the same lstat after any OSError, so a
    removed or rebound name is private_state_file_changed; bounded by
    max_record and not charged against the whole-namespace budget again);
    differing bytes are private_state_file_changed.
    """
    if _read_bounded(dfd,name,expected_identity,max_record)!=captured:
        raise SnapshotError('private_state_file_changed')

def read_private_state(path='/var/lib/cloudfront-sync/private',*,owner=0,
                       group=0,max_record=MAX_RECORD,max_total=MAX_WHOLE):
    """Capture the fixed root-private namespace without creating or repairing it.

    Unknown names and every legacy pending/backup/install artifact stop as
    manual evidence. Raw bytes remain in repr-hidden records and are never
    suitable as an actor capability.

    Only the leaf's absence below an intact, safe parent chain is a
    disposition (private_directory_absent). Every OSError, including those
    of the ancestors (absent, not a directory, EACCES), is the fixed
    private_state_unavailable, except where a fresh lstat shows replacement:
    the listing records each known name's lstat (DirEntry.stat); a name
    that is then not a safe regular file (symlink, directory, FIFO, socket,
    owner, mode, links, size) is private_state_unsafe_file, while a name
    whose identity differs from that listing later (rebound or removed
    before or during its capture or recheck, also when an open or read
    failed) is private_state_file_changed. The directory itself is held to
    its lstat the same way: an fstat of the opened directory that differs,
    or a failed open after which a fresh lstat finds it gone or different,
    is private_state_directory_changed; a failed open with the directory
    unchanged is private_state_unavailable. A size over max_record or the
    remaining max_total is decided by the listing's lstat
    (private_state_unsafe_file); a read past that checked size is a
    concurrent change (private_state_file_changed). The directory is listed
    again after the content recheck; any change of its names is
    private_state_directory_changed. Before any result the parent chain is
    walked again: an ancestor ('/', ..., the parent) that is another
    directory now (device, inode, mode, owner or group differ) is
    private_state_parent_changed; unrelated entries created or removed in an
    ancestor (its links, size, mtime, ctime) are not a change.
    """
    if (type(path) is not str and not isinstance(path,Path) or not Path(path).is_absolute()
            or '..' in Path(path).parts or Path(path)==Path('/')
            or type(owner) is not int or not 0<=owner<2**32-1
            or type(group) is not int or not 0<=group<2**32-1
            or type(max_record) is not int or not 0<max_record<=MAX_RECORD
            or type(max_total) is not int or not 0<max_total<=MAX_WHOLE):
        raise SnapshotError('private_state_options')
    target=Path(path)
    try:fd,expected_chain=_open_private_parent(target,owner)
    except OSError:raise SnapshotError('private_state_unavailable') from None
    parent_identity=expected_chain[-1]
    try:
        leaf=target.name
        try: before=os.stat(leaf,dir_fd=fd,follow_symlinks=False)
        except FileNotFoundError:
            _revalidate_private_name(target,expected_chain,owner,None)
            return PrivateStateEvidence('private_directory_absent',parent_identity,state_files_read=True)
        if (not stat.S_ISDIR(before.st_mode) or before.st_uid!=owner or before.st_gid!=group
                or stat.S_IMODE(before.st_mode)!=0o700 or before.st_nlink<2):
            raise SnapshotError('private_state_unsafe_directory')
        try:dfd=os.open(leaf,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|getattr(os,'O_NOATIME',0),dir_fd=fd)
        except OSError:
            # Replaced between its lstat and its open, or the open failed.
            try:current=os.stat(leaf,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:raise SnapshotError('private_state_directory_changed') from None
            if _fs_identity(current)!=_fs_identity(before):raise SnapshotError('private_state_directory_changed') from None
            raise
        try:
            if _fs_identity(os.fstat(dfd))!=_fs_identity(before):raise SnapshotError('private_state_directory_changed')
            names,listed=_private_listing(dfd)
            unknown=tuple(name for name in names if name not in _PRIVATE_FILES)
            if unknown:
                if _fs_identity(os.fstat(dfd))!=_fs_identity(before):raise SnapshotError('private_state_directory_changed')
                _revalidate_private_name(target,expected_chain,owner,_fs_identity(before))
                return PrivateStateEvidence('unknown_private_entries_manual',_fs_identity(before),names)
            contents={};rows=[];total=0
            for name in names:
                # Held to the listing's lstat: not a safe regular file there
                # is unsafe; any later difference is a change (_read_bounded).
                current=listed[name]
                if (not stat.S_ISREG(current.st_mode) or current.st_uid!=owner or current.st_gid!=group
                        or stat.S_IMODE(current.st_mode)!=0o600 or current.st_nlink!=1
                        or current.st_size>max_record or total+current.st_size>max_total):
                    raise SnapshotError('private_state_unsafe_file')
                raw=_read_bounded(dfd,name,_fs_identity(current),min(max_record,max_total-total))
                total+=len(raw);contents[name]=raw;rows.append((name,_fs_identity(current)))
            final_names=_private_names(dfd)
            if _fs_identity(os.fstat(dfd))!=_fs_identity(before) or final_names!=names:
                raise SnapshotError('private_state_directory_changed')
            # Metadata alone misses a same-size rewrite within one timestamp
            # tick, so every captured file (each capture descriptor already
            # closed) is reopened and its bytes compared again.
            for name,expected_identity in rows:
                _recheck_private_file(dfd,name,expected_identity,contents[name],max_record)
            # Listed again after the recheck: a name created or removed while
            # the files were reread is not part of this capture.
            if _fs_identity(os.fstat(dfd))!=_fs_identity(before) or _private_names(dfd)!=names:
                raise SnapshotError('private_state_directory_changed')
            _revalidate_private_name(target,expected_chain,owner,_fs_identity(before))
            state=parse_state(contents['state.json'],owner=owner) if 'state.json' in contents else None
            journal=parse_journal(contents['journal.json'],owner=owner) if 'journal.json' in contents else None
            has_manual=any(name in contents for name in ('backup.json','install-journal.json','intent.json',
                                                          'operation-receipt.json','pending.json'))
            if has_manual:disposition='pending_or_companion_manual'
            elif journal is not None:disposition=journal.disposition
            elif state is not None:disposition=state.disposition
            else:disposition='private_namespace_empty'
            return PrivateStateEvidence(disposition,_fs_identity(before),tuple(rows),state,journal,
                                        tuple((name,contents[name]) for name in names if name not in ('state.json','journal.json')),
                                        state_files_read=True)
        finally:os.close(dfd)
    except SnapshotError:raise
    except OSError:raise SnapshotError('private_state_unavailable') from None
    finally:os.close(fd)


def _canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()

def config_hash(config):
    """The config hash persisted in P, state and journal: bare 64-digit lowercase hex.

    The one definition shared by the ledger and the CLI; its value is the
    sha256 of the canonical JSON already recorded on hosts.
    """
    return hashlib.sha256(_canonical(config)).hexdigest()

def _hex(value,size=64):
    return type(value) is str and re.fullmatch('[0-9a-f]{'+str(size)+'}',value) is not None

def _json(raw):
    if type(raw) is not bytes or not 0<len(raw)<=MAX_RECORD:
        raise SnapshotError('private_record_budget')
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:raise SnapshotError('duplicate_private_key')
            result[key]=value
        return result
    def invalid(unused):raise SnapshotError('noninteger_private_number')
    def integer(text):
        if len(text)>20:raise SnapshotError('private_integer_budget')
        return int(text)
    try:
        value=json.loads(raw.decode(),object_pairs_hook=pairs,parse_float=invalid,parse_constant=invalid,parse_int=integer)
        pending=[(value,0)];count=0
        while pending:
            item,depth=pending.pop();count+=1
            if depth>32 or count>100000:raise SnapshotError('private_structure_budget')
            if isinstance(item,dict):pending.extend((v,depth+1) for v in item.values())
            elif isinstance(item,list):pending.extend((v,depth+1) for v in item)
        if type(value) is not dict:raise SnapshotError('invalid_private_object')
        return value
    except SnapshotError:raise
    except Exception:raise SnapshotError('invalid_private_json') from None


def _inventory(data,owner):
    if type(owner) is not int or not 0<=owner<2**32-1:
        raise SnapshotError('invalid_inventory_owner')
    if type(data) is not dict or set(data)!={'manifest','contents'} or type(data['manifest']) is not list or type(data['contents']) is not dict:
        raise SnapshotError('invalid_inventory_schema')
    rows,encoded=data['manifest'],data['contents']
    if not 1<=len(rows)<=256 or len(encoded)>256:raise SnapshotError('inventory_count_budget')
    contents={};total=0
    for path,text in encoded.items():
        if type(path) is not str or type(text) is not str or len(text)>4*((4*1024*1024+2)//3):raise SnapshotError('invalid_inventory_bytes')
        try:raw=base64.b64decode(text,validate=True)
        except Exception:raise SnapshotError('invalid_inventory_bytes') from None
        if base64.b64encode(raw).decode()!=text or len(raw)>4*1024*1024:raise SnapshotError('invalid_inventory_bytes')
        total+=len(raw)
        if total>16*1024*1024:raise SnapshotError('inventory_byte_budget')
        contents[path]=raw
    paths=set();files=set()
    for row in rows:
        if type(row) is not dict:raise SnapshotError('invalid_inventory_row')
        base={'path','kind','mode','uid','gid'}
        if not base<=set(row):raise SnapshotError('invalid_inventory_row')
        path=row['path']
        if (type(path) is not str or '\x00' in path or str(PurePosixPath(path))!=path or '..' in PurePosixPath(path).parts or path in paths
                or (path!='/etc/default/ufw' and path!='/etc/ufw' and not path.startswith('/etc/ufw/'))):raise SnapshotError('invalid_inventory_path')
        paths.add(path)
        if (any(type(row[key]) is not int or not 0<=row[key]<2**32-1 for key in ('uid','gid'))
                or row['uid']!=owner or type(row['mode']) is not int or not 0<=row['mode']<=0o777 or row['mode']&0o022):raise SnapshotError('unsafe_inventory_metadata')
        if row['kind']=='file':
            if set(row)!=base|{'size','sha256'} or type(row['size']) is not int or not 0<=row['size']<=4*1024*1024 or not _hex(row['sha256']):raise SnapshotError('invalid_inventory_file')
            raw=contents.get(path)
            if raw is None or len(raw)!=row['size'] or hashlib.sha256(raw).hexdigest()!=row['sha256']:raise SnapshotError('inventory_bytes_differ')
            files.add(path)
        elif row['kind']!='directory' or set(row)!=base:raise SnapshotError('invalid_inventory_row')
    required={'/etc/default/ufw',*['/etc/ufw/'+name for name in ('user.rules','user6.rules','before.rules','before6.rules','after.rules','after6.rules','ufw.conf')]}
    directories=paths-files
    if (files!=set(contents) or not required<=files or '/etc/ufw' not in directories
            or any(str(PurePosixPath(path).parent) not in directories for path in paths if path not in ('/etc/ufw','/etc/default/ufw'))
            or [row['path'] for row in rows]!=sorted(paths)):
        raise SnapshotError('incomplete_inventory')
    return UfwInventory(tuple(rows),contents)


def parse_p(raw,*,owner=0):
    if type(owner) is not int or not 0<=owner<2**32-1:raise SnapshotError('invalid_inventory_owner')
    try:
        value=_json(raw)
        if set(value)!={'integrity_format','backend','config_hash','enrollment_id','profile_id','inventory','owned_rules'} or value['integrity_format']!=FORMAT:
            raise SnapshotError('unsupported_p_schema')
        backend=value['backend'];profile=value['profile_id'];owned=value['owned_rules']
        if (type(backend) is not str or backend not in ('ufw','none') or not _hex(value['config_hash']) or not _hex(value['enrollment_id'],32)
                or type(profile) is not str or type(owned) is not list or len(owned)>4096):raise SnapshotError('invalid_p_context')
        if backend=='none':
            if profile!='none' or value['inventory'] is not None or owned:raise SnapshotError('invalid_none_baseline')
            inventory=None
        else:
            if profile not in ('stock-ubuntu-22.04','stock-ubuntu-24.04','stock-ubuntu-26.04'):raise SnapshotError('unsupported_p_profile')
            inventory=_inventory(value['inventory'],owner)
        rules=[]
        for row in owned:
            if type(row) is not dict or set(row)!={'source','port','comment'} or type(row['source']) is not str or type(row['comment']) is not str or len(row['comment'].encode())>1024 or type(row['port']) is not int:
                raise SnapshotError('invalid_owned_rule')
            network=ipaddress.ip_network(row['source'],strict=True)
            if str(network)!=row['source']:raise SnapshotError('invalid_owned_rule')
            rule=ManagedTuple(row['source'],row['port'],row['comment']);rule.block(UserFileProfile(network.version))
            rules.append((rule.source,rule.port,rule.comment))
        if len(set(rules))!=len(rules) or len({(s,p) for s,p,c in rules})!=len(rules):raise SnapshotError('duplicate_owned_rule')
        if inventory is not None:
            documents={family:UserRulesDocument.parse(inventory.contents['/etc/ufw/'+leaf],UserFileProfile(family)) for family,leaf in ((4,'user.rules'),(6,'user6.rules'))}
            for source,port,comment in rules:
                family=ipaddress.ip_network(source).version
                if documents[family].blocks.count(ManagedTuple(source,port,comment).block(documents[family].profile))!=1:
                    raise SnapshotError('owned_tuple_absent_from_baseline')
        normalized=_canonical(value)
        # Combined encoded/decoded budget; do not truncate a baseline.
        decoded=sum(map(len,inventory.contents.values())) if inventory is not None else 0
        if len(normalized)+decoded>MAX_WHOLE:raise SnapshotError('private_whole_budget')
        return PersistentP(normalized,backend,value['config_hash'],value['enrollment_id'],profile,inventory,tuple(rules))
    except SnapshotError:raise
    except Exception:raise SnapshotError('invalid_p_data') from None


_LEGACY_KEYS={'version','initialized','ranges','aws_sync_token','config_hash','owned_rules','snapshot','last_success','ufw_integrity','enrollment_id'}
def parse_state(raw,*,owner=0):
    value=_json(raw)
    if type(value.get('version')) is not int:raise SnapshotError('invalid_state_version')
    if 'integrity_format' not in value:
        if value['version'] not in (1,2) or not set(value)<=_LEGACY_KEYS:raise SnapshotError('unsupported_state_schema')
        return StateData('manual_legacy_or_unproven_state',bytes(raw))
    fields={'version','integrity_format','generation_id','config_hash','enrollment_id','baseline','ranges','aws_sync_token','last_success'}
    if set(value)!=fields or value['version']!=2 or value['integrity_format']!=FORMAT or not _hex(value['generation_id']):raise SnapshotError('unsupported_state_schema')
    baseline=parse_p(_canonical(value['baseline']),owner=owner)
    if value['config_hash']!=baseline.config_hash or value['enrollment_id']!=baseline.enrollment_id:raise SnapshotError('state_baseline_context_differs')
    ranges=value['ranges']
    try:
        if type(ranges) is not list or not 1<=len(ranges)<=4096 or any(type(v) is not str or str(ipaddress.ip_network(v,strict=True))!=v or ipaddress.ip_network(v).prefixlen==0 for v in ranges) or len(set(ranges))!=len(ranges):raise ValueError()
    except Exception:raise SnapshotError('invalid_state_ranges') from None
    if (type(value['aws_sync_token']) is not str or re.fullmatch('[0-9]{1,20}',value['aws_sync_token']) is None
            or (value['last_success'] is not None and (type(value['last_success']) is not int or not 0<=value['last_success']<2**63))):raise SnapshotError('invalid_state_metadata')
    return StateData('pt_state_data_only',_canonical(value),baseline,value['generation_id'],
                     value['config_hash'],value['enrollment_id'],tuple(ranges),
                     value['aws_sync_token'],value['last_success'])


def parse_journal(raw,*,owner=0):
    value=_json(raw)
    if type(value.get('version')) is not int:raise SnapshotError('invalid_journal_version')
    if 'journal_format' not in value:
        legacy={'version','config_hash','before','old_state','target_rules','target_nginx','new_state','addition_attempts','deletion_attempts','ufw_steps'}
        if value['version'] not in (1,2) or not set(value)<=legacy:raise SnapshotError('unsupported_journal_schema')
        return JournalData('manual_legacy_pending',bytes(raw))
    fields={'version','journal_format','generation_id','config_hash','enrollment_id','transaction_id','phase','frontier','step_count','baseline'}
    if (set(value)!=fields or value['version']!=2 or value['journal_format']!=FORMAT
            or any(not _hex(value[key]) for key in ('generation_id','config_hash','transaction_id'))
            or not _hex(value['enrollment_id'],32) or type(value['phase']) is not str or value['phase'] not in ('prepared','forward_armed','forward_verified','rollback_armed','rollback_verified','state_prepared','state_committed')
            or type(value['step_count']) is not int or not 0<=value['step_count']<=4096
            or type(value['frontier']) is not int or not 0<=value['frontier']<=value['step_count']):raise SnapshotError('unsupported_journal_schema')
    baseline=parse_p(_canonical(value['baseline']),owner=owner)
    if value['config_hash']!=baseline.config_hash or value['enrollment_id']!=baseline.enrollment_id:raise SnapshotError('journal_baseline_context_differs')
    return JournalData('manual_ledger_not_connected',_canonical(value))


def _nginx_bundle_pairs(bundles):
    """Config bundles ({'geo_file','realip_file'} mappings) as (geo, realip) path pairs, or None."""
    if type(bundles) not in (list,tuple):return None
    pairs=[]
    for bundle in bundles:
        if type(bundle) is not dict or set(bundle)!={'geo_file','realip_file'} or any(type(v) is not str for v in bundle.values()):return None
        pairs.append((bundle['geo_file'],bundle['realip_file']))
    return tuple(pairs)


class Snapshotter:
    def __init__(self,*,backend,nginx_enabled,collector=None,nginx_shared_dir=None,nginx_bundles=None,nginx_collector=None):
        if type(backend) is not str or backend not in ('ufw','none') or type(nginx_enabled) is not bool:raise SnapshotError('invalid_snapshot_options')
        self._backend,self._nginx_enabled,self._collector=backend,nginx_enabled,collector
        self._nginx_shared_dir=self._nginx_bundles=self._nginx_collector=None
        if nginx_enabled:
            # Required when enabled; a disabled nginx is never read (no I/O).
            pairs=_nginx_bundle_pairs(nginx_bundles)
            if type(nginx_shared_dir) is not str or not pairs:raise SnapshotError('invalid_snapshot_options')
            if nginx_collector is None:
                # Paths the Collector refuses (a trailing '/', '.', a bundle that is
                # a shared file, ...) fail the nginx component only, when collected
                # (nginx_observation_failed); the firewall is still observed.
                try:nginx_collector=nginx_observation.Collector(shared_dir=nginx_shared_dir,bundles=pairs)
                except nginx_observation.NginxObservationError:nginx_collector=None
            self._nginx_shared_dir,self._nginx_bundles,self._nginx_collector=nginx_shared_dir,pairs,nginx_collector
    def _nginx(self):
        if not self._nginx_enabled:return NotApplicable('nginx')
        code='nginx_observation_failed'
        if self._nginx_collector is None:return ComponentResult('failure',code)
        try:
            captured=self._nginx_collector.collect()
            if (nginx_observation.collected(captured) and captured.shared_dir==self._nginx_shared_dir
                    and captured.bundles==self._nginx_bundles):
                return ComponentResult('observed','nginx_observed',captured)
        except nginx_observation.NginxObservationError as error:
            if type(error) is nginx_observation.NginxObservationError and len(error.args)==1 and error.args[0] in NGINX_OBSERVATION_FAILURES:code=error.args[0]
        except Exception:pass
        return ComponentResult('failure',code)
    def collect(self):
        if self._backend=='none':firewall=NotApplicable('firewall')
        else:
            try:
                captured=(self._collector if self._collector is not None else observation.Collector()).collect()
                if type(captured) is not observation.Observation:raise SnapshotError('invalid_observation')
                firewall=ComponentResult('observed','firewall_observed',captured)
            except Exception:firewall=ComponentResult('failure','firewall_observation_failed')
        # Evaluate this branch independently, including after firewall failure.
        expected=(self._nginx_shared_dir,self._nginx_bundles) if self._nginx_enabled else None
        return ObservationSnapshot(self._backend,self._nginx_enabled,firewall,self._nginx(),expected)


def _admit_nginx(snapshot):
    """The decided nginx component. Only a forged type/code raises. An
    observation is verified only when admit_policy accepts it (it must be one
    Collector.collect() returned, unchanged) and its shared_dir and bundles are
    the snapshot's nginx_expected (the Snapshotter's configured values)."""
    value=snapshot.nginx
    if not snapshot.nginx_enabled:
        if type(value) is not NotApplicable or value!=NotApplicable('nginx'):raise SnapshotError('invalid_nginx_component')
        return value
    if type(value) is not ComponentResult:raise SnapshotError('invalid_nginx_component')
    if value.status=='failure' and value.code in NGINX_OBSERVATION_FAILURES and value.evidence is None:return value
    if value.status!='observed' or value.code!='nginx_observed' or type(value.evidence) is not nginx_observation.NginxObservation:raise SnapshotError('invalid_nginx_component')
    evidence=value.evidence
    try:
        nginx_observation.admit_policy(evidence)
        expected=snapshot.nginx_expected
        if (type(expected) is not tuple or len(expected)!=2 or type(expected[0]) is not str or type(expected[1]) is not tuple
                or evidence.shared_dir!=expected[0] or evidence.bundles!=expected[1]):
            raise SnapshotError('nginx_policy_unsupported')
    except Exception:return ComponentResult('failure','nginx_policy_unsupported',evidence)
    return ComponentResult('admitted','nginx_policy_verified',evidence)


def _admit_snapshot(snapshot,baseline=None,*,config_hash=None,enrollment_id=None,owner=0):
    if type(snapshot) is not ObservationSnapshot or type(snapshot.backend) is not str or snapshot.backend not in ('ufw','none') or type(snapshot.nginx_enabled) is not bool:raise SnapshotError('invalid_snapshot')
    nginx=_admit_nginx(snapshot)
    if baseline is not None:
        if type(baseline) is not PersistentP:raise SnapshotError('invalid_baseline_record')
        checked=parse_p(baseline.raw,owner=owner)
        if checked!=baseline:raise SnapshotError('invalid_baseline_record')
        baseline=checked
        if not _hex(config_hash) or not _hex(enrollment_id,32) or baseline.config_hash!=config_hash or baseline.enrollment_id!=enrollment_id or baseline.backend!=snapshot.backend:
            return Admission(ComponentResult('failure','baseline_context_mismatch'),nginx)
    if snapshot.backend=='none':
        if type(snapshot.firewall) is not NotApplicable or snapshot.firewall!=NotApplicable('firewall'):raise SnapshotError('invalid_none_component')
        return Admission(snapshot.firewall if baseline is not None else ComponentResult('failure','baseline_required'),nginx)
    result=snapshot.firewall
    if type(result) is not ComponentResult:raise SnapshotError('invalid_firewall_component')
    if result.status=='failure' and result.code=='firewall_observation_failed' and result.evidence is None:return Admission(result,nginx)
    if result.status!='observed' or result.code!='firewall_observed' or type(result.evidence) is not observation.Observation:raise SnapshotError('invalid_firewall_component')
    captured=result.evidence
    # Retain the whole evidence. No Docker/table filtering or context inference.
    if any(table.name in ('nat','raw') for view in captured.selected for table in view.tables):
        return Admission(ComponentResult('failure','nonstock_or_docker_not_authorized',captured),nginx)
    try:proof=observation.admit_stock(captured,owner=owner)
    except Exception:return Admission(ComponentResult('failure','stock_evidence_unsupported',captured),nginx)
    private=StockEvidence(captured,proof)
    if baseline is None:return Admission(ComponentResult('failure','baseline_required',private),nginx)
    if baseline.profile_id!='stock-ubuntu-'+captured.os_id or baseline.inventory!=captured.inventory:
        return Admission(ComponentResult('failure','persistent_baseline_mismatch',private),nginx)
    return Admission(ComponentResult('admitted','stock_evidence_verified',private),nginx)


def admit_snapshot(snapshot,baseline=None,*,config_hash=None,enrollment_id=None,owner=0):
    try:
        return _admit_snapshot(snapshot,baseline,config_hash=config_hash,enrollment_id=enrollment_id,owner=owner)
    except SnapshotError:raise
    except Exception:raise SnapshotError('invalid_snapshot_data') from None

# B1 is a pure evidence compiler. These imports resolve to the earlier fixed
# verified DAG nodes; no actor or context acquisition is introduced.
import math as _ledger_math
import ufw_kernel as _ledger_kernel
import ufw_kernel_mapping as _ledger_mapping
import ufw_docker_kernel as _ledger_docker
import ufw_docker_transition as _ledger_transition

JOURNAL_LIMIT = 16*1024*1024
WHOLE_LIMIT = 32*1024*1024
_COMPANIONS = ('pending','backup','old_state','old_install_assets','new_install_assets','intent_before','intent_after')
_CONTEXT_VIEWS = ('links','addresses4','addresses6','routes4','routes6','rules4','rules6')
_PHASES = ('prepared','nginx_armed','nginx_verified','forward_armed','forward_verified','rollback_armed','rollback_verified','nginx_rollback_armed','nginx_rollback_verified','state_prepared','state_committed')

@dataclass(frozen=True)
class ValidatedLedgerData:
    wire: bytes = field(repr=False)
    transaction_id: str = field(repr=False)
    journal_peak: int
    whole_peak: int
    disposition: str = 'validated_data_only'

class _LedgerBlobs:
    def __init__(self):self.data={}
    def put(self,raw):
        if type(raw) is not bytes or len(raw)>8*1024*1024:raise SnapshotError('ledger_blob_budget')
        digest=hashlib.sha256(raw).hexdigest()
        prior=self.data.get(digest)
        if prior is not None and prior!=raw:raise SnapshotError('ledger_digest_collision')
        self.data[digest]=raw
        if len(self.data)>16384 or sum(map(len,self.data.values()))>WHOLE_LIMIT:raise SnapshotError('ledger_blob_aggregate_budget')
        return digest
    def encoded(self):return {digest:{'size':len(raw),'data':base64.b64encode(raw).decode()} for digest,raw in sorted(self.data.items())}


def _ledger_json(raw):
    if type(raw) is not bytes or not 0<len(raw)<=64*1024:raise SnapshotError('ledger_config_budget')
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:raise SnapshotError('ledger_duplicate_key')
            result[key]=value
        return result
    def number(text):
        value=float(text)
        if not _ledger_math.isfinite(value):raise SnapshotError('ledger_nonfinite_number')
        return value
    def invalid(unused):raise SnapshotError('ledger_nonfinite_number')
    try:return json.loads(raw.decode(),object_pairs_hook=pairs,parse_float=number,parse_constant=invalid)
    except SnapshotError:raise
    except Exception:raise SnapshotError('invalid_ledger_config_json') from None


def _ledger_config(raw):
    value=_ledger_json(raw)
    if type(value) is not dict or set(value)!={'host_address','firewall','nginx','limits','notify_unit'}:raise SnapshotError('ledger_config_schema')
    if type(value['host_address']) is not str or str(ipaddress.ip_address(value['host_address']))!=value['host_address']:raise SnapshotError('ledger_host_address')
    firewall,nginx,limits=value['firewall'],value['nginx'],value['limits']
    if type(firewall) is not dict or set(firewall)!={'backend','ports'} or firewall['backend'] not in ('ufw','none'):raise SnapshotError('ledger_firewall_config')
    ports=firewall['ports']
    if type(ports) is not list or not ports or any(type(p) is not int or not 1<=p<=65535 or p==22 for p in ports) or len(set(ports))!=len(ports):raise SnapshotError('ledger_ports')
    if type(nginx) is not dict or set(nginx)!={'enabled','shared_dir','bundles'} or type(nginx['enabled']) is not bool or type(nginx['bundles']) is not list:raise SnapshotError('ledger_nginx_config')
    def path(name):
        return type(name) is str and re.fullmatch('/etc/(?:nginx|common-sv/nginx)/[A-Za-z0-9_./-]+',name) is not None and '..' not in PurePosixPath(name).parts and str(PurePosixPath(name))==name
    if not path(nginx['shared_dir']) or nginx['shared_dir'] in ('/etc/nginx','/etc/common-sv/nginx') or (nginx['enabled'] and not nginx['bundles']):raise SnapshotError('ledger_nginx_path')
    paths=[]
    for bundle in nginx['bundles']:
        if type(bundle) is not dict or set(bundle)!={'geo_file','realip_file'} or not all(path(v) for v in bundle.values()):raise SnapshotError('ledger_nginx_bundle')
        paths.extend(bundle.values())
    if len(paths)!=len(set(paths)):raise SnapshotError('ledger_duplicate_bundle')
    if (type(limits) is not dict or set(limits)!={'max_changes','min_ratio'} or type(limits['max_changes']) is not int or not 1<=limits['max_changes']<=1000
            or type(limits['min_ratio']) not in (int,float) or not _ledger_math.isfinite(limits['min_ratio']) or not 0<limits['min_ratio']<=1):raise SnapshotError('ledger_limits')
    if type(value['notify_unit']) is not str or (value['notify_unit'] and re.fullmatch('[A-Za-z0-9_@.-]+\\.service',value['notify_unit']) is None):raise SnapshotError('ledger_notify_unit')
    return value


def _ledger_networks(values,*,both=False,empty=False):
    if type(values) is not list or len(values)>4096 or (not values and not empty):raise SnapshotError('ledger_ranges')
    networks=[]
    for value in values:
        if type(value) is not str:raise SnapshotError('ledger_ranges')
        network=ipaddress.ip_network(value,strict=True)
        if str(network)!=value or network.prefixlen==0:raise SnapshotError('ledger_ranges')
        networks.append(network)
    if len(set(networks))!=len(networks) or networks!=sorted(networks,key=lambda n:(n.version,int(n.network_address),n.prefixlen)) or (both and {n.version for n in networks}!={4,6}):raise SnapshotError('ledger_ranges')
    return tuple(map(str,networks))


def _ledger_inventory_data(inventory,blobs):
    return {'manifest':[dict(row) for row in inventory.manifest], 'contents':{path:blobs.put(raw) for path,raw in inventory.contents.items()}}


def _ledger_decode_inventory(value,raws,owner):
    if type(value) is not dict or set(value)!={'manifest','contents'} or type(value['contents']) is not dict:raise SnapshotError('ledger_inventory_schema')
    decoded={'manifest':value['manifest'],'contents':{path:base64.b64encode(_ledger_ref(raws,ref)).decode() for path,ref in value['contents'].items()}}
    return _inventory(decoded,owner)


def _ledger_ref(raws,digest):
    if not _hex(digest) or digest not in raws:raise SnapshotError('ledger_missing_reference')
    return raws[digest]


def _ledger_capture(value,blobs):
    if type(value) is not observation.Observation:raise SnapshotError('ledger_observation_required')
    return {'os_id':value.os_id,'ufw_version':value.ufw_version,'versions':[list(row) for row in value.versions],
            'source_hashes':[list(row) for row in value.source_hashes], 'inventory':_ledger_inventory_data(value.inventory,blobs),
            'selected':[blobs.put(view.canonical) for view in value.selected],'native':blobs.put(value.native.canonical),
            'legacy':[blobs.put(raw) for raw in value.legacy],
            'commands':[{'argv':list(argv),'stdout':blobs.put(raw)} for argv,raw in value.commands],
            'os_release':blobs.put(value.metadata[0]),'ufw_sources':{name:blobs.put(raw) for name,raw in value.metadata[1]}}


def _ledger_decode_capture(value,raws,owner):
    fields={'os_id','ufw_version','versions','source_hashes','inventory','selected','native','legacy','commands','os_release','ufw_sources'}
    if type(value) is not dict or set(value)!=fields or value['os_id'] not in observation.UFW_VERSIONS:raise SnapshotError('ledger_capture_schema')
    if type(value['selected']) is not list or len(value['selected'])!=2 or type(value['legacy']) is not list or len(value['legacy'])!=2:raise SnapshotError('ledger_capture_families')
    commands=[]
    for row in value['commands']:
        if type(row) is not dict or set(row)!={'argv','stdout'} or type(row['argv']) is not list or any(type(part) is not str for part in row['argv']):raise SnapshotError('ledger_capture_command')
        commands.append((tuple(row['argv']),_ledger_ref(raws,row['stdout'])))
    if type(value['ufw_sources']) is not dict or set(value['ufw_sources'])!={'backend_iptables.py','common.py'}:raise SnapshotError('ledger_capture_sources')
    return observation.Observation(value['os_id'],value['ufw_version'],tuple(tuple(row) for row in value['versions']),tuple(tuple(row) for row in value['source_hashes']),
        _ledger_decode_inventory(value['inventory'],raws,owner),tuple(_ledger_kernel.KernelSave.parse(_ledger_ref(raws,ref)) for ref in value['selected']),
        _ledger_kernel.NativeRuleset.parse(_ledger_ref(raws,value['native']),profile=_ledger_mapping.BACKEND_PROFILES[value['os_id']]['native']),
        tuple(_ledger_ref(raws,ref) for ref in value['legacy']),tuple(commands),
        (_ledger_ref(raws,value['os_release']),tuple((name,_ledger_ref(raws,value['ufw_sources'][name])) for name in ('backend_iptables.py','common.py'))))


def _ledger_basic_p(raw,config,owner):
    value=_json(raw)
    fields={'integrity_format','backend','config_hash','enrollment_id','profile_id','inventory','owned_rules','protected_context'}
    if set(value)!=fields or value['integrity_format']!=FORMAT or value['backend']!=config['firewall']['backend'] or value['config_hash']!=config_hash(config) or not _hex(value['enrollment_id'],32):raise SnapshotError('ledger_p_context')
    context=value['protected_context'];profile=value['profile_id']
    if value['backend']=='none':
        if profile!='none' or value['inventory'] is not None or type(value['owned_rules']) is not list or value['owned_rules'] or context is not None:raise SnapshotError('ledger_none_p')
        return value,None,()
    if type(context) is not dict or context.get('kind') not in ('stock','docker_candidate'):raise SnapshotError('ledger_protected_context')
    if context['kind']=='stock':
        basic={key:part for key,part in value.items() if key!='protected_context'}
        checked=parse_p(_canonical(basic),owner=owner);inventory=checked.inventory;owned=checked.owned_rules
        fields={'kind','host_addresses','ssh_ports','admin_networks','cf_ports'}
        if set(context)!=fields:raise SnapshotError('ledger_stock_context')
        _ledger_stock_context(context,config)
    else:
        if profile!='docker29-no-publish-26-candidate-v1' or set(context)!={'kind','domain','paths'}:raise SnapshotError('ledger_docker_profile')
        inventory=_inventory(value['inventory'],owner)
        owned=_ledger_owned(value['owned_rules'],inventory)
        _ledger_docker_paths(context,config)
    expected_ports=set(config['firewall']['ports']);sources={source for source,port,comment in owned}
    # Count first; never materialize a source x ports product merely to prove
    # an impossible existing Cartesian mapping. Unique owned keys are bounded.
    if len(sources)*len(expected_ports)!=len(owned) or any(port not in expected_ports for source,port,comment in owned):raise SnapshotError('ledger_owned_not_cartesian')
    return value,inventory,owned


def _ledger_owned(rows,inventory):
    if type(rows) is not list or len(rows)>4096:raise SnapshotError('ledger_owned_mapping')
    documents={family:UserRulesDocument.parse(inventory.contents['/etc/ufw/'+leaf],UserFileProfile(family)) for family,leaf in ((4,'user.rules'),(6,'user6.rules'))}
    result=[]
    for row in rows:
        if type(row) is not dict or set(row)!={'source','port','comment'} or type(row['source']) is not str or type(row['port']) is not int or type(row['comment']) is not str:raise SnapshotError('ledger_owned_mapping')
        net=ipaddress.ip_network(row['source'],strict=True)
        if str(net)!=row['source'] or len(row['comment'].encode())>1024:raise SnapshotError('ledger_owned_mapping')
        rule=ManagedTuple(row['source'],row['port'],row['comment'])
        if documents[net.version].blocks.count(rule.block(documents[net.version].profile))!=1:raise SnapshotError('ledger_owned_not_raw')
        result.append((rule.source,rule.port,rule.comment))
    if len({(s,p) for s,p,c in result})!=len(result):raise SnapshotError('ledger_owned_duplicate')
    return tuple(result)


def _ledger_stock_context(context,config):
    ports=context['cf_ports'];ssh=context['ssh_ports'];addresses=context['host_addresses']
    if (type(ports) is not list or ports!=sorted(config['firewall']['ports']) or type(ssh) is not list or not ssh or ssh!=sorted(set(ssh))
            or any(type(port) is not int or not 1<=port<=65535 for port in (*ports,*ssh)) or set(ports)&set(ssh)):raise SnapshotError('ledger_protected_ports')
    if type(addresses) is not list or not addresses or len(addresses)>256 or len(set(addresses))!=len(addresses) or any(type(a) is not str or str(ipaddress.ip_address(a))!=a for a in addresses) or config['host_address'] not in addresses:raise SnapshotError('ledger_host_context')
    _ledger_networks(context['admin_networks'])


def _ledger_docker_paths(context,config):
    domain=context['domain'];paths=context['paths']
    if type(domain) is not dict or set(domain)!={'pools','host_networks','admin_networks'} or type(paths) is not dict or set(paths)!={'cf_sources','cf_ports','ssh_ports','host_addresses','admin_routes'}:raise SnapshotError('ledger_docker_context')
    approved=_ledger_docker.validate_allocation_domain(tuple(domain['pools']),tuple(domain['host_networks']),tuple(domain['admin_networks']))
    checked=_ledger_docker.validate_protected_paths(approved,**{name:tuple(value) for name,value in paths.items()})
    if tuple(sorted(config['firewall']['ports']))!=checked.cf_ports or config['host_address'] not in checked.host_addresses:raise SnapshotError('ledger_docker_host_ports')
    return checked


def _ledger_context(context,p,config,blobs):
    if p['backend']=='none':
        if context is not None:raise SnapshotError('ledger_none_context')
        return None,None
    if type(context) is not dict or set(context)!={'projection_profile','membership','raw_views','canonical_views'} or context['projection_profile']!='supplied-pure-data-v1':raise SnapshotError('ledger_context_profile')
    member=context['membership'];views=context['raw_views'];canonical_views=context['canonical_views']
    if type(member) is not dict or set(member)!={'bridges','host_local_addresses','admin_peers'} or type(views) is not dict or not set(views)<=set(_CONTEXT_VIEWS) or type(canonical_views) is not dict or set(canonical_views)!=set(views):raise SnapshotError('ledger_context_schema')
    persistent=p['protected_context']
    if persistent['kind']=='stock':
        if member['bridges']!=[] or type(member['host_local_addresses']) is not list or sorted(member['host_local_addresses'])!=sorted(persistent['host_addresses']) or type(member['admin_peers']) is not list:raise SnapshotError('ledger_stock_membership')
        networks=[ipaddress.ip_network(value) for value in persistent['admin_networks']]
        for address in member['admin_peers']:
            if type(address) is not str or str(ipaddress.ip_address(address))!=address or not any(ipaddress.ip_address(address).version==net.version and ipaddress.ip_address(address) in net for net in networks):raise SnapshotError('ledger_admin_peer')
        checked=None
    else:
        paths=_ledger_docker_paths(persistent,config)
        if type(member['bridges']) is not list or type(member['host_local_addresses']) is not list or type(member['admin_peers']) is not list:raise SnapshotError('ledger_docker_membership')
        checked=_ledger_docker.validate_membership(paths,tuple(member['bridges']),tuple(member['host_local_addresses']),tuple(member['admin_peers']))
    # Raw views are retained independently. No volatile/timer/float stripping
    # is implemented, and supplied typed membership is not a host measurement.
    recorded={'projection_profile':context['projection_profile'],'membership':json.loads(_canonical(member)),
              'raw_views':{name:blobs.put(raw) for name,raw in views.items()},
              'canonical_views':{name:blobs.put(raw) for name,raw in canonical_views.items()}}
    identity=hashlib.sha256(_canonical({'persistent':persistent,'projection_profile':context['projection_profile'],'membership':member,'canonical_views':recorded['canonical_views']})).hexdigest()
    return recorded,(identity,checked)


def _ledger_docker_capture(before,blobs):
    before=_ledger_docker._verified_no_publish(before)
    representation=before.representation
    return {'inventory':_ledger_inventory_data(before.inventory,blobs),
            'selected':[blobs.put(view.canonical) for view in representation.selected],
            'native':blobs.put(representation.native.canonical),'versions':[list(row) for row in representation.versions],
            'legacy':[blobs.put(raw) for raw in before.legacy],'docker_package':before.docker_package}


def _ledger_decode_docker(value,raws,p,config,context,owner):
    if type(value) is not dict or set(value)!={'inventory','selected','native','versions','legacy','docker_package'} or type(value['selected']) is not list or len(value['selected'])!=2 or type(value['legacy']) is not list or len(value['legacy'])!=2:raise SnapshotError('ledger_docker_capture')
    representation=_ledger_docker.validate_representation(selected=tuple(_ledger_kernel.KernelSave.parse(_ledger_ref(raws,ref)) for ref in value['selected']),
        native=_ledger_kernel.NativeRuleset.parse(_ledger_ref(raws,value['native']),profile='nftables-1.1.6-schema1'),versions=dict(value['versions']))
    paths=_ledger_docker_paths(p['protected_context'],config);member=context['membership']
    membership=_ledger_docker.validate_membership(paths,tuple(member['bridges']),tuple(member['host_local_addresses']),tuple(member['admin_peers']))
    inventory=_ledger_decode_inventory(value['inventory'],raws,owner)
    protected=_inventory(p['inventory'],owner)
    return _ledger_docker.validate_no_publish(representation=representation,membership=membership,protected_inventory=protected,inventory=inventory,
        owned_rules=tuple(ManagedTuple(row['source'],row['port'],row['comment']) for row in p['owned_rules']),
        legacy=tuple(_ledger_ref(raws,ref) for ref in value['legacy']),docker_package=value['docker_package'])


def _ledger_generation(inventory,selected,native,legacy,profile,context_id,blobs):
    if inventory is None:
        value={'kind':'not_applicable','profile_id':'none','context_id':None}
    else:
        value={'kind':'combined','inventory':_ledger_inventory_data(inventory,blobs),
               'selected4':blobs.put(selected[0].canonical),'selected6':blobs.put(selected[1].canonical),'native':blobs.put(native.canonical),
               'legacy4':blobs.put(legacy[0]),'legacy6':blobs.put(legacy[1]),'profile_id':profile,'context_id':context_id}
    return {'id':hashlib.sha256(_canonical(value)).hexdigest(),**value}


def _ledger_apply_inventory(inventory,proof):
    contents=dict(inventory.contents)
    for name,raw in proof.raw_files:
        path='/etc/ufw/'+name
        if name not in ('user.rules','user6.rules') and contents[path]!=raw:raise SnapshotError('ledger_nonuser_change')
        contents[path]=raw
    rows=[]
    for old in inventory.manifest:
        row=dict(old)
        if row['kind']=='file':row.update(size=len(contents[row['path']]),sha256=hashlib.sha256(contents[row['path']]).hexdigest())
        rows.append(row)
    return UfwInventory(tuple(rows),contents)


def _ledger_state(raw,p,owned):
    if raw is None:return None
    value=_json(raw)
    fields={'version','integrity_format','generation_id','config_hash','enrollment_id','baseline','ranges','aws_sync_token','last_success'}
    if set(value)!=fields or type(value['version']) is not int or value['version']!=2 or value['integrity_format']!=FORMAT or not _hex(value['generation_id']):raise SnapshotError('ledger_legacy_state_manual')
    if _canonical(value['baseline'])!=_canonical(p) or value['config_hash']!=p['config_hash'] or value['enrollment_id']!=p['enrollment_id']:raise SnapshotError('ledger_state_p_differs')
    ranges=_ledger_networks(value['ranges'],both=True)
    if p['backend']=='ufw' and set(ranges)!={source for source,port,comment in owned}:raise SnapshotError('ledger_ranges_owned_differs')
    if type(value['aws_sync_token']) is not str or re.fullmatch('[0-9]{1,20}',value['aws_sync_token']) is None or (value['last_success'] is not None and (type(value['last_success']) is not int or not 0<=value['last_success']<2**63)):raise SnapshotError('ledger_state_metadata')
    return value


def _ledger_ufw_policy(inventory,owned,prospective,ports):
    owned_set=set(owned)
    targets=[ipaddress.ip_network(source) for source in prospective]
    for family,leaf in ((4,'user.rules'),(6,'user6.rules')):
        profile=UserFileProfile(family);document=UserRulesDocument.parse(inventory.contents['/etc/ufw/'+leaf],profile)
        owned_blocks=[ManagedTuple(source,port,comment).block(profile) for source,port,comment in owned_set if ipaddress.ip_network(source).version==family]
        for block in document.blocks:
            if block in owned_blocks:continue
            fields=block.fields
            if fields[-1]!='in' or fields[1] not in ('tcp','any'):continue
            token=fields[2]
            if token.isdigit():overlap=int(token) in ports
            elif token=='any':overlap=True
            else:
                try:
                    values=[]
                    for part in token.split(','):
                        if ':' in part:
                            first,last=map(int,part.split(':'))
                            if not 1<=first<=last<=65535:raise ValueError()
                            values.extend(range(first,last+1))
                        else:values.append(int(part))
                    overlap=bool(set(values)&set(ports))
                except Exception:raise SnapshotError('ledger_unreviewed_port_match') from None
            if not overlap:continue
            source=fields[5]
            network=ipaddress.ip_network('0.0.0.0/0' if family==4 else '::/0') if source=='any' else ipaddress.ip_network(source,strict=False)
            if any(target.version==family and network.overlaps(target) for target in targets):raise SnapshotError('ledger_unowned_shadow_or_collision')


def _ledger_intents(owned,ranges,ports):
    _ledger_delta_counts(owned,ranges,ports)
    old={(source,port):comment for source,port,comment in owned}
    target=[(source,port,old.get((source,port),'cloudfront-sync')) for source in ranges for port in ports]
    target_keys={(source,port) for source,port,comment in target}
    additions=[_ledger_transition.OwnedIntent('add',source,port,comment) for source,port,comment in target if (source,port) not in old]
    deletions=[_ledger_transition.OwnedIntent('delete',source,port,comment) for source,port,comment in owned if (source,port) not in target_keys]
    # Preserve retained ownership metadata order/comments; append only new keys.
    final=[row for row in owned if row[:2] in target_keys]+[(i.source,i.port,i.comment) for i in additions]
    return tuple(additions+deletions),tuple(final)


def _ledger_delta_counts(owned,ranges,ports):
    # The same4096 future-owned/step bounds already exist in the P/D2 schema.
    # Apply them BEFORE allocating target Cartesian tuples or intent lists.
    future=len(ranges)*len(ports)
    if future>4096 or len(owned)>4096:raise SnapshotError('ledger_owned_cardinality_budget')
    sources=set(ranges);port_set=set(ports)
    retained=sum(source in sources and port in port_set for source,port,comment in owned)
    if future+len(owned)-2*retained>4096:raise SnapshotError('ledger_step_count')


def _ledger_writer_spec(intent):
    # A raw tuple ordinal is deliberately not presented as a calibrated CLI
    # number. B2 must supply/verify the actual vendor writer adapter.
    return {'adapter':'unverified-owned-tuple-v1','operation':intent.operation,'source':intent.source,'port':intent.port,
            'comment':intent.comment,'raw_tuple_ordinal':intent.index,'family':ipaddress.ip_network(intent.source).version}


class NginxLedgerInput(dict):
    """nginx_ledger_input's result: a dict (the ledger's nginx input) that
    compile_ledger accepts only as the very instance nginx_ledger_input
    returned, with its contents unchanged (see _NGINX_LEDGER_ISSUED)."""
    __slots__=('__weakref__',)


# id(NginxLedgerInput) -> (weak reference to it, (shared_dir, bundles) of the
# observation or None for not_applicable, its contents as returned). An entry
# leaves when its input is released. Same threat model as nginx_observation's
# registries: accidental misuse (a hand-made, copied or changed input) is
# detected; deliberate tampering with private names is out of scope.
_NGINX_LEDGER_ISSUED={}


def _nginx_ledger_snapshot(data):
    return (data['observation_code'],tuple(data['before_shared'].items()),tuple(data['before_bundles'].items()))


def _issue_nginx_ledger_input(data,origin):
    value=NginxLedgerInput(data);key=id(value)
    def released(_,key=key):_NGINX_LEDGER_ISSUED.pop(key,None)
    _NGINX_LEDGER_ISSUED[key]=(weakref.ref(value,released),origin,_nginx_ledger_snapshot(value))
    return value


@dataclass(frozen=True)
class _NginxLedgerOrigin:
    """Where a ledger nginx input came from: issued by nginx_ledger_input (with
    the observation's shared_dir and bundles, None for not_applicable) or
    rebuilt from a ledger whose digests were already verified."""
    issued: bool
    observed: object = None


_NGINX_LEDGER_REBUILT=_NginxLedgerOrigin(False)


def _nginx_ledger_origin(data):
    """(plain copy of data, its origin) for an input nginx_ledger_input
    returned and nothing changed since, else ledger_nginx_not_issued."""
    entry=_NGINX_LEDGER_ISSUED.get(id(data)) if type(data) is NginxLedgerInput else None
    try:same=entry is not None and entry[0]() is data and set(data)=={'observation_code','before_shared','before_bundles'} and _nginx_ledger_snapshot(data)==entry[2]
    except Exception:same=False
    if not same:raise SnapshotError('ledger_nginx_not_issued')
    plain={'observation_code':data['observation_code'],'before_shared':dict(data['before_shared']),'before_bundles':dict(data['before_bundles'])}
    return plain,_NginxLedgerOrigin(True,entry[1])


def nginx_ledger_input(component):
    """The one producer of the ledger's nginx input: NotApplicable('nginx') ->
    not_applicable; an admitted nginx component (admit_snapshot's
    nginx_policy_verified, its observation admitted again here, so one that
    Collector.collect() returned) -> the observed shared and bundle bytes.
    Anything else is ledger_nginx_not_admitted. The result is a
    NginxLedgerInput that compile_ledger accepts only as returned."""
    if type(component) is NotApplicable and component==NotApplicable('nginx'):
        return _issue_nginx_ledger_input({'observation_code':'not_applicable','before_shared':{},'before_bundles':{}},None)
    if (type(component) is not ComponentResult or component.status!='admitted' or component.code!='nginx_policy_verified'
            or type(component.evidence) is not nginx_observation.NginxObservation):raise SnapshotError('ledger_nginx_not_admitted')
    evidence=component.evidence
    try:nginx_observation.admit_policy(evidence)
    except Exception:evidence=None
    if evidence is None:raise SnapshotError('ledger_nginx_not_admitted')
    managed=dict(evidence.managed);shared=evidence.shared_dir+'/'
    return _issue_nginx_ledger_input({'observation_code':'nginx_observed',
            'before_shared':{name:managed[shared+name] for name in (nginx_observation.GEO_NAME,nginx_observation.REALIP_NAME)},
            'before_bundles':{path:managed[path] for bundle in evidence.bundles for path in bundle}},(evidence.shared_dir,evidence.bundles))


def _ledger_nginx(data,config,ranges,blobs,origin):
    """The ledger's nginx part. compile_ledger passes the origin of an issued
    input; validate_ledger's reconstruction passes _NGINX_LEDGER_REBUILT
    (data from the ledger's own digests). On both paths before_shared must
    parse as the two shared include files (nginx_observation.parse_shared:
    their format and the same ranges in both), else
    ledger_nginx_shared_invalid. The before_bundles bytes of a rebuilt ledger
    cannot be checked again: the dump they were bound to is not kept, so only
    their paths (the configured bundles) are compared."""
    if type(origin) is not _NginxLedgerOrigin or (not origin.issued and origin is not _NGINX_LEDGER_REBUILT):raise SnapshotError('ledger_nginx_not_issued')
    if type(data) is not dict or set(data)!={'observation_code','before_shared','before_bundles'}:raise SnapshotError('ledger_nginx_schema')
    enabled=config['nginx']['enabled']
    if not enabled:
        if data!={'observation_code':'not_applicable','before_shared':{},'before_bundles':{}}:raise SnapshotError('ledger_nginx_none')
        return {'enabled':False,'observation_code':'not_applicable','before_shared':{},'before_bundles':{},'target_shared':{}}
    # Only nginx_observed (an admitted observation via nginx_ledger_input) is ledger evidence.
    if type(data['observation_code']) is not str or data['observation_code']!='nginx_observed' or type(data['before_shared']) is not dict or set(data['before_shared'])!={'cloudfront-geo.conf','cloudfront-realip.conf'}:raise SnapshotError('ledger_nginx_evidence')
    shared=None
    try:shared=nginx_observation.parse_shared(data['before_shared'][nginx_observation.GEO_NAME],data['before_shared'][nginx_observation.REALIP_NAME])
    except Exception:shared=None
    if shared is None:raise SnapshotError('ledger_nginx_shared_invalid')
    # The shared bytes are those of the configured shared_dir: the observation's must be it.
    if origin.issued and (type(origin.observed) is not tuple or origin.observed[0]!=config['nginx']['shared_dir']):raise SnapshotError('ledger_nginx_shared_dir')
    expected={path for bundle in config['nginx']['bundles'] for path in bundle.values()}
    if type(data['before_bundles']) is not dict or set(data['before_bundles'])!=expected:raise SnapshotError('ledger_nginx_bundle_evidence')
    if origin.issued and origin.observed[1]!=tuple((bundle['geo_file'],bundle['realip_file']) for bundle in config['nginx']['bundles']):raise SnapshotError('ledger_nginx_bundle_evidence')
    target={'cloudfront-geo.conf':''.join(source+' 1;\n' for source in ranges).encode(),
            'cloudfront-realip.conf':''.join('set_real_ip_from '+source+';\n' for source in ranges).encode()}
    return {'enabled':True,'observation_code':data['observation_code'],
            'before_shared':{name:blobs.put(raw) for name,raw in data['before_shared'].items()},
            'before_bundles':{name:blobs.put(raw) for name,raw in data['before_bundles'].items()},
            'target_shared':{name:blobs.put(raw) for name,raw in target.items()}}


def _ledger_copy(value,depth=0):
    if depth>32:raise SnapshotError('ledger_input_depth')
    if value is None or type(value) in (bytes,str,int,bool,float):return value
    if type(value) is list:return [_ledger_copy(v,depth+1) for v in value]
    if type(value) is dict:
        if any(type(key) is not str for key in value):raise SnapshotError('ledger_input_key')
        return {key:_ledger_copy(v,depth+1) for key,v in value.items()}
    raise SnapshotError('ledger_input_type')


def _ledger_companions(values,before_state):
    if type(values) is not dict or not set(values)<=set(_COMPANIONS):raise SnapshotError('ledger_companion_slots')
    copied={name:values.get(name) for name in _COMPANIONS}
    if any(raw is not None and (type(raw) is not bytes or len(raw)>WHOLE_LIMIT) for raw in copied.values()):raise SnapshotError('ledger_companion_bytes')
    if copied['old_state'] is not None and copied['old_state']!=before_state:raise SnapshotError('ledger_old_state_companion')
    copied['old_state']=before_state
    index={name:None if raw is None else {'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in copied.items()}
    return copied,index


def _ledger_core(*,config_bytes,before_state_bytes,baseline_bytes,before,protected_context,target,nginx,nginx_origin,code_generation,created_at,companions,owner=0,approval_digest=None):
    if type(config_bytes) is not bytes or type(baseline_bytes) is not bytes or (before_state_bytes is not None and type(before_state_bytes) is not bytes) or not _hex(code_generation) or type(created_at) is not int or not 0<=created_at<2**63 or type(owner) is not int or not 0<=owner<2**32-1:raise SnapshotError('ledger_input_identity')
    target=_ledger_copy(target);protected_context=_ledger_copy(protected_context);nginx=_ledger_copy(nginx);companions=_ledger_copy(companions)
    config=_ledger_config(config_bytes);p,inventory,owned=_ledger_basic_p(baseline_bytes,config,owner)
    previous=_ledger_state(before_state_bytes,p,owned)
    target=_ledger_copy(target);context=_ledger_copy(protected_context);nginx=_ledger_copy(nginx)
    if type(target) is not dict or set(target)!={'ranges','aws_sync_token'} or type(target['aws_sync_token']) is not str or re.fullmatch('[0-9]{1,20}',target['aws_sync_token']) is None:raise SnapshotError('ledger_target_schema')
    ranges=_ledger_networks(target['ranges'],both=True)
    if previous and int(target['aws_sync_token'])<int(previous['aws_sync_token']):raise SnapshotError('ledger_stale_publication')
    if previous and created_at<(previous['last_success'] or 0):raise SnapshotError('ledger_time_reversal')
    blobs=_LedgerBlobs();context_wire,typed_context=_ledger_context(context,p,config,blobs)
    context_id=typed_context[0] if typed_context else None
    mode='none' if p['backend']=='none' else p['protected_context']['kind']
    profile=p['profile_id'];generations=[];steps=[];inventories=[]
    if mode!='none':_ledger_delta_counts(owned,ranges,config['firewall']['ports'])
    intents,final_owned=_ledger_intents(owned,ranges,config['firewall']['ports']) if mode!='none' else ((),())
    if len(intents)>4096:raise SnapshotError('ledger_step_count')
    if mode=='none':
        if before is not None:raise SnapshotError('ledger_none_observation')
        capture=None;generation=_ledger_generation(None,None,None,None,'none',None,blobs);generations=[generation];final_inventory=None
    elif mode=='stock':
        proof=observation.admit_stock(before,owner=owner)
        context_id=_ledger_profile_context(context_id,_ledger_stock_profile(before))
        if profile!='stock-ubuntu-'+before.os_id or before.inventory!=inventory:raise SnapshotError('ledger_observed_p_differs')
        _ledger_ufw_policy(inventory,owned,tuple(set(ranges)|{r[0] for r in owned}),config['firewall']['ports'])
        capture=_ledger_capture(before,blobs);envelope=proof.correspondence.structure.envelope
        generations.append(_ledger_generation(inventory,envelope.selected,envelope.native,envelope.legacy,profile,context_id,blobs));inventories=[inventory]
        for ordinal,intent in enumerate(intents):
            family=ipaddress.ip_network(intent.source).version;leaf='user.rules' if family==4 else 'user6.rules'
            document=UserRulesDocument.parse(inventory.contents['/etc/ufw/'+leaf],UserFileProfile(family))
            inverse=_ledger_transition.OwnedIntent('delete',intent.source,intent.port,intent.comment) if intent.operation=='add' else _ledger_transition.OwnedIntent('add',intent.source,intent.port,intent.comment,index=document.blocks.index(intent.rule.block(document.profile)))
            after=_ledger_mapping.predict_transition(proof,intent.operation,intent.rule,index=intent.index)
            restored=_ledger_mapping.predict_transition(after,inverse.operation,inverse.rule,index=inverse.index)
            if restored!=proof:raise SnapshotError('ledger_inverse_not_exact')
            inventory=_ledger_apply_inventory(inventory,after);envelope=after.correspondence.structure.envelope
            generations.append(_ledger_generation(inventory,envelope.selected,envelope.native,envelope.legacy,profile,context_id,blobs));inventories.append(inventory)
            steps.append(_ledger_step(ordinal,intent,inverse,generations[-2]['id'],generations[-1]['id']))
            proof=after
        final_inventory=inventory
    else:
        before=_ledger_docker._verified_no_publish(before)
        context_id=_ledger_profile_context(context_id,_ledger_docker_profile(before))
        if before.inventory!=inventory or before.membership!=typed_context[1] or tuple(before.owned_rules)!=tuple(sorted(owned)):raise SnapshotError('ledger_docker_p_differs')
        _ledger_ufw_policy(inventory,owned,tuple(set(ranges)|{r[0] for r in owned}),config['firewall']['ports'])
        capture=_ledger_docker_capture(before,blobs)
        transaction=_ledger_transition.compile_transaction(before,approved_final_sources=tuple(ranges),ordered_intents=intents)
        sequence=[before]+list(transaction.generations)
        inventories=[item.inventory for item in sequence]
        for item in sequence:generations.append(_ledger_generation(item.inventory,item.representation.selected,item.representation.native,before.legacy,profile,context_id,blobs))
        for ordinal,intent in enumerate(intents):
            inverse=transaction.inverse_intents[len(intents)-ordinal-1]
            steps.append(_ledger_step(ordinal,intent,inverse,generations[ordinal]['id'],generations[ordinal+1]['id']))
        # compile_transaction has just constructed and validated every full
        # forward/inverse generation and residual. Do not recompile the whole
        # N-step plan N times by comparing its own predictions as observations.
        # Independent current evidence is checked separately by the classifier.
        final_inventory=inventories[-1]
    p_next=json.loads(_canonical(p))
    if final_inventory is not None:
        p_next['inventory']={'manifest':[dict(row) for row in final_inventory.manifest],
                             'contents':{path:base64.b64encode(raw).decode() for path,raw in final_inventory.contents.items()}}
        p_next['owned_rules']=[{'source':source,'port':port,'comment':comment} for source,port,comment in final_owned]
        if mode=='docker_candidate':p_next['protected_context']['paths']['cf_sources']=list(ranges)
    expected_state={'version':2,'integrity_format':FORMAT,'generation_id':code_generation,'config_hash':p['config_hash'],'enrollment_id':p['enrollment_id'],
                    'baseline':p_next,'ranges':list(ranges),'aws_sync_token':target['aws_sync_token'],'last_success':created_at}
    # Revalidate new complete P and state semantics before storing an expectation.
    _,_,next_owned=_ledger_basic_p(_canonical(p_next),config,owner)
    _ledger_state(_canonical(expected_state),p_next,next_owned)
    nginx_wire=_ledger_nginx(nginx,config,ranges,blobs,nginx_origin)
    captured_companions,companion_index=_ledger_companions(companions,before_state_bytes)
    old_ranges=set(previous['ranges']) if previous else set()
    delta=len(old_ranges.symmetric_difference(ranges))
    ratio=len(ranges)/len(old_ranges) if old_ranges else None
    approval_policy='automatic_candidate' if (previous is not None and delta<=config['limits']['max_changes'] and config['limits']['min_ratio']<=ratio<=1/config['limits']['min_ratio']) else 'operator_required'
    approval_inputs={'generation_id':code_generation,'config_hash':p['config_hash'],'enrollment_id':p['enrollment_id'],'P_before_sha256':hashlib.sha256(_canonical(p)).hexdigest(),
                     'T_before_id':generations[0]['id'],'before_state_sha256':None if previous is None else hashlib.sha256(before_state_bytes).hexdigest(),
                     'target':target,'created_at':created_at,'operation':'aws_delta','approval_policy':approval_policy,'nginx_sha256':hashlib.sha256(_canonical(nginx_wire)).hexdigest()}
    expected_approval=hashlib.sha256(_canonical(approval_inputs)).hexdigest()
    if approval_digest is not None and approval_digest!=expected_approval:raise SnapshotError('ledger_approval_binding')
    inputs={'operation':'aws_delta','created_at':created_at,'config':blobs.put(_canonical(config)),'before_state':None if before_state_bytes is None else blobs.put(before_state_bytes),
            'P_before':blobs.put(_canonical(p)),'T_before':capture,'protected_context':context_wire,'target':target,'approval_policy':approval_policy,'approval_digest':expected_approval,'companions':companion_index}
    core={'version':2,'journal_format':FORMAT,'generation_id':code_generation,'kind':mode,'inputs':inputs,'generations':generations,'steps':steps,
          'nginx':nginx_wire,'expected_state':blobs.put(_canonical(expected_state)+b'\n'),'blobs':blobs.encoded()}
    core['transaction_id']=hashlib.sha256(_canonical(core)).hexdigest()
    return core,captured_companions


def _ledger_step(ordinal,intent,inverse,before_id,after_id):
    return {'ordinal':ordinal,'intent':{'operation':intent.operation,'source':intent.source,'port':intent.port,'comment':intent.comment,'index':intent.index},
            'before_id':before_id,'after_id':after_id,'writer_spec':_ledger_writer_spec(intent),
            'inverse_intent':{'operation':inverse.operation,'source':inverse.source,'port':inverse.port,'comment':inverse.comment,'index':inverse.index},
            'inverse_before_id':after_id,'inverse_after_id':before_id,'inverse_writer_spec':_ledger_writer_spec(inverse),
            'changed_user_paths':['/etc/ufw/user.rules' if ipaddress.ip_network(intent.source).version==4 else '/etc/ufw/user6.rules']}


def _ledger_progress(core,phase,frontier):
    count=len(core['steps'])
    if type(phase) is not str or phase not in _PHASES or type(frontier) is not int or not 0<=frontier<=count:raise SnapshotError('ledger_progress')
    if (phase in ('prepared','nginx_armed','nginx_verified','nginx_rollback_armed','nginx_rollback_verified') and frontier!=0) or (phase=='forward_armed' and frontier>=count) or (phase=='forward_verified' and frontier==0) or (phase=='rollback_armed' and frontier==0) or (phase in ('state_prepared','state_committed') and frontier!=count):raise SnapshotError('ledger_progress_frontier')
    attempted=frontier if phase=='forward_armed' else frontier-1 if phase=='rollback_armed' else None
    return {'ledger_id':core['transaction_id'],'phase':phase,'frontier':frontier,'attempted_step':attempted}


def _ledger_wire(core,progress):
    return b'{"ledger":'+_canonical(core)+b',"progress":'+_canonical(progress)+b'}\n'


def _ledger_sizes(core,companions):
    body_size=len(_canonical(core));count=len(core['steps']);largest=0
    for phase in _PHASES:
        for frontier in range(count+1):
            try:progress=_ledger_progress(core,phase,frontier)
            except SnapshotError:continue
            largest=max(largest,len(b'{"ledger":')+body_size+len(b',"progress":')+len(_canonical(progress))+len(b'}\n'))
    if largest>JOURNAL_LIMIT:raise SnapshotError('ledger_journal_budget')
    old_state=companions['old_state'] or b''
    new_ref=core['expected_state'];new_state=base64.b64decode(core['blobs'][new_ref]['data'],validate=True)
    extras=sum(len(raw) for name,raw in companions.items() if name not in ('backup','old_state') and raw is not None)
    old_backup=companions['backup'] or b''
    prepared=len(_ledger_wire(core,_ledger_progress(core,'prepared',0)))
    # All physical copies count: active+atomic replacement journal and retained
    # new backup; or old+new state during its atomic replacement. Existing backup
    # coexists with its newly staged backup before rename.
    changed=bool(core['steps']) or core['nginx']['before_shared']!=core['nginx']['target_shared']
    retained=prepared if changed else len(old_backup)
    peaks=(2*largest+retained+max(len(old_state),len(new_state))+extras,
           largest+retained+len(old_state)+len(new_state)+extras,
           len(old_backup)+prepared+len(old_state)+extras if changed else largest+retained+len(old_state)+extras)
    whole=max(peaks)
    if whole>WHOLE_LIMIT:raise SnapshotError('ledger_whole_budget')
    return largest,whole


def compile_ledger(*,config_bytes,before_state_bytes,baseline_bytes,before,protected_context,target,nginx,code_generation,created_at,companions,owner=0,approval_digest=None):
    try:
        # Only an input nginx_ledger_input returned, unchanged (checked before any other work).
        nginx,origin=_nginx_ledger_origin(nginx)
        core,captured=_ledger_core(config_bytes=config_bytes,before_state_bytes=before_state_bytes,baseline_bytes=baseline_bytes,before=before,
            protected_context=protected_context,target=target,nginx=nginx,nginx_origin=origin,code_generation=code_generation,created_at=created_at,companions=companions,owner=owner,approval_digest=approval_digest)
        journal_peak,whole_peak=_ledger_sizes(core,captured)
        return ValidatedLedgerData(_ledger_wire(core,_ledger_progress(core,'prepared',0)),core['transaction_id'],journal_peak,whole_peak)
    except SnapshotError:raise
    except Exception:raise SnapshotError('ledger_semantic_inputs_invalid') from None


def _ledger_raws(data):
    if type(data) is not dict or not 1<=len(data)<=16384:raise SnapshotError('ledger_blob_table')
    raws={};total=0
    for digest,row in data.items():
        if not _hex(digest) or type(row) is not dict or set(row)!={'size','data'} or type(row['size']) is not int or not 0<=row['size']<=8*1024*1024 or type(row['data']) is not str or len(row['data'])>4*((row['size']+2)//3):raise SnapshotError('ledger_blob_schema')
        try:raw=base64.b64decode(row['data'],validate=True)
        except Exception:raise SnapshotError('ledger_blob_encoding') from None
        if len(raw)!=row['size'] or base64.b64encode(raw).decode()!=row['data'] or hashlib.sha256(raw).hexdigest()!=digest:raise SnapshotError('ledger_blob_hash')
        total+=len(raw)
        if total>WHOLE_LIMIT:raise SnapshotError('ledger_blob_aggregate_budget')
        raws[digest]=raw
    return raws


def _ledger_context_decode(value,raws):
    if value is None:return None
    if type(value) is not dict or set(value)!={'projection_profile','membership','raw_views','canonical_views'} or type(value['raw_views']) is not dict or type(value['canonical_views']) is not dict:raise SnapshotError('ledger_context_schema')
    return {'projection_profile':value['projection_profile'],'membership':value['membership'],'raw_views':{name:_ledger_ref(raws,ref) for name,ref in value['raw_views'].items()},
            'canonical_views':{name:_ledger_ref(raws,ref) for name,ref in value['canonical_views'].items()}}


def _ledger_check_wire(wire,code_generation,companions,owner):
    value=_json(wire)
    if set(value)!={'ledger','progress'} or type(value['ledger']) is not dict or type(value['progress']) is not dict:raise SnapshotError('ledger_outer_schema')
    core=value['ledger'];fields={'version','journal_format','generation_id','kind','inputs','generations','steps','nginx','expected_state','blobs','transaction_id'}
    if (set(core)!=fields or type(core['version']) is not int or core['version']!=2 or core['journal_format']!=FORMAT or not _hex(code_generation)
            or core['generation_id']!=code_generation or core['kind'] not in ('stock','none','docker_candidate') or not _hex(core['transaction_id'])):raise SnapshotError('ledger_core_schema')
    without_id={name:part for name,part in core.items() if name!='transaction_id'}
    if hashlib.sha256(_canonical(without_id)).hexdigest()!=core['transaction_id']:raise SnapshotError('ledger_transaction_digest')
    inputs=core['inputs'];expected={'operation','created_at','config','before_state','P_before','T_before','protected_context','target','approval_policy','approval_digest','companions'}
    if type(inputs) is not dict or set(inputs)!=expected or inputs['operation']!='aws_delta':raise SnapshotError('ledger_input_schema')
    raws=_ledger_raws(core['blobs'])
    config_bytes=_ledger_ref(raws,inputs['config']);config=_ledger_config(config_bytes)
    p_bytes=_ledger_ref(raws,inputs['P_before']);p=_json(p_bytes)
    state=None if inputs['before_state'] is None else _ledger_ref(raws,inputs['before_state'])
    context=_ledger_context_decode(inputs['protected_context'],raws)
    if core['kind']=='none':
        if inputs['T_before'] is not None:raise SnapshotError('ledger_none_capture')
        before=None
    elif core['kind']=='stock':before=_ledger_decode_capture(inputs['T_before'],raws,owner)
    else:before=_ledger_decode_docker(inputs['T_before'],raws,p,config,context,owner)
    nginx=core['nginx']
    if type(nginx) is not dict or set(nginx)!={'enabled','observation_code','before_shared','before_bundles','target_shared'} or type(nginx['enabled']) is not bool or type(nginx['before_shared']) is not dict or type(nginx['before_bundles']) is not dict:raise SnapshotError('ledger_nginx_schema')
    nginx_data={'observation_code':nginx['observation_code'],'before_shared':{name:_ledger_ref(raws,ref) for name,ref in nginx['before_shared'].items()},
                'before_bundles':{name:_ledger_ref(raws,ref) for name,ref in nginx['before_bundles'].items()}}
    rebuilt,captured=_ledger_core(config_bytes=config_bytes,before_state_bytes=state,baseline_bytes=p_bytes,before=before,protected_context=context,target=inputs['target'],
        nginx=nginx_data,nginx_origin=_NGINX_LEDGER_REBUILT,code_generation=code_generation,created_at=inputs['created_at'],companions=companions,owner=owner,approval_digest=inputs['approval_digest'])
    # Reconstruct all forward/inverse/owned/R/nginx/state expectations. A
    # self-consistent forged hash or extra/unused blob is still rejected.
    if _canonical(rebuilt)!=_canonical(core):raise SnapshotError('ledger_reconstruction_differs')
    progress=value['progress']
    if (set(progress)!={'ledger_id','phase','frontier','attempted_step'} or not _hex(progress['ledger_id'])
            or _canonical(progress)!=_canonical(_ledger_progress(core,progress['phase'],progress['frontier']))):raise SnapshotError('ledger_progress_schema')
    if _ledger_wire(core,progress)!=wire:raise SnapshotError('ledger_noncanonical_wire')
    largest,whole=_ledger_sizes(core,captured)
    return core,progress,largest,whole


def validate_ledger(wire_bytes,*,code_generation,companions,owner=0):
    try:
        core,progress,largest,whole=_ledger_check_wire(wire_bytes,code_generation,companions,owner)
        return ValidatedLedgerData(bytes(wire_bytes),core['transaction_id'],largest,whole)
    except SnapshotError:raise
    except Exception:raise SnapshotError('invalid_full_ledger') from None


def encode_progress(validated_data,phase,frontier,*,code_generation,companions,owner=0):
    if type(validated_data) is not ValidatedLedgerData:raise SnapshotError('ledger_data_required')
    checked=validate_ledger(validated_data.wire,code_generation=code_generation,companions=companions,owner=owner)
    if checked!=validated_data:raise SnapshotError('forged_ledger_data')
    core=_json(checked.wire)['ledger']
    return _ledger_wire(core,_ledger_progress(core,phase,frontier))


def _ledger_stock_profile(captured):
    value={'os_id':captured.os_id,'ufw_version':captured.ufw_version,'versions':captured.versions,'source_hashes':captured.source_hashes,
           'os_release':hashlib.sha256(captured.metadata[0]).hexdigest(),
           'sources':{name:hashlib.sha256(raw).hexdigest() for name,raw in captured.metadata[1]}}
    return hashlib.sha256(_canonical(value)).hexdigest()


def _ledger_docker_profile(before):
    return hashlib.sha256(_canonical({'versions':before.representation.versions,'docker_package':before.docker_package})).hexdigest()


def _ledger_profile_context(context_id,profile_id):
    return hashlib.sha256(_canonical({'context_id':context_id,'profile_identity':profile_id})).hexdigest()


def _ledger_nginx_current(core,raws,current):
    """The current nginx component against the ledger: only an input that
    nginx_ledger_input returned, unchanged (the same registry check as
    compile_ledger), whose observation is of the ledger's configured
    shared_dir and bundles (not_applicable for a disabled nginx); anything
    else is None (manual)."""
    expected=core['nginx']
    current,origin=_nginx_ledger_origin(current)
    nginx=_ledger_config(_ledger_ref(raws,core['inputs']['config']))['nginx']
    if not nginx['enabled'] and origin.observed is not None:return None
    if nginx['enabled'] and (type(origin.observed) is not tuple or origin.observed[0]!=nginx['shared_dir']
                             or origin.observed[1]!=tuple((bundle['geo_file'],bundle['realip_file']) for bundle in nginx['bundles'])):return None
    if not expected['enabled']:
        return 'both' if (type(current['observation_code']) is str and current['observation_code']=='not_applicable'
                          and type(current['before_shared']) is dict and not current['before_shared']
                          and type(current['before_bundles']) is dict and not current['before_bundles']) else None
    # Only an observed current component (nginx_ledger_input of an admitted
    # observation) is compared; a failure is never a current frontier.
    if type(current['observation_code']) is not str or current['observation_code']!='nginx_observed' or type(current['before_shared']) is not dict or type(current['before_bundles']) is not dict:return None
    if set(current['before_bundles'])!=set(expected['before_bundles']) or any(type(raw) is not bytes or raw!=_ledger_ref(raws,expected['before_bundles'][path]) for path,raw in current['before_bundles'].items()):return None
    if set(current['before_shared'])!=set(expected['before_shared']) or any(type(raw) is not bytes for raw in current['before_shared'].values()):return None
    before=all(raw==_ledger_ref(raws,expected['before_shared'][path]) for path,raw in current['before_shared'].items())
    after=all(raw==_ledger_ref(raws,expected['target_shared'][path]) for path,raw in current['before_shared'].items())
    return 'both' if before and after else 'before' if before else 'after' if after else None


def _ledger_current_descriptor(core,raws,current,context,owner):
    config=_ledger_config(_ledger_ref(raws,core['inputs']['config']));p=_json(_ledger_ref(raws,core['inputs']['P_before']))
    blobs=_LedgerBlobs();_,typed=_ledger_context(_ledger_copy(context),p,config,blobs)
    if core['kind']=='none':
        if current is not None:return None
        return _ledger_generation(None,None,None,None,'none',None,blobs)
    if core['kind']=='stock':
        observation.admit_stock(current,owner=owner)
        profile=_ledger_profile_context(typed[0],_ledger_stock_profile(current))
        return _ledger_generation(current.inventory,current.selected,current.native,current.legacy,p['profile_id'],profile,blobs)
    # Intermediate Docker generations need not be a complete Cartesian final
    # NoPublishCandidate. Accept an exact typed current R snapshot, revalidate
    # every representation/inventory/membership component, never a descriptor.
    if type(current) is not dict or set(current)!={'inventory','representation','membership','legacy','docker_package'}:return None
    representation=current['representation'];member=current['membership']
    checked=_ledger_docker.validate_representation(selected=representation.selected,native=representation.native,versions=dict(representation.versions))
    checked_member=_ledger_docker.validate_membership(member.paths,tuple({'name':b.name,'kind':'bridge','prefix':b.prefix,'gateway':b.gateway} for b in member.bridges),member.host_local_addresses,member.admin_peers)
    if checked!=representation or checked_member!=member or member!=typed[1] or type(current['docker_package']) is not str or current['docker_package']!='docker.io 29.1.3-0ubuntu4.1':return None
    inv=current['inventory'];_ledger_docker._validated_inventory(inv)
    if type(current['legacy']) is not tuple or len(current['legacy'])!=2 or any(type(raw) is not bytes or raw for raw in current['legacy']):return None
    profile=hashlib.sha256(_canonical({'versions':representation.versions,'docker_package':current['docker_package']})).hexdigest()
    return _ledger_generation(inv,representation.selected,representation.native,current['legacy'],p['profile_id'],_ledger_profile_context(typed[0],profile),blobs)


def classify_frontier(validated_data,current,*,code_generation,companions,protected_context=None,nginx_current=None,observed_state_bytes=None,owner=0):
    """All-component temporal classification, data only and never an actor.

    Current firewall evidence is revalidated and normalized, not accepted as
    caller-provided expected hash descriptors. Current nginx is independent;
    not-connected/failure and unknown partial components always mean manual.
    """
    if type(validated_data) is not ValidatedLedgerData:raise SnapshotError('ledger_data_required')
    checked=validate_ledger(validated_data.wire,code_generation=code_generation,companions=companions,owner=owner)
    if checked!=validated_data:raise SnapshotError('forged_ledger_data')
    value=_json(checked.wire);core=value['ledger'];progress=value['progress'];frontier=progress['frontier'];phase=progress['phase']
    if observed_state_bytes is not None and type(observed_state_bytes) is not bytes:return 'manual_divergence'
    raws=_ledger_raws(core['blobs'])
    try:
        actual=_ledger_current_descriptor(core,raws,current,protected_context,owner)
        nginx_phase=_ledger_nginx_current(core,raws,nginx_current)
    except Exception:return 'manual_divergence'
    if actual is None or nginx_phase is None:return 'manual_divergence'
    expected=core['generations']
    same=lambda ordinal:_canonical(actual)==_canonical(expected[ordinal])
    old_ref=core['inputs']['before_state'];old_state=None if old_ref is None else _ledger_ref(raws,old_ref)
    new_state=_ledger_ref(raws,core['expected_state'])
    old_ok=observed_state_bytes==old_state;new_ok=observed_state_bytes==new_state
    if phase in ('state_prepared','state_committed'):
        if not same(len(expected)-1) or nginx_phase not in ('after','both'):return 'manual_divergence'
        if phase=='state_prepared' and old_ok and new_ok:return 'exact_precommit_or_committed_data_only'
        if new_ok:return 'exact_committed_data_only'
        if phase=='state_prepared' and old_ok:return 'exact_precommit_data_only'
        return 'manual_divergence'
    # Every firewall/nginx/rollback phase precedes state commit, including N=0.
    if not old_ok:return 'manual_divergence'
    if phase=='prepared':return 'exact_frontier_data_only' if same(0) and nginx_phase in ('before','both') else 'manual_divergence'
    if phase=='nginx_armed':
        if not same(0):return 'manual_divergence'
        return 'exact_nginx_before_data_only' if nginx_phase in ('before','both') else 'exact_nginx_after_data_only'
    if phase=='nginx_verified':return 'exact_frontier_data_only' if same(0) and nginx_phase in ('after','both') else 'manual_divergence'
    if phase=='nginx_rollback_armed':
        if not same(0):return 'manual_divergence'
        return 'exact_nginx_inverse_after_data_only' if nginx_phase in ('before','both') else 'exact_nginx_inverse_before_data_only'
    if phase=='nginx_rollback_verified':return 'exact_frontier_data_only' if same(0) and nginx_phase in ('before','both') else 'manual_divergence'
    if nginx_phase not in ('after','both'):return 'manual_divergence'
    if same(frontier):return 'exact_frontier_data_only'
    if phase=='forward_armed' and same(frontier+1):return 'exact_expected_after_data_only'
    if phase=='rollback_armed' and same(frontier-1):return 'exact_expected_inverse_after_data_only'
    return 'manual_divergence'

# B2 read-only acquisition only. No context admission or actor connection.
CONTEXT_PROFILE = 'real-stock-context-observed-v1'
CONTEXT_COMMANDS = (
    ('/usr/bin/ip','-Version'),
    ('/usr/bin/ip','-d','-j','link','show'),
    ('/usr/bin/ip','-4','-j','address','show'),
    ('/usr/bin/ip','-6','-j','address','show'),
    ('/usr/bin/ip','-4','-j','route','show','table','all'),
    ('/usr/bin/ip','-6','-j','route','show','table','all'),
    ('/usr/bin/ip','-4','-j','rule','show'),
    ('/usr/bin/ip','-6','-j','rule','show'),
    ('/usr/bin/ss','-H','-l','-n','-t','-p'),
    ('/usr/sbin/sshd','-T','-e'),
    ('/usr/bin/systemctl','show','--property=Id,LoadState,ActiveState,SubState,MainPID,FragmentPath,ExecStart,DropInPaths','ssh.service'),
    ('/usr/bin/dpkg-query','-W','-f=${Status}\\n${Version}\\n','iproute2','openssh-server','systemd'),
)
_CONTEXT_BINARIES=tuple(sorted({argv[0] for argv in CONTEXT_COMMANDS}))

@dataclass(frozen=True)
class ContextCapture:
    # Even complete/stable data is NOT a calibrated context or actor proof.
    os_id: str
    stable_raw: bool
    samples: tuple = field(repr=False)
    files: tuple = field(repr=False)
    directories: tuple = field(repr=False)
    profile: str = field(default=CONTEXT_PROFILE,init=False)
    disposition: str = field(default='observed_unverified',init=False)


class ContextCollector:
    """Fixed stock context/SSH evidence; no normalization/admission/host writes.

    Exact raw instability is reported, never normalized or silently adopted.
    Actual 22/24/26 schemas, SSH readonly sandbox and service provenance remain
    separate review gates. This collector cannot remove runtime actor stops.
    """
    def __init__(self, *, backend, root='/', owner=0, runner=None, clock=None,
                 command_timeout=5, whole_timeout=30, max_output=4*1024*1024,
                 max_total=32*1024*1024):
        import math
        from pathlib import Path
        if (type(backend) is not str or backend not in ('ufw','none')
                or type(root) not in (str,type(Path('/'))) or not Path(root).is_absolute() or '..' in Path(root).parts
                or type(owner) is not int or not 0<=owner<2**32-1
                or any(type(v) not in (int,float) or not math.isfinite(v) or not 0<v<=120 for v in (command_timeout,whole_timeout))
                or command_timeout>whole_timeout
                or type(max_output) is not int or not 0<max_output<=4*1024*1024
                or type(max_total) is not int or not 0<max_total<=32*1024*1024
                or (runner is not None and not callable(runner)) or (clock is not None and not callable(clock))):
            raise SnapshotError('invalid_context_options')
        self.backend,self.root,self.owner=backend,Path(root),owner
        self.runner,self.clock=runner,clock
        self.command_timeout,self.whole_timeout=command_timeout,whole_timeout
        self.max_output,self.max_total=max_output,max_total

    def _now(self):
        import math,time
        value=(self.clock or time.monotonic)()
        if type(value) not in (int,float) or not math.isfinite(value):raise SnapshotError('context_clock_invalid')
        return value

    def _remaining(self,session):
        now=self._now()
        if now<session[2]:raise SnapshotError('context_clock_reversed')
        session[2]=now
        remaining=session[1]-now
        if remaining<=0:raise SnapshotError('context_deadline')
        return remaining

    def _charge(self,session,count):
        self._remaining(session)
        session[0]+=count
        if session[0]>self.max_total:raise SnapshotError('context_whole_budget')

    def _directory(self,logical,session):
        import os,stat
        path=self.root/logical.lstrip('/');fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|getattr(os,'O_NOATIME',0))
        try:
            for part in path.parts[1:]:
                self._remaining(session)
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|getattr(os,'O_NOATIME',0),dir_fd=fd)
                info=os.fstat(child)
                sticky=part=='tmp' and info.st_uid==0 and info.st_mode&stat.S_ISVTX
                if (type(info.st_uid) is not int or not 0<=info.st_uid<2**32-1
                        or type(info.st_gid) is not int or not 0<=info.st_gid<2**32-1
                        or info.st_uid not in (0,self.owner) or (info.st_mode&0o022 and not sticky)):
                    os.close(child);raise SnapshotError('context_unsafe_directory')
                os.close(fd);fd=child
            return fd
        except Exception:
            os.close(fd);raise

    def _read(self,logical,session):
        import os,stat
        parent,leaf=logical.rsplit('/',1);fd=self._directory(parent,session)
        try:
            self._remaining(session);before=os.stat(leaf,dir_fd=fd,follow_symlinks=False)
            if (not stat.S_ISREG(before.st_mode) or type(before.st_nlink) is not int or before.st_nlink!=1
                    or type(before.st_uid) is not int or before.st_uid!=self.owner
                    or type(before.st_gid) is not int or not 0<=before.st_gid<2**32-1
                    or before.st_mode&0o022 or type(before.st_size) is not int or not 0<=before.st_size<=2*1024*1024):
                raise SnapshotError('context_unsafe_file')
            # Charge metadata and refuse the known size before content allocation.
            self._charge(session,256+len(logical.encode()))
            if before.st_size>self.max_total-session[0]:raise SnapshotError('context_whole_budget')
            source=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|getattr(os,'O_NOATIME',0),dir_fd=fd)
            try:
                if observation._identity(os.fstat(source))!=observation._identity(before):raise SnapshotError('context_file_changed')
                data=bytearray()
                while True:
                    self._remaining(session);part=os.read(source,65536)
                    if not part:break
                    self._charge(session,len(part));data.extend(part)
                    if len(data)>2*1024*1024:raise SnapshotError('context_file_budget')
                if (observation._identity(os.fstat(source))!=observation._identity(before)
                        or observation._identity(os.stat(leaf,dir_fd=fd,follow_symlinks=False))!=observation._identity(before)):
                    raise SnapshotError('context_file_changed')
                raw=bytes(data)
                metadata=(stat.S_IMODE(before.st_mode),before.st_uid,before.st_gid,before.st_size,
                          hashlib.sha256(raw).hexdigest(),before.st_dev,before.st_ino,before.st_mtime_ns,before.st_ctime_ns)
                return (logical,raw,metadata)
            finally:os.close(source)
        finally:os.close(fd)

    def _names(self,fd,session):
        import os
        names=[]
        with os.scandir(fd) as entries:
            for entry in entries:
                self._charge(session,len(entry.name.encode())+32)
                if len(names)>=128:raise SnapshotError('context_ssh_include_budget')
                names.append(entry.name)
        return tuple(sorted(names))

    def _ssh(self,session):
        import os,shlex
        files=[self._read('/etc/ssh/sshd_config',session)];directories=[]
        def directives(raw,allow_include):
            try:text=raw.decode('utf-8')
            except Exception:raise SnapshotError('context_ssh_syntax') from None
            if '\x00' in text or '\\' in text:raise SnapshotError('context_ssh_syntax')
            include=False
            for line in text.splitlines():
                # OpenSSH accepts keyword[whitespace]=[whitespace]arguments.
                # This finite profile deliberately rejects that separator
                # before shell tokenization can hide Include/Match in token0.
                if re.match(r'^[ \t]*[^ \t#=]+[ \t]*=',line):
                    raise SnapshotError('context_ssh_equals_unsupported')
                try:tokens=shlex.split(line,comments=True,posix=True)
                except Exception:raise SnapshotError('context_ssh_syntax') from None
                if not tokens:continue
                key=tokens[0].lower()
                if key=='match':raise SnapshotError('context_ssh_match_unsupported')
                if key=='include':
                    if not allow_include or include or tokens[1:]!=['/etc/ssh/sshd_config.d/*.conf']:
                        raise SnapshotError('context_ssh_include_unsupported')
                    include=True
            return include
        if directives(files[0][1],True):
            logical='/etc/ssh/sshd_config.d';fd=self._directory(logical,session)
            try:
                before=os.fstat(fd);self._remaining(session);names=self._names(fd,session)
                self._charge(session,256)
                if len(names)>128 or any('/' in n or n in ('.','..') for n in names):raise SnapshotError('context_ssh_include_budget')
                for name in names:
                    if not name.startswith('.') and name.endswith('.conf'):
                        row=self._read(logical+'/'+name,session);directives(row[1],False);files.append(row)
                if observation._identity(os.fstat(fd))!=observation._identity(before) or self._names(fd,session)!=names:
                    raise SnapshotError('context_include_changed')
                # Reopen the named directory to reject replacement during closure.
                current=self._directory(logical,session)
                try:
                    if observation._identity(os.fstat(current))!=observation._identity(before):raise SnapshotError('context_include_changed')
                finally:os.close(current)
                directories.append((logical,observation._identity(before),names))
            finally:os.close(fd)
        files.extend((self._read('/etc/default/ssh',session),self._read('/usr/lib/systemd/system/ssh.service',session)))
        # Only the packaged argv with empty SSHD_OPTS is a candidate. Unit/dropin
        # and actual process provenance are still unverified, never an admission.
        try:
            env=files[-2][1].decode('utf-8');unit=files[-1][1].decode('utf-8')
            for line in env.splitlines():
                tokens=shlex.split(line,comments=True,posix=True)
                if tokens and tokens!=['SSHD_OPTS=']:raise SnapshotError('context_ssh_custom_flags')
            unit_rows=[(key.strip(),value.strip()) for line in unit.splitlines()
                       if line.strip() and not line.lstrip().startswith(('#',';')) and '=' in line
                       for key,value in (line.split('=',1),)]
            starts=[value for key,value in unit_rows if key=='ExecStart']
            envs=[key+'='+value for key,value in unit_rows if key in ('Environment','EnvironmentFile')]
            if (starts!=['/usr/sbin/sshd -D $SSHD_OPTS']
                    or envs not in ([],['EnvironmentFile=-/etc/default/ssh'])):raise SnapshotError('context_ssh_custom_flags')
        except SnapshotError:raise
        except Exception:raise SnapshotError('context_ssh_syntax') from None
        return files,directories

    def _command(self,argv,session):
        if type(argv) is not tuple or argv not in CONTEXT_COMMANDS:raise SnapshotError('context_unexpected_command')
        if argv==('/usr/sbin/sshd','-T','-e') and self.runner is None:
            # The systemd log-isolation/calibration path is not connected here.
            # Never let the default raw subprocess runner execute sshd -T -e.
            raise SnapshotError('context_sshd_sandbox_unavailable')
        remaining=self._remaining(session)
        available=min(self.max_output,self.max_total-session[0])
        if available<=0:raise SnapshotError('context_whole_budget')
        runner=self.runner if self.runner is not None else observation._stream
        result=runner(argv,timeout=min(self.command_timeout,remaining),max_output=available)
        self._remaining(session)
        if (not isinstance(result,observation.CommandResult) or type(result.stdout) is not bytes or type(result.stderr) is not bytes
                or type(result.returncode) is not int):raise SnapshotError('context_invalid_command_result')
        self._charge(session,len(result.stdout)+len(result.stderr)+128+sum(len(t) for t in argv))
        if len(result.stdout)+len(result.stderr)>available:raise SnapshotError('context_command_budget')
        if result.returncode or result.stderr:raise SnapshotError('context_command_failed')
        return result.stdout

    def _pass(self,session):
        files=[self._read('/usr/lib/os-release',session)]
        try:
            fields={}
            for line in files[0][1].decode('ascii').splitlines():
                if not line or line.startswith('#'):continue
                key,value=line.split('=',1)
                if key in fields:raise SnapshotError('context_os_profile')
                if key in ('ID','VERSION_ID'):
                    match=re.fullmatch(r'(?:"([^"\n]*)"|([A-Za-z0-9._-]+))',value)
                    if match is None:raise SnapshotError('context_os_profile')
                    value=next(part for part in match.groups() if part is not None)
                fields[key]=value
            os_id=fields['VERSION_ID']
            if fields['ID']!='ubuntu' or os_id not in ('22.04','24.04','26.04'):raise SnapshotError('context_os_profile')
        except SnapshotError:raise
        except Exception:raise SnapshotError('context_os_profile') from None
        ssh,dirs=self._ssh(session);files.extend(ssh)
        files.extend(self._read(path,session) for path in _CONTEXT_BINARIES)
        samples=[]
        for argv in CONTEXT_COMMANDS:
            raw=self._command(argv,session);samples.append((argv,raw))
            if argv[0]=='/usr/bin/ip' and '-j' in argv:
                # Raw schema sanity only. No field removal/type coercion or
                # canonical projection is authorized before actual calibration.
                def pairs(rows):
                    result={}
                    for k,v in rows:
                        if k in result:raise SnapshotError('context_duplicate_json_key')
                        result[k]=v
                    return result
                def invalid(text):raise SnapshotError('context_nonfinite_json')
                try:
                    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=invalid)
                    pending=[(value,0)];count=0
                    while pending:
                        item,depth=pending.pop();count+=1
                        if depth>24 or count>50000:raise SnapshotError('context_json_budget')
                        if type(item) is float:
                            import math
                            if not math.isfinite(item):raise SnapshotError('context_nonfinite_json')
                        if type(item) is dict:pending.extend((v,depth+1) for v in item.values())
                        elif type(item) is list:pending.extend((v,depth+1) for v in item)
                    if type(value) is not list or any(type(row) is not dict for row in value):raise SnapshotError('context_json_shape')
                except SnapshotError:raise
                except Exception:raise SnapshotError('context_json_invalid') from None
            elif argv[0]=='/usr/bin/systemctl':
                try:
                    props={}
                    for line in raw.decode().splitlines():
                        key,value=line.split('=',1)
                        if key in props:raise ValueError()
                        props[key]=value
                    if (set(props)!=set(argv[2].split('=',1)[1].split(',')) or props['Id']!='ssh.service'
                            or props['DropInPaths'] or not re.fullmatch('[0-9]{1,10}',props['MainPID'])
                            or props['FragmentPath'] not in ('/lib/systemd/system/ssh.service','/usr/lib/systemd/system/ssh.service')
                            or not re.fullmatch(r'\{ path=/usr/sbin/sshd ; argv\[\]=/usr/sbin/sshd -D \$SSHD_OPTS ; [^\n]* \}',props['ExecStart'])
                            or props['ExecStart'].count('argv[]=')!=1 or props['ExecStart'].count('path=')!=1):
                        raise ValueError()
                except Exception:raise SnapshotError('context_ssh_unit_unsupported') from None
            elif not raw and argv[0]!='/usr/bin/ss':raise SnapshotError('context_empty_command')
        return os_id,tuple(samples),tuple(files),tuple(dirs)

    def collect(self):
        if self.backend=='none':return NotApplicable('context')
        # Refuse before clock, file or command observation without a runner.
        if self.runner is None:raise SnapshotError('context_sshd_sandbox_unavailable')
        try:
            start=self._now();session=[0,start+self.whole_timeout,start]
            first=self._pass(session);second=self._pass(session)
            self._remaining(session)
            return ContextCapture(first[0],first==second,(first[1],second[1]),(first[2],second[2]),(first[3],second[3]))
        except SnapshotError:raise
        except Exception:raise SnapshotError('context_observation_failed') from None
