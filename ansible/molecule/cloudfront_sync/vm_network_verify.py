#!/usr/bin/python3
"""Disposable real-VM ingress checks. Never run on an operational host.

Only test namespaces/interfaces and one temporary nginx file are created. The
firewall, synchronization state, and existing nginx files must be unchanged.
The fixture origin header is deliberately public and unrelated to production.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

SENTINEL = Path('/run/cloudfront-sync-disposable-test')
SENTINEL_CONTENT = 'CloudFront sync isolated verification only\n'
STATE = Path('/var/lib/cloudfront-sync/private/state.json')
CONFIG = Path('/etc/cloudfront-sync/config.json')
TEMP_CONFIG = Path('/etc/nginx/conf.d/cf-sync-vm-network.conf')
SHARED = '/etc/nginx/cloudfront-live'
TOKEN = 'public-disposable-cf-sync-network-fixture'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}

PROBE = r'''
import http.client,json,socket,sys
p=json.load(sys.stdin)
try:
    if p['kind']=='ssh':
        with socket.create_connection((p['address'],22),timeout=3) as s:
            banner=s.recv(64)
        result={'ssh':banner.startswith(b'SSH-')}
    else:
        c=http.client.HTTPConnection(p['address'],443,timeout=2)
        try:
            c.request('GET','/',headers=p.get('headers',{}))
            r=c.getresponse()
            result={'status':r.status,'body':r.read(2048).decode('utf-8')}
        finally:
            c.close()
except (OSError,TimeoutError,http.client.HTTPException):
    result={'blocked':True}
print(json.dumps(result))
'''


class NetworkCheckError(Exception):
    """A sanitized fixture failure, containing no server configuration."""


def run(args, *, data=None, check=True):
    try:
        result = subprocess.run(args, input=data, text=True, capture_output=True,
                                timeout=30, env=ENV)
    except (OSError, subprocess.SubprocessError) as exc:
        raise NetworkCheckError('VM network verification command unavailable or timed out') from exc
    if check and result.returncode:
        raise NetworkCheckError('VM network verification command failed')
    return result


def check_sentinel(path):
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or info.st_mode & 0o077 or path.read_text() != SENTINEL_CONTENT):
            raise NetworkCheckError('exact root-only disposable-host marker required')
    except OSError as exc:
        raise NetworkCheckError('exact root-only disposable-host marker required') from exc


def apple_vz_dmi():
    # Ubuntu22.04 systemd249 predates Apple VZ detection. Require the exact
    # virtual product AND Apple vendor/BIOS, never a broad Apple/bare-metal
    # match. Host-side limactl metadata independently records vmType=vz.
    try:
        values = tuple((Path('/sys/class/dmi/id') / name).read_text().rstrip('\n')
                       for name in ('sys_vendor', 'product_name', 'bios_vendor'))
    except OSError:
        return None
    if values == ('Apple Inc.', 'Apple Virtualization Generic Platform', 'Apple Inc.'):
        return values[1]
    return None


def check_environment(sentinel=SENTINEL):
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise NetworkCheckError('requires root in a disposable Linux virtual machine')
    check_sentinel(sentinel)
    container = run(['systemd-detect-virt', '--container'], check=False)
    if container.returncode == 0:
        raise NetworkCheckError('containers are not accepted as real-VM evidence')
    vm = run(['systemd-detect-virt', '--vm'], check=False)
    evidence = {'evidence_method': 'systemd-detect-virt', 'virtual_model': vm.stdout.strip()}
    if vm.returncode != 0:
        model = apple_vz_dmi()
        if model is None:
            raise NetworkCheckError('a recognized virtual machine is required')
        evidence = {'evidence_method': 'apple-vz-dmi', 'virtual_model': model}
    if run(['systemctl', 'is-active', 'nginx.service']).stdout.strip() != 'active':
        raise NetworkCheckError('nginx must already be active')
    if (run(['systemctl', 'is-enabled', '--quiet', 'cloudfront-sync.timer'], check=False).returncode == 0
            or run(['systemctl', 'is-active', '--quiet', 'cloudfront-sync.timer'], check=False).returncode == 0):
        raise NetworkCheckError('automatic synchronization must remain stopped and disabled')
    if run(['systemctl', 'is-active', 'cloudfront-sync.service'], check=False).stdout.strip() in ('active', 'activating', 'deactivating', 'reloading'):
        raise NetworkCheckError('synchronization must be quiescent before network verification')
    if not run(['ufw', 'status']).stdout.startswith('Status: active'):
        raise NetworkCheckError('an active UFW fixture is required')
    if run(['ss', '-H', '-lnt', 'sport = :443']).stdout.strip():
        raise NetworkCheckError('fixture port443 is already in use')
    return evidence


def client_definitions(state):
    clients = [
        {'name': 'allow', 'namespace': 'cfvm-allow', 'root_link': 'cfvm-va', 'peer_link': 'cfvm-ca',
         'ipv4': ('192.0.2.1/28', '192.0.2.2/28'),
         'ipv6': ('2001:db8:1::1/64', '2001:db8:1::2/64')},
        {'name': 'deny', 'namespace': 'cfvm-deny', 'root_link': 'cfvm-vd', 'peer_link': 'cfvm-cd',
         'ipv4': ('10.203.1.1/30', '10.203.1.2/30'),
         'ipv6': ('2001:db9:1::1/64', '2001:db9:1::2/64')},
    ]
    try:
        ranges = [ipaddress.ip_network(cidr) for cidr in state['ranges']]
        for client in clients:
            for family in ('ipv4', 'ipv6'):
                address = ipaddress.ip_interface(client[family][1]).ip
                permitted = any(address.version == cidr.version and address in cidr for cidr in ranges)
                if permitted != (client['name'] == 'allow'):
                    raise ValueError()
    except (KeyError, TypeError, ValueError) as exc:
        raise NetworkCheckError('expected disposable IPv4/IPv6 fixture ranges are missing') from exc
    return clients


def sha(value):
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def baseline():
    private = STATE.parent
    files = [CONFIG, *[private / name for name in ('state.json', 'pending.json', 'backup.json', 'journal.json', 'install-journal.json')]]
    return {'ufw': sha(run(['ufw', 'show', 'added']).stdout),
            'ufw_numbered': sha(run(['ufw', 'status', 'numbered']).stdout),
            'sshd': sha(run(['sshd', '-T']).stdout),
            'nginx': sha(run(['nginx', '-T']).stdout),
            'files': {str(path): sha(path.read_bytes()) if path.exists() else None for path in files}}


class Harness:
    def __init__(self):
        self.namespaces = []
        self.links = []
        self.created_config = False
        self.cases = []

    def create_client(self, client):
        if any(line.split()[0] == client['namespace']
               for line in run(['ip', 'netns', 'list']).stdout.splitlines()):
            raise NetworkCheckError('fixture namespace already exists')
        for link in (client['root_link'], client['peer_link']):
            if run(['ip', 'link', 'show', 'dev', link], check=False).returncode == 0:
                raise NetworkCheckError('fixture network interface already exists')
        run(['ip', 'netns', 'add', client['namespace']])
        self.namespaces.append(client['namespace'])
        run(['ip', 'link', 'add', client['root_link'], 'type', 'veth', 'peer', 'name', client['peer_link']])
        self.links.append(client['root_link'])
        run(['ip', 'link', 'set', client['peer_link'], 'netns', client['namespace']])
        run(['ip', 'link', 'set', client['root_link'], 'up'])
        run(['ip', 'netns', 'exec', client['namespace'], 'ip', 'link', 'set', 'lo', 'up'])
        run(['ip', 'netns', 'exec', client['namespace'], 'ip', 'link', 'set', client['peer_link'], 'up'])
        for family, flag in [('ipv4', '-4'), ('ipv6', '-6')]:
            extra = ['nodad'] if family == 'ipv6' else []
            run(['ip', flag, 'addr', 'add', client[family][0], 'dev', client['root_link'], *extra])
            run(['ip', 'netns', 'exec', client['namespace'], 'ip', flag, 'addr', 'add', client[family][1],
                 'dev', client['peer_link'], *extra])

    def install_nginx_fixture(self):
        if TEMP_CONFIG.exists() or TEMP_CONFIG.is_symlink():
            raise NetworkCheckError('temporary nginx fixture already exists')
        text = ('geo $realip_remote_addr $cf_vm_network_peer {\n default 0;\n include ' + SHARED + '/cloudfront-geo.conf;\n}\n'
                'map $http_x_cfsync_vm_origin $cf_vm_network_origin { default 0; "' + TOKEN + '" 1; }\n'
                'server {\n listen 0.0.0.0:443;\n listen [::]:443 ipv6only=on;\n'
                ' location / {\n if ($cf_vm_network_peer = 0) { return 403; }\n'
                ' if ($cf_vm_network_origin = 0) { return 403; }\n'
                ' return 200 "cf-vm-network-ok|$remote_addr|$realip_remote_addr";\n }\n}\n')
        with TEMP_CONFIG.open('x') as stream:
            self.created_config = True
            stream.write(text)
        os.chmod(TEMP_CONFIG, 0o644)
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx.service'])

    def probe(self, client, family, headers=None, ssh=False):
        payload = {'address': str(ipaddress.ip_interface(client[family][0]).ip),
                   'kind': 'ssh' if ssh else 'http', 'headers': headers or {}}
        output = run(['ip', 'netns', 'exec', client['namespace'], '/usr/bin/python3', '-c', PROBE],
                     data=json.dumps(payload)).stdout
        try:
            return json.loads(output)
        except ValueError as exc:
            raise NetworkCheckError('invalid network probe result') from exc

    def require(self, condition, case):
        if not condition:
            raise NetworkCheckError('network acceptance case failed: ' + case)
        self.cases.append(case)

    def verify_clients(self, clients):
        allowed, denied = clients
        for family in ('ipv4', 'ipv6'):
            # SSH proves each namespace reaches the real VM before a blocked443
            # result can count as firewall evidence.
            for client in clients:
                self.require(self.probe(client, family, ssh=True).get('ssh') is True,
                             family + '-' + client['name'] + '-ssh-preserved')
            headers = {'X-Cfsync-Vm-Origin': TOKEN}
            response = self.probe(allowed, family, headers)
            peer = str(ipaddress.ip_interface(allowed[family][1]).ip)
            self.require(response == {'status': 200, 'body': 'cf-vm-network-ok|' + peer + '|' + peer},
                         family + '-allowed-valid-origin')
            self.require(self.probe(allowed, family).get('status') == 403, family + '-missing-origin-rejected')
            self.require(self.probe(allowed, family, {'X-Cfsync-Vm-Origin': 'wrong-public-fixture'}).get('status') == 403,
                         family + '-wrong-origin-rejected')
            spoof = {**headers, 'X-Forwarded-For': '203.0.113.222'}
            self.require(self.probe(allowed, family, spoof) ==
                         {'status': 200, 'body': 'cf-vm-network-ok|203.0.113.222|' + peer},
                         family + '-geo-retains-original-peer-with-xff')
            self.require(self.probe(denied, family, headers).get('blocked') is True,
                         family + '-outside-range-firewall-blocked')
            self.require(self.probe(denied, family, {**headers, 'X-Forwarded-For': peer}).get('blocked') is True,
                         family + '-outside-range-spoofed-xff-firewall-blocked')

    def cleanup(self):
        failed = False
        if self.created_config:
            try:
                TEMP_CONFIG.unlink()
                run(['nginx', '-t'])
                run(['systemctl', 'reload', 'nginx.service'])
            except (OSError, NetworkCheckError):
                failed = True
        for namespace in reversed(self.namespaces):
            if run(['ip', 'netns', 'delete', namespace], check=False).returncode:
                failed = True
        for link in reversed(self.links):
            if run(['ip', 'link', 'show', 'dev', link], check=False).returncode == 0:
                if run(['ip', 'link', 'delete', link], check=False).returncode:
                    # Namespace teardown can remove the peer asynchronously
                    # between show and delete. Require final absence rather
                    # than treating an already-removed owned veth as a leak.
                    if run(['ip', 'link', 'show', 'dev', link], check=False).returncode == 0:
                        failed = True
        if failed:
            raise NetworkCheckError('fixture cleanup failed; disposable VM requires inspection')


def main():
    harness = None
    try:
        evidence = check_environment()
        config = json.loads(CONFIG.read_text())
        if (config['nginx']['shared_dir'] != SHARED or not config['nginx']['enabled']
                or config['firewall'] != {'backend': 'ufw', 'ports': [443]}):
            raise NetworkCheckError('run the disposable live transaction fixture first')
        for name in ('journal.json', 'install-journal.json'):
            if (STATE.parent / name).exists():
                raise NetworkCheckError('recovery evidence must be resolved before network checks')
        clients = client_definitions(json.loads(STATE.read_text()))
        before = baseline()
        harness = Harness()
        try:
            for client in clients:
                harness.create_client(client)
            harness.install_nginx_fixture()
            harness.verify_clients(clients)
        finally:
            harness.cleanup()
        if baseline() != before:
            raise NetworkCheckError('firewall, SSH, synchronization state, or nginx changed during network verification')
        print(json.dumps({'vm_network_checks': 'passed', 'cases': harness.cases,
                          'ipv4_ipv6_ingress': True, 'ufw_ssh_state_nginx_unchanged': True,
                          'origin_header_is_public_fixture': True, **evidence}))
        return 0
    except NetworkCheckError as exc:
        # NetworkCheckError messages contain only fixed fixture stages/case
        # names. Never serialize raw subprocess, configuration or OS errors.
        print(json.dumps({'error': 'vm_network_acceptance_failed', 'reason': str(exc),
                          'passed_cases': harness.cases if harness else []}), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError):
        print(json.dumps({'error': 'vm_network_acceptance_failed'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
