"""Shared check of the root-only disposable-host marker files.

Used by s0_refusal_verify.py, vm_network_verify.py and ufw_reference_verify.py,
which load it by path from their own directory with their shared load_path()
function (copy it next to them). It only
inspects a marker: it never creates, repairs or follows one. The marker is not
a defense against a malicious root; it prevents accidental invocation on an
ordinary host.
"""
import os
import stat

ABSENT, INVALID, VALID = 'absent', 'invalid', 'valid'
_OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink)


def marker_state(path, content, *, exact_mode=None, single_link=False):
    """Return ABSENT, INVALID or VALID for the marker at ``path``.

    VALID requires a regular file (lstat: a symlink is INVALID) owned by root,
    with no group/other permission bits (or exactly ``exact_mode``), a single
    link when ``single_link`` is set, and exactly the ``content`` bytes. The
    content is read from a descriptor opened O_NOFOLLOW (O_NONBLOCK, so a FIFO
    swapped in cannot block) whose fstat must match the lstat identity
    (device, inode, mode, owner, link count); at most len(content) + 1 bytes
    are read. Any other OS error is INVALID; no error text is returned.
    """
    if type(content) is not bytes:
        raise TypeError('marker content must be bytes')
    path = os.fspath(path)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return ABSENT
    except OSError:
        return INVALID
    mode = stat.S_IMODE(info.st_mode)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or (mode & 0o077 if exact_mode is None else mode != exact_mode)
            or (single_link and info.st_nlink != 1)):
        return INVALID
    try:
        fd = os.open(path, _OPEN_FLAGS)
    except OSError:
        return INVALID
    try:
        if _identity(os.fstat(fd)) != _identity(info):
            return INVALID
        limit = len(content) + 1
        data = b''
        while len(data) < limit:
            part = os.read(fd, limit - len(data))
            if not part:
                break
            data += part
    except OSError:
        return INVALID
    finally:
        os.close(fd)
    return VALID if data == content else INVALID
