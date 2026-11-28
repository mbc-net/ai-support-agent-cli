/** Root-executed native fixture only; no Docker/host setup here.
 * Endpoint/HostKeyAlias are explicit fixture platform facades. Production strict
 * inventory options and OpenSSH/Ansible perform all authentication decisions.
 * Root supplies a disposable loopback sshd and synthetic authentication keys.
 */
import {spawnSync} from 'child_process'
import {lstatSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {buildInventory,managedTargetKnownHost} from '../../src/server-setup/server-setup-connection'
import type {SshExecCredential} from '../../src/types'
const enabled=process.env.SMILES_TARGET_SSH_PIN_NATIVE==='1'
;(enabled?describe:describe.skip)('native managed Target SSH pin',()=>{
 test('correct key succeeds; different/unknown key fails before the marker, despite poisoned SSH defaults',()=>{
  const path=process.env.SMILES_TARGET_SSH_PIN_FIXTURE
  if(!path||!/^\/private\/tmp\/smiles-target-ssh-pin-[a-f0-9-]+\/fixture\.json$/.test(path))throw new Error('NATIVE_SSH_PIN_FIXTURE_REQUIRED')
  const metaStat=lstatSync(path);if(!metaStat.isFile()||metaStat.isSymbolicLink()||metaStat.size>8192)throw new Error('NATIVE_SSH_PIN_FIXTURE_REFUSED')
  const f=JSON.parse(readFileSync(path,'utf8'))
  if(Object.keys(f).sort().join(',')!=='ansiblePlaybook,host,hostPublicKey,port,privateKeyFile,revision,username,wrongHostPublicKey'||f.revision!=='smiles-target-ssh-pin-native-v1'||f.host!=='127.0.0.1'||!Number.isInteger(f.port)||f.port<1024||f.port>65535||typeof f.username!=='string'||!/^fixture[a-z0-9_-]*$/.test(f.username)||typeof f.privateKeyFile!=='string'||f.privateKeyFile!==path.slice(0,-'fixture.json'.length)+'client-key'||typeof f.ansiblePlaybook!=='string'||!/^\/private\/tmp\/[A-Za-z0-9_./-]+\/bin\/ansible-playbook$/.test(f.ansiblePlaybook)||f.hostPublicKey===f.wrongHostPublicKey)throw new Error('NATIVE_SSH_PIN_FIXTURE_REFUSED')
  const key=lstatSync(f.privateKeyFile);if(!key.isFile()||key.isSymbolicLink()||(key.mode&0o777)!==0o600||key.uid!==process.getuid?.())throw new Error('NATIVE_SSH_PIN_SYNTHETIC_KEY_REFUSED')
  const c:SshExecCredential={hostId:'fixture',hostname:'133.18.114.57',port:22,username:f.username,authType:'privateKey',privateKey:'NOT_READ_BY_TEST'}
  // Validate both public keys through the production parser before subprocesses.
  managedTargetKnownHost(c,f.hostPublicKey);managedTargetKnownHost(c,f.wrongHostPublicKey)
  const work=mkdtempSync(join(tmpdir(),'smiles-pin-native-'))
  try{
   mkdirSync(join(work,'tmp'),{mode:0o700});writeFileSync(join(work,'ansible.cfg'),'[defaults]\nretry_files_enabled=False\n[ssh_connection]\nretries=0\n',{mode:0o600})
   writeFileSync(join(work,'play.yml'),'- hosts: target\n  gather_facts: false\n  tasks:\n    - name: Native strict SSH probe\n      ansible.builtin.raw: /usr/bin/printf SMILES_PIN_NATIVE_MARKER\n',{mode:0o600})
   for(const kind of ['correct','wrong','unknown'] as const){
    const known=join(work,kind+'-known_hosts');writeFileSync(known,kind==='unknown'?'':managedTargetKnownHost(c,kind==='correct'?f.hostPublicKey:f.wrongHostPublicKey),{mode:0o600,flag:'wx'})
    const inv=JSON.parse(buildInventory(c,f.privateKeyFile,known,'linux',true)),h=inv.target.hosts[c.hostname]
    // Only endpoint mapping differs from production, inside the owned fixture.
    h.ansible_host=f.host;h.ansible_port=f.port;h.ansible_ssh_args+=' -o HostKeyAlias=133.18.114.57';h.ansible_ssh_common_args+=' -o HostKeyAlias=133.18.114.57'
    const inventory=join(work,kind+'-inventory.yml');writeFileSync(inventory,JSON.stringify(inv),{mode:0o600})
    const result=spawnSync(f.ansiblePlaybook,['-i',inventory,join(work,'play.yml')],{encoding:'utf8',timeout:30000,maxBuffer:262144,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:work,ANSIBLE_CONFIG:join(work,'ansible.cfg'),ANSIBLE_LOCAL_TEMP:join(work,'tmp'),ANSIBLE_STDOUT_CALLBACK:'json',ANSIBLE_CALLBACK_PLUGINS:join(__dirname,'../../ansible/callback_plugins'),ANSIBLE_TRANSPORT:'local',ANSIBLE_HOST_KEY_CHECKING:'False',ANSIBLE_SSH_ARGS:'-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',ANSIBLE_SSH_COMMON_ARGS:'-o StrictHostKeyChecking=no',ANSIBLE_SSH_EXTRA_ARGS:'-o StrictHostKeyChecking=no'}})
    let callback:any;try{callback=JSON.parse(result.stdout)}catch{throw new Error('NATIVE_SSH_PIN_CALLBACK_INVALID')}
    const outcomes=(callback.plays??[]).flatMap((p:any)=>(p.tasks??[]).flatMap((t:any)=>Object.values(t.hosts??{}))) as any[]
    const marked=outcomes.some(o=>o.stdout==='SMILES_PIN_NATIVE_MARKER')
    if(kind==='correct'){expect(result.status).toBe(0);expect(marked).toBe(true)}else{expect(result.status).not.toBe(0);expect(marked).toBe(false);expect(outcomes.some(o=>/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/.test(String(o.msg??'')))).toBe(true)}
   }
  }finally{rmSync(work,{recursive:true,force:true})}
 },100000)
})
