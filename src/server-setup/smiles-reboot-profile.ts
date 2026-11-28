/** Finite managed profile protocol. Never accepts script text or arbitrary endpoints. */
import {createHash} from 'crypto'
export const SOURCE_HELPER_SHA256='f8f3c09150ca501f224346d004fb21296c4dca1bd7e0d47d728bd032884b5353'
export const SOURCE_PROGRAM_SHA256='bcd7f9b6ec1e70c6384d88f56029a9a6c0c39619ec2ff2e344267ad0c57c07ff'
export const SMILES_REBOOT_CAPABILITY='server_setup_smiles_reboot_v1'
export const SOURCE_PROFILE_BODY='- name: Managed Smiles reboot profile\n  ansible.builtin.debug:\n    msg: managed-profile\n'
export const SOURCE_STEPS=['source-observe','source-proof','close-source','source-keygen','start-source'] as const
export const SOURCE_PROFILE_SHA256=createHash('sha256').update(JSON.stringify({revision:'smiles-reboot-profile-v1',program_sha256:SOURCE_PROGRAM_SHA256,body:SOURCE_PROFILE_BODY,steps:SOURCE_STEPS})).digest('hex')
export const TARGET_STEPS=['observe','prepare-target','resume','barrier','verify','stop'] as const
export type RecoveryStep=(typeof SOURCE_STEPS)[number]|(typeof TARGET_STEPS)[number]
export interface RecoveryProfile {
 revision:'smiles-reboot-profile-v1';executorProfile:'smiles-source-python38-v1'|'smiles-target-ansible-v1';jobId:string;stepId:RecoveryStep;runId:string;sourceBootId:string;targetBootId:string;parentRunId:string;oldTransportRunId:string;accountOwnerRunId:string;profileSha256:string
 publicInput:{public_contract:Record<string,unknown>;continuity_intent:Record<string,unknown>|null;source_reboot_receipt:Record<string,unknown>|null;source_closure_receipt:Record<string,unknown>|null;source_key_receipt:Record<string,unknown>|null}
}
export interface RecoveryMetadata {revision:'smiles-reboot-metadata-v1';jobId:string;stepId:RecoveryStep;runId:string;parentRunId:string;sourceBootId:string;targetBootId:string;profileSha256:string;publicResult:Record<string,unknown>}
export const TARGET_PROFILE_CATALOG={"complete":true,"core_sha256":"3d66c335a645711f16df07e30aa645cafb5f5a7669528f1bb93f26800b1fbd45","metadata_sha256":"7c2ef0643468df7ff2e0a6dc293f677f22d6c5c8fa7c44b958370f7e783d45e2","revision":"smiles-reboot-target-profile-catalog-v1","target_profiles":{"barrier":{"body_sha256":"cb4781e6855121ca6ee88cbe68cd53c96dce45462beac6af9f2c5eaaf852d484","path":"server-setup/recipes/smiles/240-reboot-automation-barrier.yaml","recipe_id":"smiles-reboot-automation-barrier-cb4781e68551"},"observe":{"body_sha256":"a5332dddcef32f7eacd4e3138530f4070d6f9fadd55e0f0608470702a8c9e2ef","path":"server-setup/recipes/smiles/239-reboot-automation-observe.yaml","recipe_id":"smiles-reboot-automation-observe-a5332dddcef3"},"prepare-target":{"body_sha256":"b40549b104d99631e4c9935219844b3bb778ef83fa1fcddda8e62d0d508c18d5","path":"server-setup/recipes/smiles/237-reboot-automation-prepare-target.yaml","recipe_id":"smiles-reboot-automation-prepare-target-b40549b104d9"},"resume":{"body_sha256":"3558f89ffd53d13e42ab97bbef2289a96e3502fdb67fe51b2b9f7556b40f0030","path":"server-setup/recipes/smiles/238-reboot-automation-resume.yaml","recipe_id":"smiles-reboot-automation-resume-3558f89ffd53"},"stop":{"body_sha256":"d473d3d2375b54c14d82705db76a54d2a037ace28a77b5833b37111d9c554651","path":"server-setup/recipes/smiles/242-reboot-automation-stop.yaml","recipe_id":"smiles-reboot-automation-stop-d473d3d2375b"},"verify":{"body_sha256":"cd90ab1f25c820316bdd0d9c59e694486f0c471464054ceef032cb55085043ec","path":"server-setup/recipes/smiles/241-reboot-automation-verify.yaml","recipe_id":"smiles-reboot-automation-verify-cd90ab1f25c8"}}} as const
export const TARGET_RECIPE_SHA256:Readonly<Partial<Record<RecoveryStep,string>>>=Object.fromEntries(Object.entries(TARGET_PROFILE_CATALOG.target_profiles).map(([step,entry])=>[step,entry.body_sha256]))
export const TARGET_PROFILE_SHA256=createHash('sha256').update(JSON.stringify(TARGET_PROFILE_CATALOG)).digest('hex')
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const RUN=/^[a-f0-9]{32}$/;const SHA=/^[a-f0-9]{64}$/
export function requireProfile(value:unknown):asserts value {if(!value)throw new Error('SMILES_REBOOT_PROFILE_REFUSED')}
function object(value:unknown):Record<string,unknown>{requireProfile(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>}
function exact(value:Record<string,unknown>,keys:string[]):void{requireProfile(Object.keys(value).sort().join(',')===keys.sort().join(','))}
function key(value:unknown):void {
 requireProfile(typeof value==='string'&&value.length<=256&&/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(value));const raw=Buffer.from(value.split(' ')[1],'base64')
 requireProfile(raw.length===51&&raw.subarray(0,19).equals(Buffer.from('0000000b7373682d6564323535313900000020','hex'))&&raw.toString('base64')===value.split(' ')[1])
}
function publicContract(value:Record<string,unknown>,p:RecoveryProfile):void {
 if(p.stepId==='start-source'){
  exact(value,['revision','run_id','purpose','ttl_seconds','issued_at_utc','deadline_utc','source_ip','target_ip','ssh_user','public_key','source_key_fingerprint','target_host_key','target_key_fingerprint','listen','destination'])
  requireProfile(value.revision==='smiles-reverse-tunnel-public-v1'&&value.run_id===p.runId&&value.source_ip==='140.227.124.149'&&value.target_ip==='133.18.114.57'&&value.ssh_user==='smiles-tunnel')
  requireProfile(Number.isSafeInteger(value.issued_at_utc)&&Number.isSafeInteger(value.deadline_utc)&&(value.deadline_utc as number)===(value.issued_at_utc as number)+(value.ttl_seconds as number))
  requireProfile(JSON.stringify(value.listen)===JSON.stringify({host:'127.0.0.1',port:23306})&&JSON.stringify(value.destination)===JSON.stringify({host:'127.0.0.1',port:3306}))
  for(const name of ['source_key_fingerprint','target_key_fingerprint'])requireProfile(typeof value[name]==='string'&&/^SHA256:[A-Za-z0-9+/]{43}$/.test(value[name] as string))
  const wireFingerprint=(key:unknown):string=>'SHA256:'+createHash('sha256').update(Buffer.from((key as string).split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')
  requireProfile(value.source_key_fingerprint===wireFingerprint(value.public_key)&&value.target_key_fingerprint===wireFingerprint(value.target_host_key))
 }else{
  exact(value,['purpose','ttl_seconds','public_key','target_host_key','source_ca_pem'])
  requireProfile(typeof value.source_ca_pem==='string'&&value.source_ca_pem.length<=16384&&/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n$/.test(value.source_ca_pem))
 }
 requireProfile(value.purpose==='follow'&&Number.isSafeInteger(value.ttl_seconds)&&(value.ttl_seconds as number)>=300&&(value.ttl_seconds as number)<=43200)
 key(value.public_key);key(value.target_host_key)
}
export function validateSourceReceipt(value:unknown,p:RecoveryProfile):Record<string,unknown>{
 const v=object(value);exact(v,['revision','run_id','source_ip','helper_sha256','old_boot_id','new_boot_id','old_phase','source_key_fingerprint','private_runtime_absent','old_boot_processes_absent','unit_main_pid','watchdogs_stopped','old_journal_mutated','legacy_start_admitted','source_state_sha256','observed_at_utc'])
 requireProfile(v.revision==='smiles-source-reboot-closure-v1'&&v.run_id===p.oldTransportRunId&&v.source_ip==='140.227.124.149'&&v.helper_sha256===SOURCE_HELPER_SHA256&&v.new_boot_id===p.sourceBootId&&typeof v.old_boot_id==='string'&&UUID.test(v.old_boot_id)&&v.old_boot_id!==v.new_boot_id&&v.old_phase==='cleaned')
 requireProfile(v.private_runtime_absent===true&&v.old_boot_processes_absent===true&&v.watchdogs_stopped===true&&v.unit_main_pid===0&&v.old_journal_mutated===false&&v.legacy_start_admitted===false&&typeof v.source_state_sha256==='string'&&SHA.test(v.source_state_sha256)&&Number.isSafeInteger(v.observed_at_utc)&&(v.observed_at_utc as number)>0)
 const pub=p.publicInput.public_contract.public_key as string
 const fp='SHA256:'+createHash('sha256').update(Buffer.from(pub.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')
 const newKey=p.publicInput.source_key_receipt
 requireProfile(typeof v.source_key_fingerprint==='string'&&/^SHA256:[A-Za-z0-9+/]{43}$/.test(v.source_key_fingerprint)&&v.source_key_fingerprint===(newKey?p.publicInput.source_closure_receipt?.source_key_fingerprint:fp));return v
}
export function validateSourceClosure(value:unknown,p:RecoveryProfile):Record<string,unknown>{
 const v=object(value);exact(v,['revision','run_id','helper_sha256','source_ip','unit','source_key_fingerprint','phase','cleanup_confirmed','unit_main_pid','private_runtime_absent','owned_ssh_absent','watchdogs_stopped','observed_at_utc'])
 requireProfile(v.revision==='smiles-source-tunnel-closure-v1'&&v.run_id===p.oldTransportRunId&&v.helper_sha256===SOURCE_HELPER_SHA256&&v.source_ip==='140.227.124.149'&&v.unit==='smiles-reverse-source-'+p.oldTransportRunId+'.service'&&v.source_key_fingerprint===(p.publicInput.source_key_receipt?p.publicInput.source_reboot_receipt?.source_key_fingerprint:fingerprint(p))&&v.phase==='cleaned'&&v.cleanup_confirmed===true&&v.unit_main_pid===0&&v.private_runtime_absent===true&&v.owned_ssh_absent===true&&v.watchdogs_stopped===true&&Number.isSafeInteger(v.observed_at_utc)&&(v.observed_at_utc as number)>0);return v
}
export function validateSourceKeyReceipt(value:unknown,p:RecoveryProfile):Record<string,unknown>{
 const v=object(value);exact(v,['revision','status','run_id','job_id','account_owner_run_id','source_boot_id','helper_sha256','public_key','source_key_fingerprint','stage_nonce','deadline_utc'])
 requireProfile(v.revision==='smiles-source-key-stage-v1'&&v.status==='key_prepared'&&v.run_id===p.runId&&v.job_id===p.jobId&&v.account_owner_run_id===p.accountOwnerRunId&&v.source_boot_id===p.sourceBootId&&v.helper_sha256===SOURCE_HELPER_SHA256&&typeof v.stage_nonce==='string'&&SHA.test(v.stage_nonce)&&Number.isSafeInteger(v.deadline_utc)&&(v.deadline_utc as number)>0)
 key(v.public_key);requireProfile(v.source_key_fingerprint==='SHA256:'+createHash('sha256').update(Buffer.from((v.public_key as string).split(' ')[1],'base64')).digest('base64').replace(/=+$/,''));return v
}
export function validateRecoveryProfile(value:unknown):RecoveryProfile{
 const v=object(value);exact(v,['revision','executorProfile','jobId','stepId','runId','sourceBootId','targetBootId','parentRunId','oldTransportRunId','accountOwnerRunId','profileSha256','publicInput']);const p=v as unknown as RecoveryProfile
 requireProfile(p.revision==='smiles-reboot-profile-v1'&&[p.jobId,p.sourceBootId,p.targetBootId].every(v=>typeof v==='string'&&UUID.test(v))&&[p.runId,p.parentRunId,p.oldTransportRunId].every(v=>typeof v==='string'&&RUN.test(v))&&((p.runId!==p.parentRunId&&p.runId!==p.oldTransportRunId)||(p.stepId==='stop'&&p.runId===p.parentRunId&&p.runId===p.oldTransportRunId))&&p.accountOwnerRunId==='8d6f037733724fbe969cf513e11b4b9f')
 const source=p.executorProfile==='smiles-source-python38-v1';requireProfile(source||p.executorProfile==='smiles-target-ansible-v1');requireProfile((source?SOURCE_STEPS:TARGET_STEPS).includes(p.stepId as never));requireProfile(p.profileSha256===(source?SOURCE_PROFILE_SHA256:TARGET_PROFILE_SHA256))
 const input=object(p.publicInput);exact(input,['public_contract','continuity_intent','source_reboot_receipt','source_closure_receipt','source_key_receipt']);publicContract(object(input.public_contract),p)
 if(input.source_key_receipt!==null){const receipt=validateSourceKeyReceipt(input.source_key_receipt,p);requireProfile(p.publicInput.public_contract.public_key===receipt.public_key)}
 if(input.continuity_intent!==null){
  const i=object(input.continuity_intent);exact(i,['revision','account_owner_run_id','new_run_id','parent_kind','parent_session_run_id','old_transport_run_id'])
  requireProfile(i.revision==='smiles-reverse-continuity-intent-v1'&&i.account_owner_run_id===p.accountOwnerRunId&&i.new_run_id===p.runId&&i.parent_session_run_id===p.parentRunId&&i.old_transport_run_id===p.oldTransportRunId&&['continuity-v1','reboot-v1'].includes(i.parent_kind as string))
 }
 if(input.source_reboot_receipt!==null)validateSourceReceipt(input.source_reboot_receipt,p)
 if(input.source_closure_receipt!==null)validateSourceClosure(input.source_closure_receipt,p)
 if(p.stepId==='prepare-target')requireProfile(input.continuity_intent!==null&&input.source_reboot_receipt!==null&&input.source_closure_receipt!==null&&input.source_key_receipt!==null)
 if(p.stepId==='start-source')requireProfile(input.source_key_receipt!==null)
 if(['source-observe','source-proof','close-source','source-keygen'].includes(p.stepId))requireProfile(input.source_key_receipt===null)
 if(p.stepId==='stop'&&p.runId===p.parentRunId)requireProfile(input.continuity_intent===null&&input.source_reboot_receipt===null&&input.source_closure_receipt===null&&input.source_key_receipt===null)
 requireProfile(Buffer.byteLength(JSON.stringify(p))<=32768);return p
}
export const REBOOT_CORE_SHA256='3d66c335a645711f16df07e30aa645cafb5f5a7669528f1bb93f26800b1fbd45'
function fingerprint(p:RecoveryProfile):string{return 'SHA256:'+createHash('sha256').update(Buffer.from((p.publicInput.public_contract.public_key as string).split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')}
function validateProgress(value:unknown):void{
 const progress=object(value);exact(progress,['Seconds_Behind_Source','Read_Source_Log_Pos','Exec_Source_Log_Pos','Source_Log_File','Relay_Source_Log_File'])
 for(const name of ['Seconds_Behind_Source','Read_Source_Log_Pos','Exec_Source_Log_Pos'])requireProfile(progress[name]===null||Number.isSafeInteger(progress[name])&&(progress[name] as number)>=0)
 for(const name of ['Source_Log_File','Relay_Source_Log_File'])requireProfile(typeof progress[name]==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(progress[name] as string))
}
export function validatePublicResult(value:unknown,p:RecoveryProfile):Record<string,unknown>{
 const v=object(value)
 if(p.stepId==='source-keygen'){validateSourceKeyReceipt(v,p)}
 else if(p.stepId==='source-observe'){
  exact(v,['status','source_boot_id','source_ip','helper_sha256']);requireProfile(v.status==='observed'&&typeof v.source_boot_id==='string'&&UUID.test(v.source_boot_id)&&v.source_ip==='140.227.124.149'&&v.helper_sha256===SOURCE_HELPER_SHA256)
 }else if(p.stepId==='source-proof'){
  exact(v,['status','receipt','source_closure']);requireProfile(v.status==='proved');validateSourceReceipt(v.receipt,p);validateSourceClosure(v.source_closure,p)
 }else if(p.stepId==='close-source'||p.stepId==='start-source'){
  exact(v,['status','run_id','source_boot_id','helper_sha256']);requireProfile(v.status===(p.stepId==='close-source'?'cleaned':'started')&&v.run_id===(p.stepId==='close-source'?p.oldTransportRunId:p.runId)&&v.source_boot_id===p.sourceBootId&&v.helper_sha256===SOURCE_HELPER_SHA256)
 }else if(p.stepId==='observe'){
  exact(v,['revision','observed_at','helper_sha256','account_owner_run_id','parent_kind','parent_run_id','old_transport_run_id','restore_run_id','candidate_cid','candidate_uuid','source_uuid','target_boot_id','phase','transport_phase','cleanup_confirmed','source_key_fingerprint','io_errno','sql_errno','read_only','super_read_only','event_scheduler_off','admitted_source_boot_id','progress','lease_deadline_utc','io_state','sql_state'])
  requireProfile(v.revision==='smiles-reboot-public-metadata-v1'&&Number.isSafeInteger(v.observed_at)&&v.account_owner_run_id===p.accountOwnerRunId&&typeof v.restore_run_id==='string'&&RUN.test(v.restore_run_id)&&typeof v.candidate_cid==='string'&&SHA.test(v.candidate_cid)&&typeof v.candidate_uuid==='string'&&UUID.test(v.candidate_uuid)&&v.source_uuid==='0841a208-dff7-11eb-a786-00135d131624'&&v.target_boot_id===p.targetBootId&&v.parent_run_id===p.parentRunId&&v.old_transport_run_id===p.oldTransportRunId&&['continuity-v1','reboot-v1'].includes(v.parent_kind as string)&&v.read_only===true&&v.super_read_only===true&&v.event_scheduler_off===true&&v.source_key_fingerprint===fingerprint(p)&&v.helper_sha256===REBOOT_CORE_SHA256)
  requireProfile(['prepared','resume_intent','following','stopped','stop_unconfirmed'].includes(v.phase as string)&&['awaiting_ssh','ssh_ready','relay_ready','cleaned','expired','stopped'].includes(v.transport_phase as string)&&typeof v.cleanup_confirmed==='boolean'&&(v.admitted_source_boot_id===null||typeof v.admitted_source_boot_id==='string'&&UUID.test(v.admitted_source_boot_id)))
  for(const field of ['io_errno','sql_errno'])requireProfile(Number.isSafeInteger(v[field])&&(v[field] as number)>=0&&(v[field] as number)<=4294967295)
  requireProfile(Number.isSafeInteger(v.lease_deadline_utc)&&(v.lease_deadline_utc as number)>0&&['No','Yes','Connecting'].includes(v.io_state as string)&&['No','Yes'].includes(v.sql_state as string))
  validateProgress(v.progress)
 }else if(p.stepId==='prepare-target'){
  exact(v,['revision','observed_at','run_id','public']);requireProfile(v.revision==='smiles-reboot-public-metadata-v1'&&v.run_id===p.runId&&Number.isSafeInteger(v.observed_at));const contract=object(v.public);publicContract(contract,{...p,stepId:'start-source'})
  requireProfile(contract.public_key===p.publicInput.public_contract.public_key&&contract.target_host_key===p.publicInput.public_contract.target_host_key)
 }else if(p.stepId==='resume'){
  exact(v,['session_run_id','status']);requireProfile(v.session_run_id===p.runId&&v.status==='prepared')
 }else if(p.stepId==='stop'){
  const fields=['revision','session_run_id','phase','cleanup_confirmed'];if('progress' in v)fields.push('progress');exact(v,fields)
  requireProfile(v.revision==='smiles-reboot-continuity-v1'&&v.session_run_id===p.runId&&v.phase==='stopped'&&v.cleanup_confirmed===true);if('progress' in v)validateProgress(v.progress)
 }else if(p.stepId==='barrier'){
  exact(v,['revision','observed_at','run_id','source_uuid','file','position']);requireProfile(v.revision==='smiles-reboot-public-metadata-v1'&&Number.isSafeInteger(v.observed_at)&&v.run_id===p.runId&&v.source_uuid==='0841a208-dff7-11eb-a786-00135d131624'&&typeof v.file==='string'&&/^binlog\.[0-9]{6,20}$/.test(v.file)&&Number.isSafeInteger(v.position)&&(v.position as number)>=4)
 }else if(p.stepId==='verify'){
  exact(v,['revision','observed_at','run_id','candidate_cid','candidate_uuid','source_uuid','io_running','sql_running','io_errno','sql_errno','read_only','super_read_only','event_scheduler_off','progress'])
  requireProfile(v.revision==='smiles-reboot-public-metadata-v1'&&Number.isSafeInteger(v.observed_at)&&v.run_id===p.runId&&typeof v.candidate_cid==='string'&&SHA.test(v.candidate_cid)&&typeof v.candidate_uuid==='string'&&UUID.test(v.candidate_uuid)&&v.source_uuid==='0841a208-dff7-11eb-a786-00135d131624'&&v.io_running===true&&v.sql_running===true&&v.io_errno===0&&v.sql_errno===0&&v.read_only===true&&v.super_read_only===true&&v.event_scheduler_off===true);validateProgress(v.progress)
 }else throw new Error('SMILES_REBOOT_PROFILE_REFUSED')
 requireProfile(Buffer.byteLength(JSON.stringify(v))<=65536);return v
}
export function recoveryMetadata(value:unknown,p:RecoveryProfile):RecoveryMetadata{
 return {revision:'smiles-reboot-metadata-v1',jobId:p.jobId,stepId:p.stepId,runId:p.runId,parentRunId:p.parentRunId,sourceBootId:p.sourceBootId,targetBootId:p.targetBootId,profileSha256:p.profileSha256,publicResult:validatePublicResult(value,p)}
}
export function validateRecoveryMetadata(value:unknown,p:RecoveryProfile):RecoveryMetadata{
 const v=object(value);exact(v,['revision','jobId','stepId','runId','parentRunId','sourceBootId','targetBootId','profileSha256','publicResult'])
 requireProfile(v.revision==='smiles-reboot-metadata-v1')
 for(const name of ['jobId','stepId','runId','parentRunId','sourceBootId','targetBootId','profileSha256'] as const)requireProfile(v[name]===p[name])
 return recoveryMetadata(v.publicResult,p)
}
export function parseTargetMetadata(stdout:string,p:RecoveryProfile):RecoveryMetadata{
 requireProfile(Buffer.byteLength(stdout)<=20*1024*1024);const output=object(JSON.parse(stdout));requireProfile(Array.isArray(output.plays));const candidates:unknown[]=[]
 for(const rawPlay of output.plays){
  const play=object(rawPlay);requireProfile(Array.isArray(play.tasks))
  for(const rawTask of play.tasks){
   const task=object(rawTask);const name=object(task.task).name
   if(name!=='SMILES_REBOOT_PUBLIC_RESULT')continue
   const hosts=Object.values(object(task.hosts));requireProfile(hosts.length===1);const host=object(hosts[0])
   requireProfile(host.failed!==true&&host.unreachable!==true&&host.skipped!==true&&host._ansible_no_log!==true&&host.rc===0&&typeof host.stdout==='string'&&Buffer.byteLength(host.stdout)<=65536)
   candidates.push(JSON.parse(host.stdout))
  }
 }
 // The fixed recipe has exactly one result-emitting public task.
 requireProfile(candidates.length===1);return recoveryMetadata(candidates[0],p)
}
