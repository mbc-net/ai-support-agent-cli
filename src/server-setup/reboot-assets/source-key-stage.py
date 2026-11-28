"""Source-only, one-shot tmpfs key staging. Never returns private bytes to SSH."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

BASE = Path('/run/smiles-reboot-keys')
UNITS = Path('/run/systemd/system')
OWNER = '8d6f037733724fbe969cf513e11b4b9f'
HELPER = 'f8f3c09150ca501f224346d004fb21296c4dca1bd7e0d47d728bd032884b5353'
UID = 0
REVISION = 'smiles-source-key-stage-v1'


def require(value):
    if not value:
        raise RuntimeError('SOURCE_KEY_STAGE_REFUSED')


def safe(path, directory=False):
    s = path.lstat()
    require(s.st_uid == UID and not stat.S_ISLNK(s.st_mode))
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1)
    require(stat.S_IMODE(s.st_mode) == (0o700 if directory else 0o600))
    return s


def ancestors(path):
    for node in (path, *path.parents):
        s = node.lstat()
        require(s.st_uid == UID and stat.S_ISDIR(s.st_mode) and not s.st_mode & 0o022)


def read(path, limit=16384):
    s = safe(path)
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        a = os.fstat(fd)
        require((a.st_dev, a.st_ino) == (s.st_dev, s.st_ino) and a.st_size <= limit)
        raw = os.read(fd, limit + 1)
        b = os.fstat(fd)
        require(len(raw) == a.st_size and (a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns) == (b.st_dev, b.st_ino, b.st_size, b.st_mtime_ns))
        return raw
    finally:
        os.close(fd)


def write(path, raw):
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as out:
            out.write(raw)
            out.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync(path.parent)


def sync(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def call(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=20,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    require(result.returncode == 0 and len(result.stdout) <= 32768)
    return result.stdout.decode('ascii')


def boot():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def bound(profile):
    require(os.geteuid() == UID)
    run = profile['runId']
    require(isinstance(run, str) and re.fullmatch('[0-9a-f]{32}', run))
    require(profile['accountOwnerRunId'] == OWNER and profile['sourceBootId'] == boot())
    safe(BASE, True)
    return run, BASE / run


def lock(directory):
    safe(directory, True)
    fd = os.open(str(directory / 'operation.lock'), os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    s = safe(directory / 'operation.lock')
    a = os.fstat(fd)
    require((s.st_dev, s.st_ino) == (a.st_dev, a.st_ino))
    fcntl.flock(fd, fcntl.LOCK_EX)
    return os.fdopen(fd, 'rb')


def units(run):
    name = 'smiles-reboot-key-expire-' + run
    return (UNITS / (name + '.service'), UNITS / (name + '.timer'),
            UNITS / ('smiles-reboot-keygen-' + run + '.service'))


def verify_unit(path):
    require(call(['/bin/systemctl', 'show', path.name, '--property=FragmentPath', '--value']).strip() == str(path))
    require(call(['/bin/systemctl', 'show', path.name, '--property=DropInPaths', '--value']).strip() == '')
    require(call(['/bin/systemctl', 'show', path.name, '--property=NeedDaemonReload', '--value']).strip() == 'no')


def stop_keygen(run, directory):
    keygen = units(run)[2]
    proofs = json.loads(read(directory / 'unit-proofs.json'))
    require(set(proofs) == {p.name for p in units(run)})
    require(hashlib.sha256(read(keygen)).hexdigest() == proofs[keygen.name])
    verify_unit(keygen)
    call(['/bin/systemctl', 'stop', keygen.name])
    require(call(['/bin/systemctl', 'show', keygen.name, '--property=MainPID', '--value']).strip() == '0')


def fingerprint(public):
    import base64
    require(re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}', public) is not None)
    wire = base64.b64decode(public.split(' ')[1], validate=True)
    require(len(wire) == 51 and wire[:19] == bytes.fromhex('0000000b7373682d6564323535313900000020'))
    return 'SHA256:' + base64.b64encode(hashlib.sha256(wire).digest()).decode().rstrip('=')


def prepare(profile, code):
    # BASE is public metadata only. Caller preflight proves /run tmpfs and swap0.
    require(os.geteuid() == UID)
    ancestors(BASE.parent)
    ancestors(UNITS)
    if not BASE.exists():
        BASE.mkdir(mode=0o700)
    run, directory = bound(profile)
    directory.mkdir(mode=0o700)  # no retry/adoption, even of a partial run
    sync(BASE)
    write(directory / 'operation.lock', b'')
    with lock(directory):
        deadline = int(time.time()) + 600
        intent = {'revision': REVISION, 'run_id': run, 'account_owner_run_id': OWNER,
                  'job_id': profile['jobId'],
                  'source_boot_id': profile['sourceBootId'], 'helper_sha256': HELPER,
                  'stage_nonce': os.urandom(32).hex(), 'deadline_utc': deadline}
        write(directory / 'intent.json', json.dumps(intent, sort_keys=True, separators=(',', ':')).encode())
        write(directory / 'expire.py', code)
        service, timer, keygen = units(run)
        # Independent timer is armed BEFORE ssh-keygen can materialize a key.
        write(service, ('[Unit]\nDescription=Owned source key expiry\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3.8 -I -S -B ' + str(directory / 'expire.py') + ' ' + run + '\nLimitCORE=0\nStandardOutput=null\nStandardError=null\n').encode())
        write(timer, ('[Unit]\nDescription=Owned source key deadline\n[Timer]\nOnActiveSec=600s\nAccuracySec=1s\nUnit=' + service.name + '\n').encode())
        write(keygen, ('[Unit]\nDescription=One-shot source-local key generation\nConditionPathExists=!' + str(directory / 'expired.json') + '\n[Service]\nType=oneshot\nUser=root\nUMask=0077\nTimeoutStartSec=20\nKillMode=control-group\nRestart=no\nLimitCORE=0\nStandardOutput=null\nStandardError=null\nExecStart=/usr/bin/ssh-keygen -q -t ed25519 -N "" -C "" -f ' + str(directory / 'identity') + '\n').encode())
        write(directory / 'unit-proofs.json', json.dumps({p.name: hashlib.sha256(read(p)).hexdigest() for p in (service, timer, keygen)}, sort_keys=True, separators=(',', ':')).encode())
        call(['/bin/systemctl', 'daemon-reload'])
        call(['/bin/systemctl', 'start', timer.name])
        require(call(['/bin/systemctl', 'is-active', timer.name]).strip() == 'active')
        for path in (service, timer, keygen):
            verify_unit(path)
        require(boot() == profile['sourceBootId'] and time.time() < deadline and not (directory / 'expired.json').exists())
        try:
            call(['/bin/systemctl', 'start', keygen.name])
            require(call(['/bin/systemctl', 'show', keygen.name, '--property=Result', '--value']).strip() == 'success')
            require(call(['/bin/systemctl', 'show', keygen.name, '--property=MainPID', '--value']).strip() == '0')
            # OpenSSH public output is public; chmod to the same strict stage mode.
            os.chmod(str(directory / 'identity.pub'), 0o600)
            private = read(directory / 'identity', 8192)
            require(private.startswith(b'-----BEGIN OPENSSH PRIVATE KEY-----\n'))
            public = read(directory / 'identity.pub', 512).decode('ascii').strip()
            require(call(['/usr/bin/ssh-keygen', '-y', '-f', str(directory / 'identity')]).strip() == public)
            receipt = dict(intent, status='key_prepared', public_key=public,
                           source_key_fingerprint=fingerprint(public))
            require(boot() == profile['sourceBootId'] and time.time() < deadline and not (directory / 'expired.json').exists())
            write(directory / 'receipt.json', json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode())
            return receipt
        except BaseException:
            stop_keygen(run, directory)
            for name in ('identity', 'identity.pub'):
                path = directory / name
                if os.path.lexists(str(path)):
                    safe(path)
                    path.unlink()
            sync(directory)
            raise


def consume(profile, start):
    run, directory = bound(profile)
    with lock(directory):
        stop_keygen(run, directory)
        intent = json.loads(read(directory / 'intent.json'))
        receipt = json.loads(read(directory / 'receipt.json'))
        require(receipt == profile['publicInput']['source_key_receipt'])
        require({k: receipt[k] for k in intent} == intent)
        require(intent['run_id'] == run and intent['source_boot_id'] == boot() and intent['account_owner_run_id'] == OWNER)
        require(intent['job_id'] == profile['jobId'])
        require(time.time() < intent['deadline_utc'] and not (directory / 'consumed.json').exists() and not (directory / 'expired.json').exists())
        require(receipt['public_key'] == profile['publicInput']['public_contract']['public_key'])
        private = read(directory / 'identity', 8192).decode('ascii')
        write(directory / 'consumed.json', b'{"status":"handoff_intent"}')
        # Stage copies disappear BEFORE an independently supervised f8 handoff.
        # A hung/unknown handoff cannot retain or replay the stage filesystem key.
        for name in ('identity', 'identity.pub'):
            safe(directory / name)
            (directory / name).unlink()
        sync(directory)
    require(boot() == profile['sourceBootId'] and time.time() < intent['deadline_utc'] and not (directory / 'expired.json').exists())
    start(private)


def expire(run):
    require(os.geteuid() == UID and re.fullmatch('[0-9a-f]{32}', run) is not None)
    safe(BASE, True)
    directory = BASE / run
    safe(directory, True)
    intent = json.loads(read(directory / 'intent.json'))
    require(intent['run_id'] == run and intent['account_owner_run_id'] == OWNER and intent['helper_sha256'] == HELPER)
    marker = directory / 'expired.json'
    expected = b'{"status":"expired"}'
    if os.path.lexists(str(marker)):
        require(read(marker) == expected)
    else:
        write(marker, expected)
    # No consumer lock: it must never block the independent deadline. The marker
    # prevents a delayed new keygen start; stop drains one already in flight.
    stop_keygen(run, directory)
    known = set(p.name for p in directory.iterdir()) <= {'operation.lock', 'intent.json', 'unit-proofs.json', 'expire.py', 'identity', 'identity.pub', 'receipt.json', 'consumed.json', 'expired.json'}
    for name in ('identity', 'identity.pub'):
        path = directory / name
        if os.path.lexists(str(path)):
            safe(path)
            try:
                path.unlink()
            except FileNotFoundError:
                pass
    sync(directory)
    require(known)


if __name__ == '__main__':
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        require(len(sys.argv) == 2)
        expire(sys.argv[1])
    except BaseException:
        sys.exit(1)
