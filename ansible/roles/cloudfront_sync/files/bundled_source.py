"""Load the fixed bundled helper DAG from source, never bytecode caches.

Callers hold their deployment/synchronization lock. This is not a generic
importer: paths, names and ordering are fixed, and an in-process generation
change fails instead of reloading classes used by existing proof objects.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
from types import MappingProxyType, ModuleType


NAMES = ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel', 'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot')
ALIAS = '_cloudfront_sync_integrity_adapter'
DIRECTORY = Path('/usr/local/libexec/cloudfront-sync')
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_BUNDLE_BYTES = 4 * 1024 * 1024


class SourceError(ValueError):
    """Only fixed, non-sensitive failure codes leave this loader."""


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class BundledSources:
    def __init__(self, directory=DIRECTORY, *, owner=0, expected_hashes=None):
        self._directory = Path(directory)
        if (not self._directory.is_absolute() or '..' in self._directory.parts
                or type(owner) is not int or owner < 0):
            raise SourceError('invalid_bundle_location')
        self._owner = owner
        if expected_hashes is not None:
            if (not isinstance(expected_hashes, (dict, MappingProxyType))
                    or any(type(name) is not str for name in expected_hashes)
                    or set(expected_hashes) != set(NAMES)
                    or any(type(value) is not str or re.fullmatch('[0-9a-f]{64}', value) is None
                           for value in expected_hashes.values())):
                raise SourceError('invalid_expected_bundle_hashes')
            expected_hashes = MappingProxyType(dict(expected_hashes))
        # Optional for the standalone C0 API; generation-bound runtime callers
        # must supply the verified fixed map once at construction.
        self._expected_hashes = expected_hashes
        self._modules = None
        self._fingerprint = None
        self._failed = False

    def _ancestors(self):
        result = []
        for path in (*reversed(self._directory.parents), self._directory):
            info = path.lstat()
            owner = self._owner if path == self._directory else (0, self._owner)
            if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                    or (info.st_uid != owner if type(owner) is int else info.st_uid not in owner)):
                raise SourceError('unsafe_bundle_directory')
            # Disposable fixtures may live below the OS's root-owned sticky
            # tmp directory. No writable directory within the bundle is allowed.
            sticky_tmp = (path != self._directory and path in (Path('/tmp'), Path('/private/tmp'))
                          and info.st_uid == 0 and info.st_mode & stat.S_ISVTX)
            if info.st_mode & 0o022 and not sticky_tmp:
                raise SourceError('writable_bundle_directory')
            result.append((path, _identity(info)))
        return tuple(result)

    def _read_sources(self):
        ancestors = self._ancestors()
        directory_fd = os.open(self._directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if _identity(os.fstat(directory_fd)) != ancestors[-1][1]:
                raise SourceError('bundle_changed_during_read')
            sources, identities, total = {}, {}, 0
            for name in NAMES:
                leaf = name + '.py'
                before = os.stat(leaf, dir_fd=directory_fd, follow_symlinks=False)
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                        or before.st_uid != self._owner or before.st_mode & 0o022):
                    raise SourceError('unsafe_bundle_source')
                if before.st_size > MAX_SOURCE_BYTES:
                    raise SourceError('bundle_source_size_exceeded')
                fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                try:
                    if _identity(os.fstat(fd)) != _identity(before):
                        raise SourceError('bundle_changed_during_read')
                    data = bytearray()
                    while True:
                        part = os.read(fd, min(65536, MAX_SOURCE_BYTES + 1 - len(data)))
                        if not part:
                            break
                        data.extend(part)
                        if len(data) > MAX_SOURCE_BYTES:
                            raise SourceError('bundle_source_size_exceeded')
                    if (_identity(os.fstat(fd)) != _identity(before)
                            or _identity(os.stat(leaf, dir_fd=directory_fd, follow_symlinks=False)) != _identity(before)):
                        raise SourceError('bundle_changed_during_read')
                finally:
                    os.close(fd)
                total += len(data)
                if total > MAX_BUNDLE_BYTES:
                    raise SourceError('bundle_aggregate_size_exceeded')
                sources[name] = bytes(data)
                identities[leaf] = _identity(before)
            if (self._ancestors() != ancestors
                    or _identity(os.fstat(directory_fd)) != ancestors[-1][1]
                    or any(_identity(os.stat(leaf, dir_fd=directory_fd, follow_symlinks=False)) != identity
                           for leaf, identity in identities.items())):
                raise SourceError('bundle_changed_during_read')
            return sources
        finally:
            os.close(directory_fd)

    def _module_matches(self, name, module):
        return (sys.modules.get(name) is module
                and module.__dict__.get('__name__') == name
                and module.__dict__.get('__file__') == str(self._directory / (name + '.py'))
                and module.__dict__.get('__package__') == ''
                and module.__dict__.get('__cached__') is None)

    def load(self):
        if self._failed:
            raise SourceError('bundle_loader_failed')
        created = []
        try:
            sources = self._read_sources()
            # Some filesystems can retain the same timestamps for a same-size
            # write within one tick. Metadata checks alone are not sufficient.
            if self._read_sources() != sources:
                raise SourceError('bundle_changed_during_read')
            if self._expected_hashes is not None and any(
                    hashlib.sha256(sources[name]).hexdigest() != self._expected_hashes[name] for name in NAMES):
                raise SourceError('expected_bundle_hash_differs')
            fingerprint = tuple((str(self._directory / (name + '.py')),
                                 hashlib.sha256(sources[name]).hexdigest()) for name in NAMES)
            if self._modules is not None:
                if (fingerprint != self._fingerprint
                        or any(not self._module_matches(name, self._modules[name]) for name in NAMES)
                        or sys.modules.get(ALIAS) is not self._modules['ufw_integrity']):
                    raise SourceError('bundle_generation_changed')
                return self._modules
            if any(name in sys.modules for name in (*NAMES, ALIAS)):
                raise SourceError('unverified_bundle_module')
            # Compile all bytes first. Neither SourceFileLoader nor py_compile
            # participates, so existing __pycache__ files are never consulted.
            codes = {name: compile(sources[name], str(self._directory / (name + '.py')),
                                   'exec', dont_inherit=True) for name in NAMES}
            modules = {}
            for name in NAMES:
                module = ModuleType(name)
                module.__file__ = str(self._directory / (name + '.py'))
                module.__package__ = ''
                module.__cached__ = None
                sys.modules[name] = module
                created.append((name, module))
                exec(codes[name], module.__dict__)
                if any(not self._module_matches(key, value) for key, value in created):
                    raise SourceError('bundle_module_identity_changed')
                modules[name] = module
            sys.modules[ALIAS] = modules['ufw_integrity']
            created.append((ALIAS, modules['ufw_integrity']))
            self._fingerprint = fingerprint
            self._modules = MappingProxyType(modules)
            return self._modules
        except BaseException:
            for name, module in reversed(created):
                if sys.modules.get(name) is module:
                    del sys.modules[name]
            self._failed = True
            raise SourceError('bundled_source_unavailable') from None
