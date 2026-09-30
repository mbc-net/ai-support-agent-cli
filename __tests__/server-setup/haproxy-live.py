"""Destructive live test: run ONLY on a disposable Ubuntu systemd host as root.

Requires no HAProxy initially to cover installation; reruns also work.
Usage: python3 __tests__/server-setup/haproxy-live.py
"""
import importlib.util
import json
from pathlib import Path
import socket
import socketserver
import subprocess
import threading
import time
import urllib.request

spec=importlib.util.spec_from_file_location('setup', Path(__file__).resolve().parents[2] / 'ansible/roles/haproxy/files/haproxy_setup.py')
h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
class HTTP(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(8192)
        body=self.server.marker
        self.request.sendall(b'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
class Echo(socketserver.BaseRequestHandler):
    def handle(self): self.request.sendall(self.server.marker+self.request.recv(1024))
def server(port, marker, handler):
    s=socketserver.ThreadingTCPServer(('127.0.0.1',port),handler); s.marker=marker
    threading.Thread(target=s.serve_forever,daemon=True).start(); return s
servers=[server(9001,b'one',HTTP),server(9002,b'two',HTTP),server(9003,b'echo:',Echo)]
params={'mode':'http','bind_address':'127.0.0.1','bind_port':8080,'backends':[{'name':'one','address':'localhost','port':9001},{'name':'two','address':'127.0.0.1','port':9002}]}
host=h.Host()
result=h.apply(params,host); assert result['changed']; print('PASS initial installation and systemd startup')
assert host.service_state()=={'active':True,'enabled':True}
def request():
    with urllib.request.urlopen('http://127.0.0.1:8080',timeout=3) as response: return response.read()
assert set(request() for _ in range(10))=={b'one',b'two'}; print('PASS HTTP roundrobin and IPv4 DNS')
backups=len(list(host.backups.iterdir()))
assert h.apply(params,host)['changed'] is False
assert len(list(host.backups.iterdir()))==backups; print('PASS idempotence without backup')
servers[1].shutdown(); servers[1].server_close(); time.sleep(7)
assert set(request() for _ in range(10))=={b'one'}; print('PASS unavailable backend excluded')
params['backends']=params['backends'][:1]
h.apply(params,host)
assert request()==b'one'; print('PASS HTTP reload applies changed backends')
old=host.config.read_bytes(); before=host.service_state()
class IgnoredReload(h.Host):
    def service(self, action):
        if action != 'reload': super().service(action)
try:
    h.apply(dict(params, backends=[{'name':'changed','address':'127.0.0.1','port':9002}]), IgnoredReload())
    raise AssertionError('old worker accepted as a successful reload')
except RuntimeError as e:
    assert 'recovery=completed' in str(e), str(e)
assert host.config.read_bytes()==old and request()==b'one'
print('PASS unchanged old worker rejected and old config restored')
collision=socket.socket(); collision.bind(('127.0.0.1',8081)); collision.listen()
try:
    h.apply(dict(params,bind_port=8081),host)
    raise AssertionError('port conflict not detected')
except RuntimeError as e:
    assert 'recovery=completed' in str(e), str(e)
assert host.config.read_bytes()==old and host.service_state()==before
assert request()==b'one'; print('PASS real port conflict restores config and service state')
collision.close()
params={'mode':'tcp','bind_address':'127.0.0.1','bind_port':8080,'backends':[{'name':'echo','address':'127.0.0.1','port':9003}]}
h.apply(params,host)
with socket.create_connection(('127.0.0.1',8080),timeout=3) as c:
    c.sendall(b'hello'); assert c.recv(1024)==b'echo:hello'
print('PASS TCP forwarding and reload')
assert h.apply(params,host)['changed'] is False
print('PASS TCP idempotence')
print('HAProxy live checks complete')
