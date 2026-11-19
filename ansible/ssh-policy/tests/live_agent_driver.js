// DISPOSABLE fixture only. Usage: node live_agent_driver.js HOST KEY KNOWN_HOSTS [PORT]
const fs = require('fs');
const crypto = require('crypto');
const {runSshSourceIpSync,freshSsh} = require('../../../dist/server-setup/ssh-source-ip-sync');
const [hostname,keyPath,knownHosts,rawPort='22'] = process.argv.slice(2);
const publicKey = fs.readFileSync(knownHosts,'utf8').trim().split(/\s+/)[2];
const fingerprint = 'SHA256:'+crypto.createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('base64').replace(/=+$/,'');
const credential={hostId:'fixture',hostname,port:Number(rawPort),username:'root',authType:'privateKey',privateKey:fs.readFileSync(keyPath,'utf8')};
const payload={attemptId:'live-agent-key-only',policyId:'live-policy',policyVersion:7,definitionVersion:4,sshHostId:'fixture',cidrs:[],release:false,keyOnly:true,manageSources:false,expectedHostKeySha256:fingerprint,expectedRemovedRules:[]};
(async()=>{
  const before = await freshSsh(credential,fingerprint,'cat /etc/ufw/user.rules /etc/ufw/user6.rules','');
  const result = await runSshSourceIpSync(payload,{commandId:'fixture-command',agentId:'fixture-agent',client:{getSshSourceIpCredential:async()=>credential}});
  console.log(JSON.stringify(result));
  if(!result.success || result.sshSourceIpCompletion?.status!=='succeeded') throw new Error('Actual agent runner did not confirm');
  const after = await freshSsh(credential,fingerprint,'cat /etc/ufw/user.rules /etc/ufw/user6.rules','');
  if(before!==after) throw new Error('Key-only changed firewall');
  const replay=await runSshSourceIpSync(payload,{commandId:'fixture-command-replay',agentId:'fixture-agent',client:{getSshSourceIpCredential:async()=>credential}});
  if(replay.sshSourceIpCompletion?.status!=='succeeded') throw new Error('Lost-result receipt replay failed');
  console.log('PASS actual Agent runner key-only fresh confirmation, unchanged firewall, and lost-result replay');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
