/** Root opt-in synthetic LOCAL callback proof. No remote host/API/secret inputs. */
import {execFileSync} from 'child_process'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'fs'
import {tmpdir} from 'os'
import {join,resolve} from 'path'
import {dump} from 'js-yaml'
import {parseTargetMetadata,type RecoveryProfile} from '../../src/server-setup/smiles-reboot-profile'
const native=process.env.SMILES_REBOOT_ANSIBLE_NATIVE==='1'?describe:describe.skip
native('actual bundled JSON callback',()=>{
 test('one named public command stdout survives success; precheck stdout ignored',()=>{
  const root=mkdtempSync(join(tmpdir(),'smiles-reboot-callback-'))
  try{
   const local=join(root,'local');const remote=join(root,'remote');mkdirSync(local,{mode:0o700});mkdirSync(remote,{mode:0o700})
   const result={status:'prepared',session_run_id:'a'.repeat(32)}
   const play=[{hosts:'all',gather_facts:false,tasks:[{name:'Synthetic precheck output','ansible.builtin.command':{argv:['/usr/bin/printf','0']}},{name:'SMILES_REBOOT_PUBLIC_RESULT','ansible.builtin.command':{argv:['/usr/bin/printf','%s',JSON.stringify(result)]}}]}]
   const path=join(root,'public-play.yml');writeFileSync(path,dump(play),{mode:0o600})
   const stdout=execFileSync(process.env.SMILES_REBOOT_ANSIBLE_PLAYBOOK??'ansible-playbook',['-i','localhost,','-c','local',path],{timeout:30000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin:/usr/local/bin',ANSIBLE_STDOUT_CALLBACK:'json',ANSIBLE_CALLBACK_PLUGINS:resolve(__dirname,'../../ansible/callback_plugins'),ANSIBLE_LOCAL_TEMP:local,ANSIBLE_REMOTE_TEMP:remote,ANSIBLE_NOCOLOR:'1'}}).toString()
   const p={stepId:'resume',runId:result.session_run_id,jobId:'11111111-1111-4111-8111-111111111111',parentRunId:'c'.repeat(32),sourceBootId:'22222222-2222-4222-8222-222222222222',targetBootId:'33333333-3333-4333-8333-333333333333',profileSha256:'d'.repeat(64)} as RecoveryProfile
   expect(parseTargetMetadata(stdout,p).publicResult).toEqual(result)
  }finally{rmSync(root,{recursive:true,force:true})}
 },40000)
})
