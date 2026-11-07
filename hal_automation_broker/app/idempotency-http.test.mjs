import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import net from 'node:net';

const root=resolve(new URL('.',import.meta.url).pathname);
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(child){if(child.exitCode!==null)return;child.kill('SIGTERM');await new Promise(resolveDone=>{child.once('exit',resolveDone);setTimeout(resolveDone,2000);});}
async function startBroker(port,dir,binDir){
 const child=spawn(process.execPath,['http-server.mjs'],{cwd:root,stdio:'ignore',env:{...process.env,PATH:`${binDir}:${process.env.PATH}`,HAL_BROKER_WORKER_TOKEN:'worker-test-only',HAL_BROKER_HA_TOKEN:'ha-test-only',HAL_BROKER_HMAC_KEY:Buffer.alloc(32,7).toString('base64'),HAL_BROKER_ALLOW_WRITES:'0',HAL_BROKER_BIND:'127.0.0.1',HAL_BROKER_PORT:String(port),HAL_BROKER_STORE:join(dir,'journal.json')}});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<60;i++){try{const r=await fetch(`${base}/v1/capabilities`,{headers:{Authorization:'Bearer ha-test-only'},signal:AbortSignal.timeout(300)});if(r.ok)return child;}catch{}await new Promise(r=>setTimeout(r,25));}
 await stop(child);throw new Error('broker did not start');
}

test('authenticated HTTP retry after restart reconciles one durable proposal and rejects payload drift',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ha-idempotency-http-')),port=await freePort(),binDir=join(dir,'bin');await (await import('node:fs/promises')).mkdir(binDir);
 const stub=join(binDir,'mcporter');
 await writeFile(stub,`#!/usr/bin/env node
process.stdout.write(JSON.stringify({success:true,partial:false,errors:[],entities:[{entity_id:'input_boolean.hal_approval_test_trigger'}]}));
`);
 await chmod(stub,0o700);
 const base=`http://127.0.0.1:${port}`,key='hal-request-stable-key-0001',sessionKey='agent:hal-worker:restart-test';
 const proposal={operation:'create',targetEntityId:null,config:{alias:'HAL Approval Pilot - Durable HTTP retry',triggers:[{trigger:'state',entity_id:'input_boolean.hal_approval_test_trigger'}],actions:[{action:'persistent_notification.create',data:{message:'Test only'}}]}};
 const submit=async config=>fetch(`${base}/v1/proposals`,{method:'POST',headers:{Authorization:'Bearer worker-test-only','content-type':'application/json','idempotency-key':key},body:JSON.stringify({proposal:{...proposal,config},sessionKey})});
 let child;
 try{
  child=await startBroker(port,dir,binDir);
  const firstResponse=await submit(proposal.config);assert.equal(firstResponse.status,201);const first=await firstResponse.json();
  await stop(child);child=undefined;
  child=await startBroker(port,dir,binDir);
  const retriedResponse=await submit(proposal.config);assert.equal(retriedResponse.status,201);const retried=await retriedResponse.json();
  assert.equal(retried.proposalId,first.proposalId);assert.equal(retried.approvalTicket,first.approvalTicket);
  const changed={...proposal.config,alias:'HAL Approval Pilot - Drifted payload'};
  const conflict=await submit(changed);assert.equal(conflict.status,409);assert.equal((await conflict.json()).error,'IDEMPOTENCY_KEY_REUSED');
  const rows=await fetch(`${base}/v1/proposals`,{headers:{Authorization:'Bearer ha-test-only'}}).then(r=>r.json());
  assert.equal(rows.proposals.length,1);assert.equal(rows.proposals[0].proposalId,first.proposalId);
  const capabilities=await fetch(`${base}/v1/capabilities`,{headers:{Authorization:'Bearer ha-test-only'}}).then(r=>r.json());
  assert.equal(capabilities.writesEnabled,false);
 }finally{if(child)await stop(child);await rm(dir,{recursive:true,force:true});}
});

test('live local broker HTTP routes stay read-only by default and worker cannot reach decisions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ha-readonly-http-')),port=await freePort();
 const child=spawn(process.execPath,['http-server.mjs'],{cwd:root,stdio:'ignore',env:{...process.env,HAL_BROKER_WORKER_TOKEN:'worker-test-only',HAL_BROKER_HA_TOKEN:'ha-test-only',HAL_BROKER_HMAC_KEY:Buffer.alloc(32,7).toString('base64'),HAL_BROKER_ALLOW_WRITES:'0',HAL_BROKER_BIND:'127.0.0.1',HAL_BROKER_PORT:String(port),HAL_BROKER_STORE:join(dir,'journal.json')}});
 const base=`http://127.0.0.1:${port}`;
 try {
  let ready=false;
  for(let i=0;i<40;i++){
   try { const r=await fetch(`${base}/v1/capabilities`,{headers:{Authorization:'Bearer ha-test-only'},signal:AbortSignal.timeout(300)}); if(r.ok){ready=true;break;} } catch {}
   await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(ready,true,'server did not start');
  const cap=await fetch(`${base}/v1/capabilities`,{headers:{Authorization:'Bearer ha-test-only'}}).then(r=>r.json());
  assert.deepEqual(cap,{readOnly:true,writesEnabled:false,policy:'pilot_safe_only'});
  const path='/v1/proposals/00000000-0000-4000-8000-000000000000/approve-native';
  const worker=await fetch(`${base}${path}`,{method:'POST',headers:{Authorization:'Bearer worker-test-only','X-HA-User-ID':'admin','X-HA-User-Admin':'true','content-type':'application/json'},body:JSON.stringify({content_hash:'x',validated_by_ha:true})});
  assert.equal(worker.status,401);
  const ha=await fetch(`${base}${path}`,{method:'POST',headers:{Authorization:'Bearer ha-test-only','X-HA-User-ID':'admin','X-HA-User-Admin':'true','content-type':'application/json'},body:JSON.stringify({content_hash:'x',validated_by_ha:true})});
  assert.equal(ha.status,423);
  assert.equal((await ha.json()).error,'WRITE_DISABLED');
 } finally {
  child.kill('SIGTERM');
  await new Promise(resolveDone=>{if(child.exitCode!==null)return resolveDone();child.once('exit',resolveDone);setTimeout(resolveDone,2000);});
  await rm(dir,{recursive:true,force:true});
 }
});