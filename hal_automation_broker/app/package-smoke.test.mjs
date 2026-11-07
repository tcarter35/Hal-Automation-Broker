import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const app=resolve(new URL('.', import.meta.url).pathname);
const readToken='ha-private-test-token';
const workerToken='worker-private-test-token';
const smokeProposal={operation:'create',targetEntityId:null,config:{alias:'HAL Approval Pilot - smoke',triggers:[{trigger:'state',entity_id:'input_boolean.hal_approval_test_trigger'}],actions:[{action:'persistent_notification.create',data:{message:'smoke'}}]}};
async function request(base,path,{token,method='GET',body,headers={}}={}){
 const r=await fetch(base+path,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,body:await r.json()};
}
test('isolated add-on HTTP runtime persists drafts and rejects every approval while read-only',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'hal-addon-smoke-'));
 const serverPath=resolve(app,'http-server.mjs');
 const fakebin=join(dir,'bin'); await mkdir(fakebin);
 const fakeMcp=join(fakebin,'mcporter');
 await writeFile(fakeMcp,`#!/bin/sh\nprintf '%s\\n' '{\"success\":true,\"partial\":false,\"errors\":[],\"entities\":[{\"entity_id\":\"input_boolean.hal_approval_test_trigger\"}]}'\n`); await chmod(fakeMcp,0o755);
 const free=(await import('node:net')).createServer(); await new Promise((r,j)=>free.listen(0,'127.0.0.1',r).once('error',j));
 const port=free.address().port; await new Promise(r=>free.close(r));
 const proc=spawn(process.execPath,[serverPath],{cwd:app,env:{...process.env,PATH:fakebin+':'+process.env.PATH,HAL_BROKER_WORKER_TOKEN:workerToken,HAL_BROKER_HA_TOKEN:readToken,HAL_BROKER_HMAC_KEY:Buffer.alloc(32,7).toString('base64'),HAL_BROKER_ALLOW_WRITES:'0',HAL_BROKER_BIND:'127.0.0.1',HAL_BROKER_PORT:String(port),HAL_BROKER_STORE:join(dir,'proposals.json'),HAL_BROKER_MCP_CONFIG:join(dir,'no-call.json')},stdio:['ignore','ignore','pipe']});
 let stderr=''; proc.stderr.setEncoding('utf8').on('data',x=>stderr+=x);
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGKILL');await Promise.race([new Promise(r=>proc.once('exit',r)),delay(1000)]);}await rm(dir,{recursive:true,force:true});});
 let base=`http://127.0.0.1:${port}`, ready=false;
 for(let i=0;i<60;i++){try{let r=await fetch(base+'/healthz');if(r.ok){ready=true;break}}catch{} await delay(50)}
 assert.equal(ready,true,`service starts and health endpoint responds; stderr=${stderr}`);
 assert.equal((await request(base,'/v1/proposals')).status,401,'unauthenticated request rejected');
 assert.equal((await request(base,'/v1/capabilities',{token:workerToken})).status,401,'worker cannot inspect/decide');
 const created=await request(base,'/v1/proposals',{token:workerToken,method:'POST',headers:{'idempotency-key':'addon-smoke-001'},body:{proposal:smokeProposal,sessionKey:'agent:hal-worker:smoke'}});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const journal=JSON.parse(await readFile(join(dir,'proposals.json'),'utf8'));
 assert.ok(journal.proposals[created.body.proposalId]);
 const listed=await request(base,'/v1/proposals',{token:readToken});
 assert.equal(listed.status,200); assert.equal(listed.body.proposals.length,1);
 const attempted=await request(base,`/v1/proposals/${created.body.proposalId}/approve-native`,{token:readToken,method:'POST',headers:{'x-ha-user-id':'admin','x-ha-user-admin':'true'},body:{content_hash:created.body.contentHash,validated_by_ha:true}});
 assert.equal(attempted.status,423,'write remains blocked despite authenticated approval request');
 const after=JSON.parse(await readFile(join(dir,'proposals.json'),'utf8'));
 assert.equal(after.proposals[created.body.proposalId].status,'pending','blocked approval did not consume proposal');
});
