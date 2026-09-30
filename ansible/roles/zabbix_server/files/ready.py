#!/usr/bin/python3
"""Require a Zabbix statistics response, rather than an occupied TCP port."""
import json
import socket
import struct
import sys


def receive(sock, size):
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ValueError('Truncated statistics response')
        data.extend(chunk)
    return bytes(data)


def ready(port, version):
    request = json.dumps({'request': 'zabbix.stats'}).encode()
    with socket.create_connection(('127.0.0.1', int(port)), timeout=5) as sock:
        sock.sendall(b'ZBXD\x01' + struct.pack('<Q', len(request)) + request)
        header = receive(sock, 13)
        if header[:5] != b'ZBXD\x01':
            raise ValueError('Invalid statistics protocol header')
        size = struct.unpack('<Q', header[5:])[0]
        if size > 1024 * 1024:
            raise ValueError('Statistics response exceeds limit')
        response = json.loads(receive(sock, size))
        if response.get('response') != 'success' or not isinstance(response.get('data'), dict):
            raise ValueError('Server statistics request failed')
        if not str(response['data'].get('version', '')).startswith(version + '.'):
            raise ValueError('Statistics response does not match the selected LTS')
    print('Zabbix server statistics ready')


if __name__ == '__main__':
    try:
        ready(sys.argv[1], sys.argv[2])
    except Exception:
        print('Zabbix statistics readiness check failed; check service, DB connectivity and StatsAllowedIP.', file=sys.stderr)
        sys.exit(1)
