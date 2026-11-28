/** Dedicated profile branch. Normal Ansible OS/guard behavior is untouched. */
import {createHash} from 'crypto'
import type {ApiClient} from '../api-client'
import {AGENT_MODE_ONESHOT,ONESHOT_ENV_VARS} from '../constants'
import {errorResult,successResult,type CommandResult,type ServerSetupExecPayload} from '../types'
import {freshSsh} from './ssh-source-ip-sync'
import {validateSshCredential,validateCredentialForTargetOs} from './server-setup-connection'
import {sourceRuntimeReady} from './smiles-reboot-runtime'
import {SOURCE_COMMAND,SOURCE_PROGRAM_SHA256 as actualSourceProgramSha} from './smiles-reboot-source-program'
import {requireProfile,recoveryMetadata,SOURCE_PROGRAM_SHA256,SOURCE_PROFILE_BODY,TARGET_RECIPE_SHA256,validateRecoveryProfile} from './smiles-reboot-profile'
import {executeServerSetupAnsible} from './server-setup-runner'
import {validateAnsibleTasks} from './ansible-task-guard'
interface Context {commandId:string;agentId?:string;client:ApiClient}
function closedReadonlyFailure(payload:ServerSetupExecPayload):CommandResult{
 return {...errorResult('SMILES_REBOOT_PROFILE_REFUSED'),data:{serverSetupLocalTermination:{processClosed:true,executionId:payload.executionId,sshHostId:payload.sshHostId}},serverSetupConfigurationCompletion:{executionId:payload.executionId,evidence:{kind:'completed',sshHostId:payload.sshHostId,processClosed:true}}}
}
function realLocalTermination(executed:CommandResult,payload:ServerSetupExecPayload):boolean{
 let data=executed.data
 if(typeof data==='string'){
  if(Buffer.byteLength(data)>131072)return false
  try{data=JSON.parse(data)}catch{return false}
 }
 const closed=data&&typeof data==='object'&&!Array.isArray(data)?(data as Record<string,unknown>).serverSetupLocalTermination:undefined
 if(!closed||typeof closed!=='object'||Array.isArray(closed)||Object.keys(closed).sort().join(',')!=='executionId,processClosed,sshHostId')return false
 const proof=closed as Record<string,unknown>
 const cleanup=(data as Record<string,unknown>).serverSetupLocalCleanup
 if(!cleanup||typeof cleanup!=='object'||Array.isArray(cleanup)||Object.keys(cleanup).sort().join(',')!=='executionId,sensitiveFilesRemoved,sshHostId')return false
 const removed=cleanup as Record<string,unknown>
 return proof.processClosed===true&&proof.executionId===payload.executionId&&proof.sshHostId===payload.sshHostId&&removed.sensitiveFilesRemoved===true&&removed.executionId===payload.executionId&&removed.sshHostId===payload.sshHostId
}
export async function runSmilesRebootProfile(payload:ServerSetupExecPayload,ctx:Context):Promise<CommandResult>{
 let readonlyClosed=false
 let closedSignal:Promise<void>|undefined
 let signalClosed:(()=>void)|undefined
 try{
  const p=validateRecoveryProfile(payload.recoveryProfile)
  requireProfile(typeof ctx.commandId==='string'&&ctx.commandId.length>0&&typeof ctx.agentId==='string'&&ctx.agentId.length>0&&typeof payload.executionId==='string'&&payload.executionId.length>0&&typeof payload.sshHostId==='string'&&payload.sshHostId.length>0&&(payload.targetOs===undefined||payload.targetOs==='linux'))
  const agentId=ctx.agentId as string
  const source=p.executorProfile==='smiles-source-python38-v1'
  requireProfile(payload.dispatchMode==='ecs_oneshot'&&process.env[ONESHOT_ENV_VARS.AGENT_MODE]===AGENT_MODE_ONESHOT)
  if(source){
   requireProfile(actualSourceProgramSha===SOURCE_PROGRAM_SHA256&&payload.body===SOURCE_PROFILE_BODY&&payload.dispatchMode==='ecs_oneshot'&&process.env[ONESHOT_ENV_VARS.AGENT_MODE]===AGENT_MODE_ONESHOT)
   sourceRuntimeReady()
  }
  else{
   requireProfile(typeof payload.body==='string'&&createHash('sha256').update(payload.body).digest('hex')===TARGET_RECIPE_SHA256[p.stepId])
   requireProfile(validateAnsibleTasks(payload.body,{mode:'ecs',targetOs:'linux'}).ok)
  }
  const credential=await ctx.client.getServerSetupSshCredential(ctx.commandId,agentId)
  requireProfile(!validateSshCredential(credential)&&!validateCredentialForTargetOs(credential,'linux')&&credential.hostId===payload.sshHostId&&credential.hostname===(source?'140.227.124.149':'133.18.114.57')&&credential.port===22&&credential.authType==='privateKey'&&(!credential.connectionType||credential.connectionType==='ssh')&&typeof credential.hostKeyFingerprint==='string'&&/^SHA256:[A-Za-z0-9+/]{43}$/.test(credential.hostKeyFingerprint))
  if(source){
   requireProfile(credential.username==='mbc')
   // Only the single readonly SSH invocation can authorize failure termination.
   // destroy()/timeout is not proof: only real channel/connection close notifies.
   const readonly=['source-observe','source-proof','close-source'].includes(p.stepId)
   if(readonly)closedSignal=new Promise<void>(resolve=>{signalClosed=()=>{readonlyClosed=true;resolve()}})
   const raw=await freshSsh(credential,credential.hostKeyFingerprint,SOURCE_COMMAND,JSON.stringify({profile:p}),120000,readonly?{onClosed:()=>signalClosed?.()}:undefined)
   requireProfile(Buffer.byteLength(raw)<=65536);const metadata=recoveryMetadata(JSON.parse(raw),p)
   return {...successResult({recoveryMetadata:metadata,serverSetupLocalTermination:{processClosed:true,executionId:payload.executionId,sshHostId:payload.sshHostId}}),serverSetupConfigurationCompletion:{executionId:payload.executionId,evidence:{kind:'completed',sshHostId:payload.sshHostId,processClosed:true}}}
  }
  const fetched=await ctx.client.getServerSetupVariables(ctx.commandId,agentId)
  requireProfile(fetched.secretNames.length===0&&Object.keys(fetched.variables).every(name=>['SMILES_TUNNEL_RUN_ID','SMILES_SESSION_INTENT','SMILES_TUNNEL_PUBLIC_INPUTS','SMILES_RESTORE_RUN_ID','SMILES_REBOOT_SOURCE_RECEIPT_JSON','SMILES_REBOOT_SOURCE_CLOSURE_JSON'].includes(name)))
  const variables={...fetched.variables,SMILES_REBOOT_SOURCE_RECEIPT_JSON:JSON.stringify(p.publicInput.source_reboot_receipt),SMILES_REBOOT_SOURCE_CLOSURE_JSON:JSON.stringify(p.publicInput.source_closure_receipt),SMILES_TUNNEL_RUN_ID:p.runId,SMILES_TUNNEL_PUBLIC_INPUTS:JSON.stringify(p.publicInput.public_contract),SMILES_SESSION_INTENT:JSON.stringify(p.publicInput.continuity_intent)}
  const executed=await executeServerSetupAnsible({executionId:payload.executionId,body:payload.body,mode:'ecs',targetOs:'linux',credential,variables,secretNames:[],tenantCode:ctx.client.getTenantCode(),sshHostId:payload.sshHostId,commandId:ctx.commandId,client:ctx.client,recoveryProfile:p,readStopRequest:async()=>(await ctx.client.getServerSetupControl(ctx.commandId,agentId)).stopRequested===true})
  // This fixed, secret-free target profile closes local delivery, not the remote
  // supervised guardian. Generic Ansible completion classification is unchanged.
  const locallyClosed=realLocalTermination(executed,payload)
  const projected={...executed};delete projected.serverSetupConfigurationCompletion
  if(executed.success)return locallyClosed?{...projected,serverSetupConfigurationCompletion:closedReadonlyFailure(payload).serverSetupConfigurationCompletion}:projected
  if(['observe','barrier','verify'].includes(p.stepId)&&locallyClosed){const failure=closedReadonlyFailure(payload);return {...failure,data:{...failure.data as Record<string,unknown>,serverSetupLocalCleanup:{sensitiveFilesRemoved:true,executionId:payload.executionId,sshHostId:payload.sshHostId}}}}
  return errorResult('SMILES_REBOOT_PROFILE_REFUSED')
 }catch{
  if(closedSignal&&!readonlyClosed){
   let timer:ReturnType<typeof setTimeout>|undefined
   await Promise.race([closedSignal,new Promise<void>(resolve=>{timer=setTimeout(resolve,1000)})])
   if(timer)clearTimeout(timer)
  }
  return readonlyClosed?closedReadonlyFailure(payload):errorResult('SMILES_REBOOT_PROFILE_REFUSED')
 }
}
