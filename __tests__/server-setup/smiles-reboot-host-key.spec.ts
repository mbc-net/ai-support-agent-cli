import {buildInventory,managedTargetKnownHost} from '../../src/server-setup/server-setup-connection'
import type {SshExecCredential} from '../../src/types'
const key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const credential:SshExecCredential={hostId:'host',hostname:'133.18.114.57',port:22,username:'mbc',authType:'privateKey',privateKey:'synthetic-only'}
const host=(strict=false)=>JSON.parse(buildInventory(credential,'/tmp/fixture-key','/tmp/fixture-known-hosts','linux',strict)).target.hosts[credential.hostname]
describe('managed Target SSH pin inventory',()=>{
 test('generic default inventory remains TOFU with its existing path',()=>{
  expect(host().ansible_ssh_common_args).toBe('-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/fixture-known-hosts')
  expect(host()).not.toHaveProperty('ansible_ssh_args');expect(host()).not.toHaveProperty('ansible_host_key_checking')
 })
 test('managed options precede common args and cannot use TOFU/global trust/DNS/multiplex fallback',()=>{
  const h=host(true)
  expect(h.ansible_ssh_args).toBe(h.ansible_ssh_common_args)
  for(const value of ['-F /dev/null','StrictHostKeyChecking=yes','UserKnownHostsFile=/tmp/fixture-known-hosts','GlobalKnownHostsFile=/dev/null','HostKeyAlgorithms=ssh-ed25519','VerifyHostKeyDNS=no','UpdateHostKeys=no','ControlMaster=no','ControlPersist=no','ControlPath=none','IdentityAgent=none','IdentitiesOnly=yes','BatchMode=yes'])expect(h.ansible_ssh_args).toContain(value)
  expect(h.ansible_ssh_args).not.toMatch(/accept-new|StrictHostKeyChecking=no/);expect(h.ansible_connection).toBe('ssh');expect(h.ansible_ssh_extra_args).toBe('');expect(h.ansible_ssh_host_key_checking).toBe(true);expect(h.ansible_host_key_checking).toBe(true);expect(h.ansible_ssh_executable).toBe('/usr/bin/ssh')
 })
 test('generic Tailscale and Windows connection options stay unchanged',()=>{
  const h=JSON.parse(buildInventory({...credential,connectionType:'tailscale',tailnetHostname:'fixture.tailnet'},'/tmp/key','/tmp/known','windows')).target.hosts[credential.hostname]
  expect(h.ansible_ssh_common_args).toContain('StrictHostKeyChecking=accept-new');expect(h.ansible_ssh_common_args).toContain('ProxyCommand=');expect(h.ansible_shell_type).toBe('powershell');expect(h).not.toHaveProperty('ansible_ssh_args')
 })
 test('known_hosts contains only the approved canonical Ed25519 public key',()=>expect(managedTargetKnownHost(credential,key)).toBe('133.18.114.57 '+key+'\n'))
 test.each([undefined,'',key+'\notherhost '+key,key+' comment','ssh-rsa AAAA','ssh-ed25519 AAAA'])('unknown or injected public key is refused: %p',value=>expect(()=>managedTargetKnownHost(credential,value)).toThrow('SMILES_REBOOT_TARGET_HOST_KEY_REFUSED'))
 test.each([{hostname:'140.227.124.149'},{port:2222},{connectionType:'tailscale'}])('pin is not reusable for an unknown route: %p',change=>expect(()=>managedTargetKnownHost({...credential,...change} as SshExecCredential,key)).toThrow())
 test.each(['relative-path','/tmp/path with space','/tmp/key -o StrictHostKeyChecking=no'])('strict inventory rejects an ambiguous known-hosts argument: %s',known=>expect(()=>buildInventory(credential,'/tmp/key',known,'linux',true)).toThrow())
})
