/**
 * Contract-checked, READ-ONLY Home Assistant MCP adapter for the staging broker.
 * It can read through ha_config_get_automation and ha_search. Mutation arguments
 * are mapped for review, but setAutomation is permanently disabled in this build.
 */
import { BrokerError } from './broker.mjs';

const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x);

export function toSetAutomationArgs(input) {
  if (!isRecord(input) || !isRecord(input.config)) throw new BrokerError('INVALID_CONFIG','Automation config is required.');
  const allowed = new Set(['config','entity_id','config_hash']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw new BrokerError('UNSUPPORTED_OPERATION','Only full config create/update mappings are supported.');
  if (input.entity_id === undefined) {
    if (input.config_hash !== undefined) throw new BrokerError('INVALID_TARGET','Create cannot include config_hash.');
    return { config: structuredClone(input.config) };
  }
  if (typeof input.entity_id !== 'string' || !input.entity_id.startsWith('automation.')) throw new BrokerError('INVALID_TARGET','Automation entity ID required.');
  if (typeof input.config_hash !== 'string' || !input.config_hash) throw new BrokerError('STALE_TARGET','Update requires the stored config_hash.');
  return { entity_id: input.entity_id, config_hash: input.config_hash, config: structuredClone(input.config) };
}

export class HaMcpAutomationAdapter {
  constructor({ callRead, callWrite, allowWrites = false, validateAutomation }) {
    if (typeof callRead !== 'function') throw new TypeError('Read-only MCP invoker required.');
    if (typeof callWrite !== 'function') throw new TypeError('MCP write adapter required even when disabled.');
    Object.assign(this,{callRead,callWrite,allowWrites:allowWrites===true});
    if (typeof validateAutomation === 'function') this.validateAutomation = validateAutomation;
  }
  async getAutomation(entityId) {
    const raw = await this.callRead('ha_config_get_automation',{entity_id:entityId});
    if (!isRecord(raw) || raw.success === false || !isRecord(raw.config) || typeof raw.config_hash !== 'string') return null;
    return {
      automation_id: typeof raw.automation_id === 'string' ? raw.automation_id : entityId,
      config: structuredClone(raw.config),
      config_hash: raw.config_hash,
      validationError: raw.validation == null ? null : (typeof raw.validation === 'string' ? raw.validation : (raw.validation.error ?? raw.validation)),
      validation: raw.validation ?? null,
      references: raw.references ?? null,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.slice() : [],
    };
  }
  async entityExists(entityId) {
    const raw = await this.callRead('ha_search',{
      query:entityId,limit:10,exact_match:true,include_config:false,
      result_fields:['entity_id'],fields:['entities','partial','errors'],
    });
    if (!isRecord(raw) || raw.success !== true || raw.partial === true || (raw.errors?.length ?? 0) > 0) return false;
    return Array.isArray(raw.entities) && raw.entities.some(x=>x?.entity_id===entityId);
  }
  async setAutomation(input) {
    const args=toSetAutomationArgs(input);
    if (!this.allowWrites) throw new BrokerError('WRITE_DISABLED','Home Assistant automation writes are disabled by default.');
    const expectedOperation=args.entity_id?'updated':'created';
    const raw=await this.callWrite('ha_config_set_automation',{...args,wait:true});
    if (!isRecord(raw) || raw.success===false || raw.operation!==expectedOperation || typeof raw.automation_id!=='string' || !raw.automation_id.startsWith('automation.')) throw new BrokerError('APPLY_UNCERTAIN','HA write response did not match the verified response contract; inspect HA before retrying.');
    return {automation_id:raw.automation_id,operation:raw.operation,waited:true,raw};
  }
}
