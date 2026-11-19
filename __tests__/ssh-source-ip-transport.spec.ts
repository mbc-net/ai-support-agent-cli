import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { runSshSourceIpSync } from '../src/server-setup/ssh-source-ip-sync'

const mockCalls: {command:string;request:Record<string,unknown>|null}[] = []
let mockResponses: (unknown|Error)[] = []
let mockClients = 0
let mockConnectFailures: (Error | undefined)[] = []
let mockHostKeys: (string | undefined)[] = []
jest.mock('ssh2', () => ({ Client: class extends EventEmitter {
  constructor() { super(); mockClients++ }
  connect(config: {hostVerifier:(key:Buffer)=>boolean;password?:string;privateKey:string}) {
    expect(config.password).toBeUndefined()
    expect(config.privateKey).toBe('private-key')
    const failure = mockConnectFailures.shift()
    if (!config.hostVerifier(Buffer.from(mockHostKeys.shift() ?? 'host-key'))) process.nextTick(() => this.emit('error',new Error('Host key mismatch')))
    else if (failure) process.nextTick(() => this.emit('error',failure))
    else process.nextTick(() => this.emit('ready'))
  }
  exec(command:string, cb:(error:Error|null,stream:EventEmitter)=>void) {
    const stream = new EventEmitter() as EventEmitter & {stderr:EventEmitter;end:(input:string)=>void}
    stream.stderr = new EventEmitter()
    stream.end = (input:string) => {
      mockCalls.push({command,request:command.includes('ssh-policy.py ') ? JSON.parse(input) : null})
      const response = mockResponses.shift()
      process.nextTick(() => {
        if (response instanceof Error) {
          stream.stderr.emit('data',Buffer.from(response.message));stream.emit('close',1)
        } else { stream.emit('data',Buffer.from(typeof response === 'string' ? response : JSON.stringify(response)));stream.emit('close',0) }
      })
    }
    cb(null,stream)
  }
  destroy() {}
} }))
const payload = {attemptId:'attempt',policyId:'policy',policyVersion:2,definitionVersion:3,sshHostId:'host',cidrs:['192.0.2.1/32'],release:false,keyOnly:true,manageSources:true,expectedHostKeySha256:'SHA256:'+createHash('sha256').update('host-key').digest('base64').replace(/=+$/,''),expectedRemovedRules:[]}
const receipt = {...payload,status:'succeeded',machineId:'a'.repeat(32),deadline:Date.now()/1000+600,observedSourceIp:'192.0.2.1'}
const client = {getSshSourceIpCredential: jest.fn(async () => ({hostId:'host',hostname:'target.example',port:22,username:'admin',authType:'privateKey',privateKey:'private-key'})),submitSshSourceIpResult:jest.fn()}
const context = {commandId:'command',agentId:'agent',client:client as never}

beforeEach(() => { mockResponses=[];mockCalls.length=0;mockClients=0;mockConnectFailures=[];mockHostKeys=[];jest.clearAllMocks() })

test('apply then confirmation creates a new pinned key-only SSH connection and binds nonce/version',async () => {
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:[]},{...receipt,status:'pending'},receipt]
  const result = await runSshSourceIpSync(payload,context)
  expect(result.success).toBe(true)
  expect(mockClients).toBe(5)
  const apply = mockCalls.find(c => c.command.includes(' apply '))!.request!
  const confirm = mockCalls.find(c => c.command.includes(' confirm '))!.request!
  expect(confirm).toMatchObject({attemptId:'attempt',policyVersion:2,definitionVersion:3,machineId:receipt.machineId})
  expect(createHash('sha256').update(confirm.nonce as string).digest('hex')).toBe(apply.nonceHash)
  expect(apply.nonce).toBeUndefined()
  expect(result.sshSourceIpCompletion?.status).toBe('succeeded')
  // The transport writes this returned result durably BEFORE any API reporting.
  expect(client.submitSshSourceIpResult).not.toHaveBeenCalled()
})

test('lost API result replay reads canonical receipt without applying again',async () => {
  mockResponses=['installed',receipt]
  const result = await runSshSourceIpSync(payload,context)
  expect(result.sshSourceIpCompletion).toMatchObject({status:'succeeded',observedSourceIp:'192.0.2.1'})
  expect(mockClients).toBe(2)
  expect(mockCalls.some(c=>c.command.includes(' apply '))).toBe(false)
})

test('failed fresh connection preserves pending attempt for timer reconciliation',async () => {
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:[]},{...receipt,status:'pending'},new Error('Connection failed'),{...receipt,status:'pending'}]
  const result = await runSshSourceIpSync(payload,context)
  expect(result.success).toBe(false)
  expect(result.sshSourceIpCompletion?.status).toBe('pending')
  expect(mockCalls.filter(c=>c.command.includes(' apply '))).toHaveLength(1)
})

test('apply response loss recovers state instead of blindly reapplying',async () => {
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:[]},new Error('Lost reply'),{...receipt,status:'recovered'}]
  const result = await runSshSourceIpSync(payload,context)
  expect(result.sshSourceIpCompletion?.status).toBe('recovered')
  expect(mockCalls.filter(c=>c.command.includes(' apply '))).toHaveLength(1)
})

test('drift from approved broad-rule adoption aborts before apply',async () => {
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:['broad SSH rule']}]
  const result = await runSshSourceIpSync(payload,context)
  expect(result.success).toBe(false)
  expect(mockCalls.some(c=>c.command.includes(' apply '))).toBe(false)
})

test('host key mismatch prevents installing or invoking helper',async () => {
  const result = await runSshSourceIpSync({...payload,expectedHostKeySha256:'SHA256:'+Buffer.alloc(32).toString('base64').replace(/=+$/,'')},context)
  expect(result.success).toBe(false)
  expect(mockCalls).toHaveLength(0)
})


test('automatic revision accepts exactly verified managed rules without re-adopting original broad rules',async () => {
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:['own managed rule'],managedRules:true},{...receipt,status:'pending'},receipt]
  const result = await runSshSourceIpSync(payload,context)
  expect(result.sshSourceIpCompletion?.status).toBe('succeeded')
  expect(mockCalls.filter(c=>c.command.includes(' apply '))).toHaveLength(1)
})

test('read-only inspect allows no selected sources and never applies or confirms',async () => {
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:['broad rule'],observedSourceIp:'192.0.2.1',port:22}]
  const result = await runSshSourceIpSync({...payload,cidrs:[]},context,true)
  expect(result.success).toBe(true)
  expect(result.sshSourceIpCompletion).toBeUndefined()
  expect(result.sshSourceIpInspectionCompletion).toMatchObject({machineId:receipt.machineId,removedRules:['broad rule']})
  expect(mockCalls.some(c=>c.command.includes(' apply ')||c.command.includes(' confirm '))).toBe(false)
})


test('failed read-only inspection persists a dedicated error completion',async () => {
  mockResponses=['installed',{status:'absent'},new Error('Unsupported Match configuration')]
  const result = await runSshSourceIpSync({...payload,cidrs:[]},context,true)
  expect(result.sshSourceIpInspectionCompletion).toEqual({error:'Unsupported Match configuration'})
})


test('confirmation retries a pre-authentication reset on a new connection without repeating apply',async () => {
  mockConnectFailures=[undefined,undefined,undefined,undefined,Object.assign(new Error('reset'),{code:'ECONNRESET'}),undefined]
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:[]},{...receipt,status:'pending'},receipt]
  const result = await runSshSourceIpSync(payload,context)
  expect(result.sshSourceIpCompletion?.status).toBe('succeeded')
  expect(mockClients).toBe(6)
  expect(mockCalls.filter(c=>c.command.includes(' apply '))).toHaveLength(1)
  const apply=mockCalls.find(c=>c.command.includes(' apply '))!.request!
  const confirm=mockCalls.find(c=>c.command.includes(' confirm '))!.request!
  expect(createHash('sha256').update(confirm.nonce as string).digest('hex')).toBe(apply.nonceHash)
})

test('three failed handshake attempts leave the same transaction pending for recovery',async () => {
  const reset=()=>Object.assign(new Error('refused'),{code:'ECONNREFUSED'})
  mockConnectFailures=[undefined,undefined,undefined,undefined,reset(),reset(),reset(),undefined]
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:[]},{...receipt,status:'pending'},{...receipt,status:'pending'}]
  const result=await runSshSourceIpSync(payload,context)
  expect(result.sshSourceIpCompletion?.status).toBe('pending')
  expect(mockClients).toBe(8)
  expect(mockCalls.filter(c=>c.command.includes(' apply '))).toHaveLength(1)
})

test.each(['authentication','host-key'])('confirmation does not retry fatal %s failure',async kind => {
  if(kind==='authentication') mockConnectFailures=[undefined,undefined,undefined,undefined,Object.assign(new Error('All configured authentication methods failed'),{level:'client-authentication'}),undefined]
  else mockHostKeys=[undefined,undefined,undefined,undefined,'foreign-key',undefined]
  mockResponses=['installed',{status:'absent'},{machineId:receipt.machineId,removedRules:[]},{...receipt,status:'pending'},{...receipt,status:'pending'}]
  const result=await runSshSourceIpSync(payload,context)
  expect(result.sshSourceIpCompletion?.status).toBe('pending')
  expect(mockClients).toBe(6)
  expect(mockCalls.filter(c=>c.command.includes(' apply '))).toHaveLength(1)
})
