"""Fixed read-only UFW evidence collection. Observation is not admission.

No constructor I/O, policy actor, UFW CLI, Docker API, lock or persistence.
Private captures are returned to the caller and omitted from representations.
Runtime generation loading/integration is deliberately outside this module.
"""
import ast
from dataclasses import dataclass, field
import hashlib
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from ufw_integrity import capture_ufw
from ufw_kernel import KernelSave, NativeRuleset
import ufw_kernel_mapping as mapping


class ObservationError(ValueError):
    """Fixed non-sensitive failure codes only."""


UFW_VERSIONS = {'22.04':'0.36.1-4ubuntu0.1', '24.04':'0.36.2-6', '26.04':'0.36.2-9build1'}
SOURCE_HASHES = {
    ('backend_iptables.py', '_write_rules'): '76fbcef34ad3a0d5e484b03e1e4e80889a2dff1edff3515949fa138d5b9c5f57',
    ('backend_iptables.py', '_read_rules'): '7af7137f65aab4e70cd8231e93b1769cddf36be6e14e7835ada43627c2f8f98e',
    ('common.py', 'format_rule'): '4f01ae5d78d57f4656c903b8aaff31213b93d2d2ff4db8120c226244a2ab1a3b',
}
PACKAGE = ('dpkg-query', '-W', '-f=${Status}\n${Version}\n', 'ufw')
TOOLS = ('iptables', 'ip6tables', 'nft', 'iptables-save', 'ip6tables-save', 'iptables-legacy-save', 'ip6tables-legacy-save')
READS = (('iptables-save',), ('ip6tables-save',), ('nft', '-j', 'list', 'ruleset'), ('iptables-legacy-save',), ('ip6tables-legacy-save',))
ALLOWED = frozenset((PACKAGE, *[(tool, '--version') for tool in TOOLS], *READS))


@dataclass(frozen=True)
class CommandResult:
    stdout: bytes = field(repr=False)
    stderr: bytes = field(repr=False)
    returncode: int


@dataclass(frozen=True)
class Observation:
    os_id: str
    ufw_version: str
    versions: tuple
    source_hashes: tuple
    inventory: object = field(repr=False)
    selected: tuple = field(repr=False)
    native: object = field(repr=False)
    legacy: tuple = field(repr=False)
    commands: tuple = field(repr=False)
    metadata: tuple = field(repr=False)
    mode: str = 'read_only_observation'


def _stream(argv, *, timeout, max_output):
    """Bound both streams during reading; do not buffer an unbounded child."""
    # Exclusive child ownership is required. A custom SIGCHLD reaper or
    # SIG_IGN could release the leader PID before group cleanup. Do not launch
    # if this embedding/platform cannot retain an unreaped leader.
    if (sys.platform != 'linux' or any(not hasattr(os, name) for name in ('waitid','WNOWAIT','WEXITED','WNOHANG','P_PID','CLD_EXITED'))
            or signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL):
        raise ObservationError('unsupported_child_ownership')
    process = None
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL':'C'},
                                   close_fds=True, start_new_session=True)
        data = {1: bytearray(), 2: bytearray()}
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            for channel, pipe in ((1, process.stdout), (2, process.stderr)):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, channel)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ObservationError('command_timeout')
                for key, _ in selector.select(min(remaining, .1)):
                    part = os.read(key.fd, min(65536, max_output + 1))
                    if not part:
                        selector.unregister(key.fileobj)
                    else:
                        data[key.data].extend(part)
                        if sum(map(len, data.values())) > max_output:
                            raise ObservationError('command_output_budget')
            # Both streams must reach EOF, including every descendant pipe
            # holder. Observe termination without reaping the session leader:
            # its PID/PGID remains reserved until killpg below, even if it
            # exited before its descendants. Never use Popen.poll here.
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ObservationError('command_timeout')
                ended = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if ended is not None:
                    break
                time.sleep(min(remaining, .01))
            code = ended.si_status if ended.si_code == os.CLD_EXITED else -ended.si_status
        return CommandResult(bytes(data[1]), bytes(data[2]), code)
    except (OSError, subprocess.SubprocessError):
        raise ObservationError('command_unavailable') from None
    finally:
        if process is not None:
            # No poll/wait has reaped our leader. Kill the owned group before
            # releasing that PID; this also cleans descendants with closed
            # pipes after otherwise successful commands. Unrelated groups
            # cannot reuse this reserved ID. External waitpid/reaping of this
            # exclusively owned child is outside the supported embedding.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                process.wait()
            for pipe in (process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Collector:
    def __init__(self, root=Path('/'), *, owner=0, runner=None, timeout=20,
                 max_output=8*1024*1024, max_total=32*1024*1024):
        self.root = Path(root)
        if (not self.root.is_absolute() or '..' in self.root.parts or type(owner) is not int or not 0 <= owner < 2**32-1
                or type(timeout) not in (int, float) or not 0 < timeout <= 120
                or type(max_output) is not int or not 0 < max_output <= 8*1024*1024
                or type(max_total) is not int or not 0 < max_total <= 64*1024*1024
                or (runner is not None and not callable(runner))):
            raise ObservationError('invalid_collector_options')
        self.owner, self.runner, self.timeout = owner, runner, timeout
        self.max_output, self.max_total = max_output, max_total

    def _read(self, logical, budget):
        path = self.root / logical.lstrip('/')
        # All ancestors are checked, then reached through NOFOLLOW dirfds.
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for component in path.parts[1:-1]:
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                info = os.fstat(child)
                sticky = component == 'tmp' and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
                if info.st_uid not in (0, self.owner) or (info.st_mode & 0o022 and not sticky):
                    os.close(child)
                    raise ObservationError('unsafe_evidence_directory')
                os.close(fd)
                fd = child
            leaf = path.name
            before = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != self.owner
                    or before.st_mode & 0o022 or before.st_size > 2*1024*1024):
                raise ObservationError('unsafe_evidence_file')
            source = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_NOATIME', 0), dir_fd=fd)
            try:
                if _identity(os.fstat(source)) != _identity(before):
                    raise ObservationError('evidence_changed')
                data = bytearray()
                while True:
                    part = os.read(source, 65536)
                    if not part:
                        break
                    data.extend(part)
                    if len(data) > 2*1024*1024:
                        raise ObservationError('evidence_file_budget')
                    self._charge(budget, len(part))
                if (_identity(os.fstat(source)) != _identity(before)
                        or _identity(os.stat(leaf, dir_fd=fd, follow_symlinks=False)) != _identity(before)):
                    raise ObservationError('evidence_changed')
                return bytes(data)
            finally:
                os.close(source)
        finally:
            os.close(fd)

    def _charge(self, budget, count):
        budget[0] += count
        if budget[0] > self.max_total:
            raise ObservationError('aggregate_evidence_budget')

    def _command(self, argv, budget, samples):
        if type(argv) is not tuple or argv not in ALLOWED:
            raise ObservationError('unexpected_command')
        result = (self.runner or _stream)(argv, timeout=self.timeout,
                                         max_output=min(self.max_output, self.max_total-budget[0]))
        if (type(result) is not CommandResult or type(result.stdout) is not bytes
                or type(result.stderr) is not bytes or type(result.returncode) is not int):
            raise ObservationError('missing_command_result')
        if len(result.stdout) + len(result.stderr) > self.max_output:
            raise ObservationError('command_output_budget')
        self._charge(budget, len(result.stdout)+len(result.stderr))
        if result.returncode != 0 or result.stderr:
            raise ObservationError('command_failed')
        samples.append((argv, result.stdout))
        return result.stdout

    def _inventory(self, budget):
        inventory = capture_ufw(self.root, owner=self.owner,
                                max_total=min(16*1024*1024, self.max_total-budget[0]))
        self._charge(budget, sum(map(len, inventory.contents.values())))
        return inventory

    def _pass(self, budget):
        samples = []
        osraw = self._read('/usr/lib/os-release', budget)
        fields = {}
        for line in osraw.decode('ascii').splitlines():
            if not line or line.startswith('#'):
                continue
            key, value = line.split('=', 1)
            if key in fields:
                raise ObservationError('duplicate_os_field')
            if key in ('ID', 'VERSION_ID'):
                match = re.fullmatch(r'(?:"([^"\n]*)"|([A-Za-z0-9._-]+))', value)
                if match is None:
                    raise ObservationError('invalid_os_profile')
                value = next(part for part in match.groups() if part is not None)
            fields[key] = value
        os_id = fields.get('VERSION_ID')
        if fields.get('ID') != 'ubuntu' or os_id not in UFW_VERSIONS:
            raise ObservationError('unsupported_os_profile')
        package = self._command(PACKAGE, budget, samples)
        if package != ('install ok installed\n'+UFW_VERSIONS[os_id]+'\n').encode():
            raise ObservationError('unsupported_ufw_package')
        sources = {name:self._read('/usr/lib/python3/dist-packages/ufw/'+name, budget)
                   for name in ('backend_iptables.py', 'common.py')}
        hashes = []
        for (name, function), expected in SOURCE_HASHES.items():
            matches = [node for node in ast.walk(ast.parse(sources[name]))
                       if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function]
            if len(matches) != 1:
                raise ObservationError('unsupported_ufw_source')
            digest = hashlib.sha256(b''.join(sources[name].splitlines(keepends=True)[matches[0].lineno-1:matches[0].end_lineno])).hexdigest()
            if digest != expected:
                raise ObservationError('unsupported_ufw_source')
            hashes.append((name, function, digest))
        versions = {}
        expected = mapping.BACKEND_PROFILES[os_id]['versions']
        number = expected['iptables'].split()[1]
        for tool in TOOLS:
            raw = self._command((tool, '--version'), budget, samples)
            if tool in expected:
                value = expected[tool]
            else:
                value = ('ip6tables-save' if tool.startswith('ip6') else 'iptables-save') + ' ' + number + (' (legacy)' if 'legacy' in tool else ' (nf_tables)')
            if raw != (value+'\n').encode():
                raise ObservationError('unsupported_tool_profile')
            versions[tool] = value
        inventory = self._inventory(budget)
        raw = [self._command(argv, budget, samples) for argv in READS]
        selected = tuple(KernelSave.parse(data) for data in raw[:2])
        native = NativeRuleset.parse(raw[2], profile=mapping.BACKEND_PROFILES[os_id]['native'])
        legacy = tuple(KernelSave.parse(data).canonical if data else b'' for data in raw[3:])
        # Include exact source bytes in stability comparison, not only function ASTs.
        identity = (osraw, tuple(sorted(sources.items())))
        return Observation(os_id, UFW_VERSIONS[os_id], tuple(sorted(versions.items())),
                           tuple(hashes), inventory, selected, native, legacy, tuple(samples), identity), identity

    def collect(self):
        budget = [0]
        try:
            before, before_id = self._pass(budget)
            after, after_id = self._pass(budget)
            if (before_id != after_id or before.os_id != after.os_id
                    or before.versions != after.versions or before.source_hashes != after.source_hashes
                    or before.inventory != after.inventory or before.selected != after.selected
                    or before.native != after.native or before.legacy != after.legacy):
                raise ObservationError('unstable_observation')
            return after
        except ObservationError:
            raise
        except Exception:
            raise ObservationError('observation_unavailable') from None


def _assignments(raw, expected):
    result = {}
    for line in raw.decode('utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)\s*=\s*(?:\"([^\"\n]*)\"|'([^'\n]*)'|([^#\s]+))\s*(?:#.*)?", line)
        if match is None or match[1] in result or match[1] not in expected:
            raise ObservationError('unsupported_ufw_configuration')
        result[match[1]] = next(value for value in match.groups()[1:] if value is not None)
    if result != expected:
        raise ObservationError('unsupported_ufw_configuration')


def admit_stock(observation, *, owner=0):
    """Explicit stock-only raw/compat/native proof, never Docker admission."""
    if (type(owner) is not int or not 0 <= owner < 2**32-1 or type(observation) is not Observation
            or observation.mode != 'read_only_observation'):
        raise ObservationError('invalid_observation')
    try:
        if (type(observation.os_id) is not str or observation.os_id not in UFW_VERSIONS
                or observation.ufw_version != UFW_VERSIONS[observation.os_id]
                or type(observation.commands) is not tuple or type(observation.metadata) is not tuple
                or len(observation.metadata) != 2):
            raise ObservationError('invalid_observation_metadata')
        samples = observation.commands
        expected_argv = (PACKAGE, *[(tool, '--version') for tool in TOOLS], *READS)
        if (len(samples) != len(expected_argv)
                or any(type(row) is not tuple or len(row) != 2 or row[0] != argv
                       or type(row[0]) is not tuple or type(row[1]) is not bytes
                       for row, argv in zip(samples, expected_argv))):
            raise ObservationError('invalid_observation_commands')
        # Re-run the pure parsing path from immutable captured bytes. Its I/O
        # adapters are local functions, never a host read or command.
        metadata = observation.metadata
        if (type(metadata[0]) is not bytes or type(metadata[1]) is not tuple
                or any(type(row) is not tuple or len(row) != 2 or type(row[0]) is not str or type(row[1]) is not bytes for row in metadata[1])
                or tuple(row[0] for row in metadata[1]) != ('backend_iptables.py', 'common.py')):
            raise ObservationError('invalid_observation_sources')
        byte_values = [metadata[0], *[row[1] for row in metadata[1]], *[row[1] for row in samples]]
        if (any(len(raw) > 8*1024*1024 for raw in byte_values)
                or any(len(row[1]) > 2*1024*1024 for row in metadata[1])
                or len(metadata[0]) > 2*1024*1024 or sum(map(len, byte_values)) > 32*1024*1024):
            raise ObservationError('invalid_observation_budget')
        source_map = {'/usr/lib/os-release':metadata[0]}
        source_map.update({'/usr/lib/python3/dist-packages/ufw/'+name:data for name,data in metadata[1]})
        replay = Collector(owner=owner)
        replay._read = lambda path, budget: source_map[path]
        iterator = iter(samples)
        def command(argv, budget, captured):
            expected, output = next(iterator)
            if argv != expected:
                raise ObservationError('invalid_observation_commands')
            captured.append((argv, output))
            return output
        replay._command = command
        inventory = observation.inventory
        from ufw_integrity import UfwInventory
        if type(inventory) is not UfwInventory or type(inventory.manifest) is not tuple:
            raise ObservationError('invalid_observation_inventory')
        if (len(inventory.manifest) > 256 or len(inventory.contents) > 256
                or any(type(value) is not bytes or len(value) > 4*1024*1024 for value in inventory.contents.values())
                or sum(map(len, inventory.contents.values())) + sum(map(len, byte_values)) > 32*1024*1024):
            raise ObservationError('invalid_observation_budget')
        paths = set()
        files = set()
        for row in inventory.manifest:
            path = row['path']
            if (type(path) is not str or path in paths or str(Path(path)) != path or '\x00' in path or '..' in Path(path).parts
                    or (path != '/etc/default/ufw' and path != '/etc/ufw' and not path.startswith('/etc/ufw/'))):
                raise ObservationError('invalid_observation_inventory')
            paths.add(path)
            if (any(type(row[key]) is not int or row[key] < 0 for key in ('mode','uid','gid'))
                    or any(row[key] >= 2**32-1 for key in ('uid','gid'))
                    or row['uid'] != owner or row['mode'] > 0o777 or row['mode'] & 0o022):
                raise ObservationError('invalid_observation_inventory')
            base_keys = {'path','mode','uid','gid','kind'}
            if row['kind'] == 'file':
                if set(row) != base_keys | {'size','sha256'}:
                    raise ObservationError('invalid_observation_inventory')
                data = inventory.contents[path]
                if (type(data) is not bytes or type(row['size']) is not int or len(data) != row['size']
                        or hashlib.sha256(data).hexdigest() != row['sha256']):
                    raise ObservationError('invalid_observation_inventory')
                files.add(path)
            elif row['kind'] != 'directory' or set(row) != base_keys:
                raise ObservationError('invalid_observation_inventory')
        required = {'/etc/default/ufw', *['/etc/ufw/'+name for name in (
            'user.rules','user6.rules','before.rules','before6.rules','after.rules','after6.rules','ufw.conf')]}
        directories = paths - files
        if (files != set(inventory.contents) or not required <= files or '/etc/ufw' not in directories
                or any(str(Path(path).parent) not in directories for path in paths
                       if path not in ('/etc/ufw', '/etc/default/ufw'))):
            raise ObservationError('invalid_observation_inventory')
        # _pass shares all exact OS/package/source/tool/kernel parsers; only
        # capture_ufw is substituted through a dedicated optional private hook.
        replay._inventory = lambda budget: inventory
        rebuilt, _ = replay._pass([0])
        if rebuilt != observation:
            raise ObservationError('forged_observation')
        _assignments(inventory.contents['/etc/ufw/ufw.conf'], {'ENABLED':'yes', 'LOGLEVEL':'low'})
        _assignments(inventory.contents['/etc/default/ufw'], {
            'IPV6':'yes', 'DEFAULT_INPUT_POLICY':'DROP', 'DEFAULT_OUTPUT_POLICY':'ACCEPT',
            'DEFAULT_FORWARD_POLICY':'DROP', 'DEFAULT_APPLICATION_POLICY':'SKIP', 'MANAGE_BUILTINS':'no',
            'IPT_SYSCTL':'/etc/ufw/sysctl.conf', 'IPT_MODULES':''})
        versions = dict(observation.versions)
        proof = mapping.validate_semantics(mapping.validate_structure(mapping.validate_envelope(
            selected=observation.selected, native=observation.native, legacy=observation.legacy,
            versions={tool:versions[tool] for tool in ('iptables', 'ip6tables', 'nft')})))
        raw = {name:observation.inventory.contents['/etc/ufw/'+name]
               for name in ('before.rules','before6.rules','after.rules','after6.rules','user.rules','user6.rules')}
        return mapping.validate_raw(proof, raw)
    except Exception:
        raise ObservationError('stock_admission_failed') from None
