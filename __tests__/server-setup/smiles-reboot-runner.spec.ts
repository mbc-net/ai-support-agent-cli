jest.mock('../../src/server-setup/smiles-reboot-runtime',()=>({sourceRuntimeReady:jest.fn()}))
jest.mock('../../src/server-setup/ssh-source-ip-sync',()=>({freshSsh:jest.fn()}))
jest.mock('../../src/server-setup/server-setup-runner',()=>({executeServerSetupAnsible:jest.fn()}))
import {createHash} from 'crypto'
import {execFileSync} from 'child_process'
import {executeServerSetupAnsible} from '../../src/server-setup/server-setup-runner'
import bodies from '../fixtures/smiles-reboot/target-bodies.json'
import {runSmilesRebootProfile} from '../../src/server-setup/smiles-reboot-runner'
import {sourceRuntimeReady} from '../../src/server-setup/smiles-reboot-runtime'
import {freshSsh} from '../../src/server-setup/ssh-source-ip-sync'
import {SOURCE_PROGRAM,SOURCE_HELPER_SHA256} from '../../src/server-setup/smiles-reboot-source-program'
import {SOURCE_PROFILE_BODY,SOURCE_PROFILE_SHA256,TARGET_PROFILE_SHA256,type RecoveryProfile} from '../../src/server-setup/smiles-reboot-profile'
import type {ApiClient} from '../../src/api-client'
import type {ServerSetupExecPayload} from '../../src/types'
const publicKey='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
function profile():RecoveryProfile{return {revision:'smiles-reboot-profile-v1',executorProfile:'smiles-source-python38-v1',jobId:'11111111-1111-4111-8111-111111111111',stepId:'source-observe',runId:'a'.repeat(32),sourceBootId:'22222222-2222-4222-8222-222222222222',targetBootId:'33333333-3333-4333-8333-333333333333',parentRunId:'b'.repeat(32),oldTransportRunId:'b'.repeat(32),accountOwnerRunId:'8d6f037733724fbe969cf513e11b4b9f',profileSha256:SOURCE_PROFILE_SHA256,publicInput:{public_contract:{purpose:'follow',ttl_seconds:43200,public_key:publicKey,target_host_key:publicKey,source_ca_pem:'-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n'},continuity_intent:null,source_reboot_receipt:null,source_closure_receipt:null,source_key_receipt:null}}}
function payload():ServerSetupExecPayload{return {executionId:'execution',sshHostId:'host',body:SOURCE_PROFILE_BODY,dispatchMode:'ecs_oneshot',recoveryProfile:profile()}}
function client(){return {getServerSetupSshCredential:jest.fn().mockResolvedValue({hostId:'host',hostname:'140.227.124.149',port:22,username:'mbc',authType:'privateKey',privateKey:'PRIVATE_MANAGEMENT_KEY',hostKeyFingerprint:'SHA256:'+'A'.repeat(43)}),getServerSetupVariables:jest.fn()} }
describe('dedicated source profile runner',()=>{
 const env=process.env.AGENT_MODE
 beforeEach(()=>{process.env.AGENT_MODE='oneshot';jest.clearAllMocks();jest.mocked(sourceRuntimeReady).mockImplementation(()=>undefined)})
 afterAll(()=>{if(env===undefined)delete process.env.AGENT_MODE;else process.env.AGENT_MODE=env})
 test('resident or server resident route refuses BEFORE any credential',async()=>{
  for(const local of ['resident','oneshot']){const c=client();const p=payload();if(local==='oneshot')p.dispatchMode='resident_agent';process.env.AGENT_MODE=local
   const result=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(false);expect(c.getServerSetupSshCredential).not.toHaveBeenCalled()
  }
 })
 test('secret memory preflight refuses before JIT delivery',async()=>{const c=client();jest.mocked(sourceRuntimeReady).mockImplementation(()=>{throw new Error('unsafe limits')});const result=await runSmilesRebootProfile(payload(),{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(false);expect(c.getServerSetupSshCredential).not.toHaveBeenCalled()})
 test.each(['windows','unknown'])('non-Linux profile refuses before JIT: %s',os=>{const c=client();return runSmilesRebootProfile({...payload(),targetOs:os as 'windows'},{commandId:'command',agentId:'agent',client:c as unknown as ApiClient}).then(result=>{expect(result.success).toBe(false);expect(c.getServerSetupSshCredential).not.toHaveBeenCalled()})})
 test('observe gets only bound SSH credential and returns typed actual new boot',async()=>{
  const c=client();const observed='44444444-4444-4444-8444-444444444444';jest.mocked(freshSsh).mockResolvedValue(JSON.stringify({status:'observed',source_boot_id:observed,source_ip:'140.227.124.149',helper_sha256:SOURCE_HELPER_SHA256}))
  const result=await runSmilesRebootProfile({...payload(),targetOs:'linux'},{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(true);expect((result as {data:{serverSetupLocalTermination:unknown}}).data.serverSetupLocalTermination).toEqual({processClosed:true,executionId:'execution',sshHostId:'host'});expect(result.serverSetupConfigurationCompletion).toEqual({executionId:'execution',evidence:{kind:'completed',sshHostId:'host',processClosed:true}});expect(c.getServerSetupSshCredential).toHaveBeenCalledWith('command','agent');expect(c.getServerSetupVariables).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('PRIVATE_MANAGEMENT_KEY')
  const args=jest.mocked(freshSsh).mock.calls[0];expect(args[2]).toContain('/usr/bin/python3.8 -I -S -B');expect(Object.keys(JSON.parse(args[3]))).toEqual(['profile']);expect((result as {data:{recoveryMetadata:{publicResult:{source_boot_id:string}}}}).data.recoveryMetadata.publicResult.source_boot_id).toBe(observed)
 })
 test.each([{hostname:'133.18.114.57'},{hostId:'different'},{username:'root'},{hostKeyFingerprint:undefined},{authType:'password'}])('wrong credential facts fail before SSH',async change=>{
  const c=client();c.getServerSetupSshCredential.mockResolvedValue({...await c.getServerSetupSshCredential(),...change});const result=await runSmilesRebootProfile(payload(),{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(false);expect(freshSsh).not.toHaveBeenCalled()
 })
 test('unknown returned secret is rejected and failure never echoes SSH exception',async()=>{
  const c=client();jest.mocked(freshSsh).mockResolvedValue('{"PRIVATE":"SECRET"}');let result=await runSmilesRebootProfile(payload(),{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result).toEqual({success:false,error:'SMILES_REBOOT_PROFILE_REFUSED'})
  jest.mocked(freshSsh).mockRejectedValue(new Error('PRIVATE_CREDENTIAL_SECRET'));result=await runSmilesRebootProfile(payload(),{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(JSON.stringify(result)).not.toContain('PRIVATE')
 })
 test.each(['source-observe','source-proof','close-source'] as const)('readonly %s closes a failed snapshot only after real lifecycle notification',async stepId=>{
  const c=client();const p=payload();p.recoveryProfile!.stepId=stepId
  jest.mocked(freshSsh).mockImplementation(async(_c,_f,_cmd,_input,_timeout,lifecycle)=>{setImmediate(()=>lifecycle?.onClosed());throw new Error('PRIVATE_FAILURE')})
  const result=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient})
  expect(result.success).toBe(false);expect(result.data).toEqual({serverSetupLocalTermination:{processClosed:true,executionId:'execution',sshHostId:'host'}})
  expect(result.serverSetupConfigurationCompletion).toEqual({executionId:'execution',evidence:{kind:'completed',sshHostId:'host',processClosed:true}})
  expect(c.getServerSetupVariables).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('PRIVATE_FAILURE')
 })
 test('destroy/timeout without observed close gives no failure completion',async()=>{
  jest.useFakeTimers();const c=client();jest.mocked(freshSsh).mockRejectedValue(new Error('timeout after destroy'))
  const pending=runSmilesRebootProfile(payload(),{commandId:'command',agentId:'agent',client:c as unknown as ApiClient})
  await jest.advanceTimersByTimeAsync(1001);expect(await pending).toEqual({success:false,error:'SMILES_REBOOT_PROFILE_REFUSED'});jest.useRealTimers()
 })
 test('start-source uses Source-local staged key, with zero variables JIT and no private stdin',async()=>{
  const c=client();const p=payload();const v=p.recoveryProfile!;v.stepId='start-source';const now=Math.floor(Date.now()/1000);const fp='SHA256:'+createHash('sha256').update(Buffer.from(publicKey.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')
  v.publicInput.public_contract={revision:'smiles-reverse-tunnel-public-v1',run_id:v.runId,purpose:'follow',ttl_seconds:43200,issued_at_utc:now,deadline_utc:now+43200,source_ip:'140.227.124.149',target_ip:'133.18.114.57',ssh_user:'smiles-tunnel',public_key:publicKey,source_key_fingerprint:fp,target_host_key:publicKey,target_key_fingerprint:fp,listen:{host:'127.0.0.1',port:23306},destination:{host:'127.0.0.1',port:3306}}
  v.publicInput.source_key_receipt={revision:'smiles-source-key-stage-v1',status:'key_prepared',run_id:v.runId,job_id:v.jobId,account_owner_run_id:v.accountOwnerRunId,source_boot_id:v.sourceBootId,helper_sha256:SOURCE_HELPER_SHA256,public_key:publicKey,source_key_fingerprint:fp,stage_nonce:'a'.repeat(64),deadline_utc:now+600}
  jest.mocked(freshSsh).mockResolvedValue(JSON.stringify({status:'started',run_id:v.runId,source_boot_id:v.sourceBootId,helper_sha256:SOURCE_HELPER_SHA256}))
  const result=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(true);expect(c.getServerSetupVariables).not.toHaveBeenCalled();expect(freshSsh).toHaveBeenCalledTimes(1);expect(Object.keys(JSON.parse(jest.mocked(freshSsh).mock.calls[0][3]))).toEqual(['profile']);expect(jest.mocked(freshSsh).mock.calls[0][5]).toBeUndefined()
  jest.mocked(freshSsh).mockRejectedValue(new Error('unknown mutation result'));expect(await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient})).toEqual({success:false,error:'SMILES_REBOOT_PROFILE_REFUSED'});expect(c.getServerSetupVariables).not.toHaveBeenCalled()
 })
 test('source-keygen returns only a bound public receipt and never resolves key variables',async()=>{
  const c=client();const p=payload();const v=p.recoveryProfile!;v.stepId='source-keygen'
  const fp='SHA256:'+createHash('sha256').update(Buffer.from(publicKey.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')
  const receipt={revision:'smiles-source-key-stage-v1',status:'key_prepared',run_id:v.runId,job_id:v.jobId,account_owner_run_id:v.accountOwnerRunId,source_boot_id:v.sourceBootId,helper_sha256:SOURCE_HELPER_SHA256,public_key:publicKey,source_key_fingerprint:fp,stage_nonce:'a'.repeat(64),deadline_utc:Math.floor(Date.now()/1000)+600}
  jest.mocked(freshSsh).mockResolvedValue(JSON.stringify(receipt));const result=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(true);expect(c.getServerSetupVariables).not.toHaveBeenCalled();expect(jest.mocked(freshSsh).mock.calls[0][5]).toBeUndefined()
  jest.mocked(freshSsh).mockRejectedValue(new Error('unknown key generation result'));expect(await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient})).toEqual({success:false,error:'SMILES_REBOOT_PROFILE_REFUSED'})
 })
 test('target ECS stays on strict ordinary Ansible and only typed public overrides',async()=>{
  const c=client();const p=payload();p.dispatchMode='ecs_oneshot';process.env.AGENT_MODE='oneshot';p.recoveryProfile={...profile(),executorProfile:'smiles-target-ansible-v1',profileSha256:TARGET_PROFILE_SHA256,stepId:'observe'};p.body=bodies.observe
  c.getServerSetupSshCredential.mockResolvedValue({...await c.getServerSetupSshCredential(),hostname:'133.18.114.57'});c.getServerSetupVariables.mockResolvedValue({variables:{SMILES_TUNNEL_RUN_ID:'old',SMILES_SESSION_INTENT:'old',SMILES_REBOOT_SOURCE_RECEIPT_JSON:'old'},secretNames:[]});(c as unknown as {getTenantCode:()=>string}).getTenantCode=()=> 'tenant'
  jest.mocked(executeServerSetupAnsible).mockResolvedValue({success:true,data:{public:true}})
  const result=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(true);expect(sourceRuntimeReady).not.toHaveBeenCalled();expect(freshSsh).not.toHaveBeenCalled();expect(executeServerSetupAnsible).toHaveBeenCalledWith(expect.objectContaining({mode:'ecs',targetOs:'linux',secretNames:[],variables:expect.objectContaining({SMILES_TUNNEL_RUN_ID:p.recoveryProfile.runId,SMILES_SESSION_INTENT:'null',SMILES_REBOOT_SOURCE_RECEIPT_JSON:'null',SMILES_REBOOT_SOURCE_CLOSURE_JSON:'null'})}))
  expect(result.serverSetupConfigurationCompletion).toBeUndefined()
  const typed={recoveryMetadata:{synthetic:'public'},serverSetupLocalTermination:{processClosed:true,executionId:'execution',sshHostId:'host'}}
  jest.mocked(executeServerSetupAnsible).mockResolvedValue({success:true,data:typed})
  const closed=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(closed.data).toBe(typed);expect(closed.serverSetupConfigurationCompletion).toEqual({executionId:'execution',evidence:{kind:'completed',sshHostId:'host',processClosed:true}})
  jest.mocked(executeServerSetupAnsible).mockClear();c.getServerSetupVariables.mockResolvedValue({variables:{PRIVATE:'SECRET'},secretNames:['PRIVATE']});expect((await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient})).success).toBe(false);expect(executeServerSetupAnsible).not.toHaveBeenCalled()
 })
 test('target resident route refuses before JIT even with pinned public body',async()=>{const c=client();const p=payload();p.dispatchMode='resident_agent';p.recoveryProfile={...profile(),executorProfile:'smiles-target-ansible-v1',profileSha256:TARGET_PROFILE_SHA256,stepId:'observe'};p.body=bodies.observe;const result=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(false);expect(c.getServerSetupSshCredential).not.toHaveBeenCalled()})
 test.each(['observe','barrier','verify','prepare-target','resume','stop'] as const)('target %s failure keeps only exact real close evidence for readonly steps',async stepId=>{
  const c=client();const p=payload();p.recoveryProfile={...profile(),executorProfile:'smiles-target-ansible-v1',profileSha256:TARGET_PROFILE_SHA256,stepId};p.body=bodies[stepId]
  if(stepId==='prepare-target'){
   const v=p.recoveryProfile;const fp='SHA256:'+createHash('sha256').update(Buffer.from(publicKey.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')
   v.publicInput.continuity_intent={revision:'smiles-reverse-continuity-intent-v1',account_owner_run_id:v.accountOwnerRunId,new_run_id:v.runId,parent_kind:'reboot-v1',parent_session_run_id:v.parentRunId,old_transport_run_id:v.oldTransportRunId}
   v.publicInput.source_reboot_receipt={revision:'smiles-source-reboot-closure-v1',run_id:v.oldTransportRunId,source_ip:'140.227.124.149',helper_sha256:SOURCE_HELPER_SHA256,old_boot_id:v.targetBootId,new_boot_id:v.sourceBootId,old_phase:'cleaned',source_key_fingerprint:fp,private_runtime_absent:true,old_boot_processes_absent:true,unit_main_pid:0,watchdogs_stopped:true,old_journal_mutated:false,legacy_start_admitted:false,source_state_sha256:'a'.repeat(64),observed_at_utc:1}
   v.publicInput.source_closure_receipt={revision:'smiles-source-tunnel-closure-v1',run_id:v.oldTransportRunId,helper_sha256:SOURCE_HELPER_SHA256,source_ip:'140.227.124.149',unit:'smiles-reverse-source-'+v.oldTransportRunId+'.service',source_key_fingerprint:fp,phase:'cleaned',cleanup_confirmed:true,unit_main_pid:0,private_runtime_absent:true,owned_ssh_absent:true,watchdogs_stopped:true,observed_at_utc:1}
   v.publicInput.source_key_receipt={revision:'smiles-source-key-stage-v1',status:'key_prepared',run_id:v.runId,job_id:v.jobId,account_owner_run_id:v.accountOwnerRunId,source_boot_id:v.sourceBootId,helper_sha256:SOURCE_HELPER_SHA256,public_key:publicKey,source_key_fingerprint:fp,stage_nonce:'a'.repeat(64),deadline_utc:600}
  }
  c.getServerSetupSshCredential.mockResolvedValue({...await c.getServerSetupSshCredential(),hostname:'133.18.114.57'});c.getServerSetupVariables.mockResolvedValue({variables:{},secretNames:[]});(c as unknown as {getTenantCode:()=>string}).getTenantCode=()=> 'tenant'
  for(const proof of [undefined,{processClosed:false,executionId:'execution',sshHostId:'host'},{processClosed:true,executionId:'wrong',sshHostId:'host'},{processClosed:true,executionId:'execution',sshHostId:'wrong'},{processClosed:true,executionId:'execution',sshHostId:'host',private:'SECRET'},{processClosed:true,executionId:'execution',sshHostId:'host'}]){
   jest.mocked(executeServerSetupAnsible).mockResolvedValue({success:false,error:'RAW_PRIVATE_ERROR',data:JSON.stringify({serverSetupLocalTermination:proof,raw:'PRIVATE_BODY'})})
   const result=await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient});expect(result.success).toBe(false);expect(JSON.stringify(result)).not.toMatch(/RAW_PRIVATE|PRIVATE_BODY|SECRET/)
   expect(executeServerSetupAnsible).toHaveBeenCalled()
   const allowed=['observe','barrier','verify'].includes(stepId)&&proof?.processClosed===true&&proof.executionId==='execution'&&proof.sshHostId==='host'&&Object.keys(proof).length===3
   expect(Boolean(result.serverSetupConfigurationCompletion)).toBe(allowed)
   if(allowed)expect(result.data).toEqual({serverSetupLocalTermination:{processClosed:true,executionId:'execution',sshHostId:'host'}});else expect(result.data).toBeUndefined()
  }
 })
 test('modified target recipe rejected before SSH credential',async()=>{const c=client();const p=payload();p.recoveryProfile={...profile(),executorProfile:'smiles-target-ansible-v1',profileSha256:TARGET_PROFILE_SHA256,stepId:'observe'};p.body=bodies.observe+'\n# drift';expect((await runSmilesRebootProfile(p,{commandId:'command',agentId:'agent',client:c as unknown as ApiClient})).success).toBe(false);expect(c.getServerSetupSshCredential).not.toHaveBeenCalled()})
 test('fixed source program Python38 syntax, immutable boot and read-only proof boundary',()=>{
  execFileSync('python3',['-c','import ast,sys;ast.parse(sys.stdin.read(),feature_version=(3,8))'],{input:SOURCE_PROGRAM})
  expect(SOURCE_PROGRAM).not.toContain('c.capture(');expect(SOURCE_PROGRAM).toContain("state['phase']=='cleaned'");expect(SOURCE_PROGRAM).toContain("created['boot_id']==expected and m.boot()==expected");expect(SOURCE_PROGRAM.indexOf('m.preflight()')).toBeLessThan(SOURCE_PROGRAM.indexOf('sys.stdin.buffer.read'))
 })
})
