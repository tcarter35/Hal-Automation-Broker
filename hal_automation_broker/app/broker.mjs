import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE = new Set(['light', 'notify']);
const SAFE_ENTITY_DOMAINS = new Set(['light','notify']);
export class BrokerError extends Error { constructor(code, message) { super(message); this.code = code; } }
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const clone = x => JSON.parse(JSON.stringify(x));
const canon = x => Array.isArray(x) ? '[' + x.map(canon).join(',') + ']' : isObj(x) ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k)+':'+canon(x[k])).join(',') + '}' : JSON.stringify(x);
const hash = x => createHash('sha256').update(x).digest('hex');
const matchesAppliedConfig = (actual, expected, operation) => { if (!isObj(actual)) return false; const got=clone(actual); if(operation==='create') delete got.id; return canon(got)===canon(expected); };
const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');

function checkTree(x, depth=0) {
  if (depth > 24) throw new BrokerError('INVALID_CONFIG','Configuration too deep.');
  if (Array.isArray(x)) return x.forEach(v=>checkTree(v,depth+1));
  if (isObj(x)) return Object.entries(x).forEach(([k,v])=>{ if(FORBIDDEN.has(k)) throw new BrokerError('INVALID_CONFIG','Forbidden object key.'); checkTree(v,depth+1); });
  if (x !== null && !['string','number','boolean'].includes(typeof x)) throw new BrokerError('INVALID_CONFIG','Unsupported value.');
  if (typeof x === 'number' && !Number.isFinite(x)) throw new BrokerError('INVALID_CONFIG','Invalid number.');
}
function refsOf(x, out=new Set()) {
  if(Array.isArray(x)) { x.forEach(v=>refsOf(v,out)); return out; }
  if(!isObj(x)) return out;
  for(const [k,v] of Object.entries(x)) {
    if(k==='entity_id'||k==='entity_ids') for(const id of Array.isArray(v)?v:[v]) {
      if(typeof id!=='string'||!/^([a-z_][a-z0-9_]*)\.([a-z0-9_]+)$/.test(id)) throw new BrokerError('INVALID_REFERENCE','Entity references must be explicit entity IDs.');
      out.add(id);
    } else refsOf(v,out);
  }
  return out;
}
function validateConfig(c, op, old) {
  if(!isObj(c)||Buffer.byteLength(canon(c))>65536) throw new BrokerError('INVALID_CONFIG','Provide a bounded configuration object.');
  checkTree(c);
  if(typeof c.alias!=='string'||!c.alias.trim()||!Array.isArray(c.triggers)||!c.triggers.length||!Array.isArray(c.actions)||!c.actions.length)
    throw new BrokerError('INVALID_CONFIG','Require an alias, trigger, and action.');
  if(c.python_transform!==undefined||c.use_blueprint!==undefined) throw new BrokerError('UNSUPPORTED_CONFIG','Transforms and blueprints are unsupported.');
  if(op==='create'&&Object.hasOwn(c,'id')) throw new BrokerError('INVALID_CONFIG','Creation must use an HA-generated ID.');
  if(op==='update'&&(!old?.id||c.id!==old.id)) throw new BrokerError('INVALID_CONFIG','An update must preserve the existing automation ID.');
  return clone(c);
}
function pilotSafe(c, operation, old) {
  if (!c.alias.startsWith('HAL Approval Pilot -')) throw new BrokerError('PILOT_POLICY','Pilot aliases must start with HAL Approval Pilot -.');
  if (operation === 'update' && (!old?.alias?.startsWith('HAL Approval Pilot -') || c.id !== old.id)) throw new BrokerError('PILOT_POLICY','Pilot updates may target only an existing pilot automation.');
  if (c.triggers.length !== 1 || c.triggers[0]?.trigger !== 'state' || c.triggers[0]?.entity_id !== 'input_boolean.hal_approval_test_trigger') throw new BrokerError('PILOT_POLICY','Pilot automations may only use the disposable HA approval test helper trigger.');
  if (c.conditions && c.conditions.length) throw new BrokerError('PILOT_POLICY','Pilot automations may not contain conditions.');
  if (c.actions.length !== 1 || c.actions[0]?.action !== 'persistent_notification.create' || typeof c.actions[0]?.data?.message !== 'string' || c.actions[0].target || c.actions[0].entity_id) throw new BrokerError('PILOT_POLICY','Pilot action must only create a local persistent notification.');
}
function riskOf(c) {
  let high=false;
  const visit=x=>{
    if(Array.isArray(x)) return x.forEach(visit);
    if(!isObj(x)) return;
    const action=typeof x.action==='string'?x.action:typeof x.service==='string'?x.service:null;
    if(action) {
      const [domain, service] = action.split('.');
      if(!SAFE.has(domain)||!service||service.includes('.')||!['turn_on','turn_off','toggle','notify'].includes(service)) high=true;
      const target=x.target?.entity_id??x.entity_id, ids=Array.isArray(target)?target:[target];
      if(ids.some(id=>typeof id!=='string'||!SAFE_ENTITY_DOMAINS.has(id.split('.')[0]))) high=true;
    }
    if((Object.hasOwn(x,'action')||Object.hasOwn(x,'service'))&&!action) high=true;
    if(x.type&&!['turn_on','turn_off','state','time','sun','numeric_state','template','device','event','homeassistant'].includes(x.type)) high=true;
    Object.values(x).forEach(visit);
  };
  visit(c); return high?'sensitive':'routine';
}

/** Atomic single-process journal; any extant lock fails closed. */
export class FileProposalStore {
  constructor(path){this.path=path;this.lockPath=path+'.lock';}
  async transact(fn){
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});
    let lock; try{lock=await open(this.lockPath,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new BrokerError('STORE_BUSY','Journal locked; no change made.');throw new BrokerError('STORE_UNAVAILABLE','Journal lock unavailable; no change made.');}
    try{
      let s; try{s=JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code==='ENOENT')s={proposals:{},used:[]};else throw new BrokerError('STORE_UNAVAILABLE','Journal unreadable; no change made.');}
      if(!isObj(s)||!isObj(s.proposals)||!Array.isArray(s.used))throw new BrokerError('STORE_UNAVAILABLE','Journal invalid; no change made.');
      const result=await fn(s), tmp=this.path+'.'+randomBytes(8).toString('hex')+'.tmp', f=await open(tmp,'wx',0o600);
      try{await f.writeFile(JSON.stringify(s));await f.sync();}finally{await f.close();}
      try { await rename(tmp,this.path); const dir=await open(dirname(this.path),'r'); try{await dir.sync();}finally{await dir.close();} }
      catch(e){await unlink(tmp).catch(()=>{});throw new BrokerError('STORE_UNAVAILABLE','Journal commit failed; no change made.');}
      return result;
    }finally{await lock.close();await unlink(this.lockPath).catch(()=>{});}
  }
}

export class AutomationApprovalBroker {
  proposalReceipt(p){
    const ticketData={id:p.id,contentHash:p.contentHash,sessionKey:p.sessionKey,nonce:p.nonce,expiresAt:p.expiresAt};
    const body=b64(ticketData), approvalTicket=body+'.'+createHmac('sha256',this.secret).update(body).digest('base64url');
    return Object.freeze({proposalId:p.id,contentHash:p.contentHash,approvalTicket,expiresAt:p.expiresAt,operation:p.operation,targetEntityId:p.targetEntityId,risk:p.risk,config:clone(p.config)});
  }
  constructor({store,api,secret,verifyDisplayedProposal=async()=>false,now=()=>Date.now(),ttlMs=120000,pilotSafeOnly=false}){
    if(!store||!api||typeof api.getAutomation!=='function'||typeof api.setAutomation!=='function'||typeof api.entityExists!=='function')throw new TypeError('Narrow automation API required.');
    if(!Buffer.isBuffer(secret)||secret.length<32)throw new TypeError('32-byte signing key required.');
    if(!Number.isSafeInteger(ttlMs)||ttlMs<10000||ttlMs>300000)throw new TypeError('TTL must be 10-300 seconds.');
    if(typeof verifyDisplayedProposal!=='function')throw new TypeError('Trusted UI attestation verifier required.');
    Object.assign(this,{store,api,secret,verifyDisplayedProposal,now,ttlMs,pilotSafeOnly});
  }
  async propose({operation,targetEntityId=null,config},ctx){
    if(ctx?.authenticated!==true||ctx?.agentId!=='hal-worker'||typeof ctx.sessionKey!=='string'||!ctx.sessionKey.startsWith('agent:hal-worker:'))throw new BrokerError('UNTRUSTED_CONTEXT','Proposal must come from authenticated Hal worker route.');
    if(!['create','update'].includes(operation))throw new BrokerError('UNSUPPORTED_OPERATION','Only create and update are supported.');
    let old=null;
    if(operation==='update'){
      if(typeof targetEntityId!=='string'||!targetEntityId.startsWith('automation.'))throw new BrokerError('INVALID_TARGET','Automation entity ID required.');
      old=await this.api.getAutomation(targetEntityId);
      if(!old||old.validationError||typeof old.config_hash!=='string'||!isObj(old.config))throw new BrokerError('TARGET_UNAVAILABLE','Current automation unavailable.');
    }else if(targetEntityId!==null)throw new BrokerError('INVALID_TARGET','Create cannot target an existing automation.');
    const safe=validateConfig(config,operation,old?.config);
    if(this.pilotSafeOnly)pilotSafe(safe,operation,old?.config);
    if(typeof this.api.validateAutomation==='function'){const validation=await this.api.validateAutomation(safe);if(validation!==true)throw new BrokerError('INVALID_CONFIG',typeof validation==='string'?validation:'Home Assistant rejected the automation configuration.');}
    for(const id of refsOf(safe))if(await this.api.entityExists(id)!==true)throw new BrokerError('INVALID_REFERENCE','Entity reference not confirmed.');
    const id=randomUUID(), contentHash=hash(canon({operation,targetEntityId,config:safe})), expiresAt=this.now()+this.ttlMs;
    const ticketData={id,contentHash,sessionKey:ctx.sessionKey,nonce:randomBytes(24).toString('base64url'),expiresAt};
    const fingerprint=hash(canon({operation,targetEntityId,config:safe,sessionKey:ctx.sessionKey}));
    return this.store.transact(s=>{
      if(typeof ctx.idempotencyKey==='string'&&ctx.idempotencyKey){
        if(!isObj(s.idempotency))s.idempotency={};
        const key=hash(JSON.stringify([ctx.agentId,ctx.sessionKey,ctx.idempotencyKey])), prior=s.idempotency[key];
        if(prior){
          if(prior.fingerprint!==fingerprint)throw new BrokerError('IDEMPOTENCY_KEY_REUSED','Idempotency key was already used for a different proposal.');
          const existing=s.proposals[prior.proposalId];
          if(!existing)throw new BrokerError('STORE_UNAVAILABLE','Idempotency record references a missing proposal.');
          return this.proposalReceipt(existing);
        }
        const p={id,contentHash,operation,targetEntityId,config:safe,risk:riskOf(safe),sessionKey:ctx.sessionKey,nonce:ticketData.nonce,expiresAt,status:'pending',old:old?{config:clone(old.config),config_hash:old.config_hash,enabled:old.enabled}:null,createdAt:this.now(),idempotencyKey:ctx.idempotencyKey};
        s.proposals[id]=p;s.idempotency[key]={fingerprint,proposalId:id};
        return this.proposalReceipt(p);
      }
      const p={id,contentHash,operation,targetEntityId,config:safe,risk:riskOf(safe),sessionKey:ctx.sessionKey,nonce:ticketData.nonce,expiresAt,status:'pending',old:old?{config:clone(old.config),config_hash:old.config_hash,enabled:old.enabled}:null,createdAt:this.now(),idempotencyKey:null};
      s.proposals[id]=p;
      return this.proposalReceipt(p);
    });
  }
  async approveFromHa({proposalId,contentHash,approver,validatedByHa=false}) {
    if (validatedByHa !== true) throw new BrokerError('VALIDATION_REQUIRED','HA Core validation is required before approval.');
    if (approver?.authenticated !== true || approver?.isAdmin !== true || typeof approver.userId !== 'string' || !approver.userId || approver.userId === 'hal-worker') throw new BrokerError('AUTH_REQUIRED','Authenticated HA administrator approval required.');
    const ticketData = await this.store.transact(s => {
      const p=s.proposals[proposalId];
      if(!p||p.status!=='pending'||p.expiresAt<=this.now()||p.contentHash!==contentHash||hash(canon({operation:p.operation,targetEntityId:p.targetEntityId,config:p.config}))!==p.contentHash) throw new BrokerError('REPLAY_OR_STALE','Proposal is stale, changed, unknown, or already decided.');
      return {id:p.id,contentHash:p.contentHash,sessionKey:p.sessionKey,nonce:p.nonce,expiresAt:p.expiresAt};
    });
    const body=b64(ticketData), approvalTicket=body+'.'+createHmac('sha256',this.secret).update(body).digest('base64url');
    const displayReceipt={nativeHaApproval:true,proposalId,contentHash,approverId:approver.userId};
    return this.approveAndApply({approvalTicket,contentHash,displayReceipt,trustedConversationSession:ticketData.sessionKey,approver:{authenticated:true,userId:approver.userId,isAdmin:true}});
  }
  parseTicket(ticket){
    if(typeof ticket!=='string'||ticket.length>4096)throw new BrokerError('INVALID_APPROVAL','Invalid approval ticket.');
    const p=ticket.split('.'); if(p.length!==2)throw new BrokerError('INVALID_APPROVAL','Invalid approval ticket.');
    const expected=createHmac('sha256',this.secret).update(p[0]).digest(), got=Buffer.from(p[1],'base64url');
    if(expected.length!==got.length||!timingSafeEqual(expected,got))throw new BrokerError('INVALID_APPROVAL','Invalid approval ticket.');
    try{return JSON.parse(Buffer.from(p[0],'base64url').toString());}catch{throw new BrokerError('INVALID_APPROVAL','Invalid approval ticket.');}
  }
  async approveAndApply({approvalTicket,contentHash,displayReceipt,trustedConversationSession,approver}){
    const t=this.parseTicket(approvalTicket);
    if(t.expiresAt<=this.now())throw new BrokerError('EXPIRED','Proposal expired.');
    if(t.contentHash!==contentHash||t.sessionKey!==trustedConversationSession)throw new BrokerError('CONTEXT_MISMATCH','Approval does not match proposal and conversation.');
    if(approver?.authenticated!==true||typeof approver.userId!=='string'||!approver.userId||approver.userId==='hal-worker')throw new BrokerError('AUTH_REQUIRED','Authenticated HA user approval required.');
    const r=await this.store.transact(async s=>{
      const p=s.proposals[t.id];
      if(!p||p.status!=='pending'||p.contentHash!==t.contentHash||hash(canon({operation:p.operation,targetEntityId:p.targetEntityId,config:p.config}))!==p.contentHash||p.sessionKey!==t.sessionKey||p.nonce!==t.nonce||p.expiresAt!==t.expiresAt||s.used.includes(t.nonce))throw new BrokerError('REPLAY_OR_STALE','Proposal stale, unknown, or used.');
      let displayed=false;try{displayed=await this.verifyDisplayedProposal(displayReceipt,{proposalId:p.id,contentHash:p.contentHash,sessionKey:trustedConversationSession,expiresAt:p.expiresAt});}catch{}
      if(displayed!==true)throw new BrokerError('DISPLAY_REQUIRED','Authenticated approval must attest that this exact proposal was displayed.');
      if(p.risk==='sensitive'&&approver.mfaVerified!==true&&!this.pilotSafeOnly)throw new BrokerError('STRONG_AUTH_REQUIRED','Sensitive proposal requires strong authentication.');
      s.used.push(t.nonce);p.status='applying';p.approvedBy=approver.userId;return clone(p);
    });
    let automationId=null, after=null;
    try{
      for(const id of refsOf(r.config))if(await this.api.entityExists(id)!==true)throw new BrokerError('INVALID_REFERENCE','Entity reference changed.');
      if(r.operation==='update'){
        const cur=await this.api.getAutomation(r.targetEntityId);
        if(!cur||cur.validationError||!isObj(cur.config)||typeof cur.config_hash!=='string'||cur.config_hash!==r.old.config_hash)throw new BrokerError('STALE_TARGET','Automation changed or failed validation after draft.');
      }
      let result, writeFailed=false;
      try { result=await this.api.setAutomation(r.operation==='create'?{config:clone(r.config)}:{entity_id:r.targetEntityId,config_hash:r.old.config_hash,config:clone(r.config)}); }
      catch { writeFailed=true; }
      if(writeFailed&&r.operation==='update'){
        // HA may commit a request before a client timeout/error. Read back before
        // deciding the write failed, and restore only if the target actually changed.
        after=await this.api.getAutomation(r.targetEntityId);
        if(after&&matchesAppliedConfig(after.config,r.config,r.operation)&&!after.validationError){
          automationId=r.targetEntityId;
          await this.finish(r.id,'manual_recovery_required','WRITE_COMMITTED_RELOAD_UNCONFIRMED');
          throw new BrokerError('APPLY_COMMITTED_RELOAD_UNCONFIRMED','Config read-back matches, but the write response/reload completion was lost; inspect HA before retrying.');
        }
        if(after&&after.config_hash!==r.old.config_hash){
          const restored=await this.rollback(r,r.targetEntityId,after);
          await this.finish(r.id,restored?'rolled_back':'manual_recovery_required');
          throw new BrokerError(restored?'APPLY_FAILED_ROLLED_BACK':'APPLY_FAILED_ROLLBACK_UNCERTAIN',
            restored?'Write response failed; previous config restored.':'Write response failed and rollback is uncertain; inspect HA UI.');
        }
        await this.finish(r.id,'apply_failed','WRITE_NOT_CONFIRMED');
        throw new BrokerError('APPLY_FAILED','Home Assistant did not confirm the requested change.');
      }
      if(writeFailed&&r.operation==='create'){
        await this.finish(r.id,'manual_recovery_required','CREATE_WRITE_OUTCOME_UNKNOWN');
        throw new BrokerError('CREATE_APPLY_UNCERTAIN','Create response failed; inspect Home Assistant before retrying.');
      }
      automationId=r.operation==='update'?r.targetEntityId:result?.automation_id;
      if(typeof automationId!=='string'||!automationId.startsWith('automation.'))throw new BrokerError('APPLY_UNCERTAIN','No verifiable automation ID returned.');
      after=await this.api.getAutomation(automationId);
      if(after&&matchesAppliedConfig(after.config,r.config,r.operation)&&!after.validationError){await this.finish(r.id,'applied');return{status:'applied',automationId,contentHash:r.contentHash};}
      if(r.operation==='update'){
        const restored=await this.rollback(r,automationId,after);
        await this.finish(r.id,restored?'rolled_back':'manual_recovery_required');
        throw new BrokerError(restored?'VERIFY_FAILED_ROLLED_BACK':'VERIFY_FAILED_ROLLBACK_UNCERTAIN',restored?'Verification failed; previous config restored.':'Verification/rollback uncertain; inspect HA UI.');
      }
      await this.api.setAutomation({entity_id:automationId,enabled:false}).catch(()=>{});
      await this.finish(r.id,'manual_recovery_required');
      throw new BrokerError('CREATE_VERIFY_FAILED','Creation unverified; disabled if identifiable, manual UI review required.');
    }catch(e){
      await this.store.transact(s=>{const p=s.proposals[r.id];if(p?.status==='applying'){p.status=e instanceof BrokerError&&['STALE_TARGET','INVALID_REFERENCE'].includes(e.code)?'rejected':'apply_failed';p.failureCode=e.code||'APPLY_FAILED';p.finishedAt=this.now();}}).catch(()=>{});
      if(e instanceof BrokerError)throw e;
      throw new BrokerError('APPLY_FAILED','Home Assistant did not confirm the requested change.');
    }
  }
  async rollback(r,id,after){
    // This API lacks a proven atomic compare-and-swap rollback primitive. A
    // read-then-write restore could overwrite another actor's intervening edit.
    return false;
  }
  async recoverInterrupted(){return this.store.transact(s=>{let count=0;for(const p of Object.values(s.proposals)){if(p.status==='applying'){p.status='manual_recovery_required';p.recoveredAt=this.now();p.failureCode='PROCESS_INTERRUPTED_DURING_APPLY';count++;}else if(p.status==='pending'&&p.expiresAt<=this.now()){p.status='expired';p.finishedAt=this.now();}}return count;});}
  async listRequests(){return this.store.transact(s=>Object.values(s.proposals).map(p=>({proposalId:p.id,idempotencyKey:p.idempotencyKey,status:p.status,operation:p.operation,targetEntityId:p.targetEntityId,contentHash:p.contentHash,expiresAt:p.expiresAt,risk:p.risk,config:clone(p.config),approvedBy:p.approvedBy??null,failureCode:p.failureCode??null})));}
  async markValidationFailedFromHa({proposalId,contentHash,approver}) {
    if(approver?.authenticated!==true||approver?.isAdmin!==true||typeof approver.userId!=='string'||!approver.userId)throw new BrokerError('AUTH_REQUIRED','Authenticated HA administrator required.');
    return this.store.transact(s=>{const p=s.proposals[proposalId];if(!p||p.status!=='pending'||p.contentHash!==contentHash||hash(canon({operation:p.operation,targetEntityId:p.targetEntityId,config:p.config}))!==p.contentHash)throw new BrokerError('REPLAY_OR_STALE','Proposal is stale, unknown, or already decided.');p.status='validation_failed';p.failureCode='HA_VALIDATION_FAILED';p.rejectedBy=approver.userId;p.finishedAt=this.now();return{status:p.status,proposalId:p.id};});
  }
  async reject(proposalId,approver){if(approver?.authenticated!==true||typeof approver.userId!=='string'||!approver.userId||approver.userId==='hal-worker')throw new BrokerError('AUTH_REQUIRED','Authenticated HA user decision required.');return this.store.transact(s=>{const p=s.proposals[proposalId];if(!p||p.status!=='pending')throw new BrokerError('REPLAY_OR_STALE','Proposal stale, unknown, or decided.');p.status='rejected';p.rejectedBy=approver.userId;p.finishedAt=this.now();return{status:p.status,proposalId:p.id};});}
  async finish(id,status,failureCode=null){await this.store.transact(s=>{const p=s.proposals[id];if(!p||p.status!=='applying')throw new BrokerError('STORE_UNAVAILABLE','Could not persist result.');p.status=status;p.finishedAt=this.now();if(failureCode)p.failureCode=failureCode;});}
}