import http from 'node:http';
import { tokenRole, routeAllowed } from './authz.mjs';
import { AutomationApprovalBroker, FileProposalStore } from './broker.mjs';
import { HaMcpAutomationAdapter } from './ha-mcp-adapter.mjs';
import { createMcporterInvoker } from './mcporter-invoker.mjs';

const env=process.env;
for(const k of ['HAL_BROKER_WORKER_TOKEN','HAL_BROKER_HA_TOKEN','HAL_BROKER_HMAC_KEY']) if(!env[k]) throw new Error(`${k} required`);
if(env.HAL_BROKER_WORKER_TOKEN===env.HAL_BROKER_HA_TOKEN) throw new Error('Worker and HA tokens must be distinct');
const workerToken=Buffer.from(env.HAL_BROKER_WORKER_TOKEN),haToken=Buffer.from(env.HAL_BROKER_HA_TOKEN);
const allowWrites=env.HAL_BROKER_ALLOW_WRITES==='1';
const mcp=createMcporterInvoker({configPath:env.HAL_BROKER_MCP_CONFIG||'/config/clawd/config/mcporter.json',allowWrites});
const api=new HaMcpAutomationAdapter({...mcp,allowWrites});
const verifyDisplayedProposal=async(receipt,expected)=>receipt?.nativeHaApproval===true&&receipt.proposalId===expected.proposalId&&receipt.contentHash===expected.contentHash&&typeof receipt.approverId==='string'&&receipt.approverId.length>0;
const broker=new AutomationApprovalBroker({store:new FileProposalStore(env.HAL_BROKER_STORE||'./data/proposals.json'),api,secret:Buffer.from(env.HAL_BROKER_HMAC_KEY,'base64'),verifyDisplayedProposal,pilotSafeOnly:true});
await broker.recoverInterrupted();
const json=(res,code,x)=>{const b=Buffer.from(JSON.stringify(x));res.writeHead(code,{'content-type':'application/json','content-length':b.length,'cache-control':'no-store'});res.end(b);};
const parseBody=async req=>{const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>131072)throw new BrokerError('TOO_LARGE','Request too large.');chunks.push(c);}return chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};};
import { BrokerError } from './broker.mjs';
const server=http.createServer(async(req,res)=>{
 try {
  const u=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&u.pathname==='/healthz')return json(res,200,{status:'ok',readOnly:true});
  const token=(req.headers.authorization||'').replace(/^Bearer /,'');
  const role=tokenRole(token,workerToken,haToken);
  if(!routeAllowed(role,req.method,u.pathname))return json(res,401,{error:'UNAUTHORIZED'});
  const body=await parseBody(req);
  if(req.method==='POST'&&u.pathname==='/v1/proposals'&&role==='worker'){
    const key=req.headers['idempotency-key'];if(typeof key!=='string'||key.length<8||key.length>128)return json(res,400,{error:'IDEMPOTENCY_KEY_REQUIRED'});
    const p=await broker.propose(body.proposal,{authenticated:true,agentId:'hal-worker',sessionKey:body.sessionKey,idempotencyKey:key});
    return json(res,201,p);
  }
  if(req.method==='GET'&&u.pathname==='/v1/capabilities')return json(res,200,{readOnly:!allowWrites,writesEnabled:allowWrites,policy:'pilot_safe_only'});
  if(req.method==='GET'&&u.pathname==='/v1/proposals')return json(res,200,{proposals:await broker.listRequests()});
  if(req.method==='POST'&&u.pathname==='/v1/recover')return json(res,200,{recovered:await broker.recoverInterrupted()});
  const m=u.pathname.match(/^\/v1\/proposals\/([0-9a-f-]+)\/(approve-native|reject|validation-failed)$/);
  if(req.method==='POST'&&m){
    const [,id,action]=m,userId=req.headers['x-ha-user-id'];
    if(typeof userId!=='string'||!userId||req.headers['x-ha-user-admin']!=='true')return json(res,403,{error:'HA_ADMIN_REQUIRED'});
    if(action==='reject')return json(res,200,await broker.reject(id,{authenticated:true,userId,isAdmin:true}));
    if(action==='validation-failed')return json(res,200,await broker.markValidationFailedFromHa({proposalId:id,contentHash:body.content_hash,approver:{authenticated:true,userId,isAdmin:true}}));
    if(!allowWrites)return json(res,423,{error:'WRITE_DISABLED',message:'Approval/apply is disabled in read-only mode.'});
    if(body.validated_by_ha!==true)return json(res,422,{error:'VALIDATION_REQUIRED'});
    return json(res,200,await broker.approveFromHa({proposalId:id,contentHash:body.content_hash,validatedByHa:true,approver:{authenticated:true,userId,isAdmin:true}}));
  }
  return json(res,404,{error:'NOT_FOUND'});
 } catch(e) {
  const code=e.code||'REQUEST_FAILED',status=({AUTH_REQUIRED:403,HA_ADMIN_REQUIRED:403,REPLAY_OR_STALE:409,STALE_TARGET:409,EXPIRED:410,WRITE_DISABLED:423,VALIDATION_REQUIRED:422,PILOT_POLICY:422})[code]||400;
  return json(res,status,{error:code,message:e.message||'Request failed'});
 }
});
server.listen(Number(env.HAL_BROKER_PORT||8765),env.HAL_BROKER_BIND||'127.0.0.1');
