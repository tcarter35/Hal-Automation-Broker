import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { BrokerError } from './broker.mjs';
const execFile=promisify(execFileCb);
const READ_TOOLS=new Set(['ha_config_get_automation','ha_search']);

export function createMcporterInvoker({configPath='/config/clawd/config/mcporter.json',allowWrites=false,execFileImpl=execFile}={}) {
  async function invoke(name,args,write) {
    if(write && !allowWrites) throw new BrokerError('WRITE_DISABLED','MCP automation writes are disabled by default.');
    if(write ? name!=='ha_config_set_automation' : !READ_TOOLS.has(name)) throw new BrokerError('TOOL_NOT_ALLOWED','MCP tool is outside the broker adapter allowlist.');
    const argv=['--config',configPath,'call',`home-assistant.${name}`,...Object.entries(args).map(([k,v])=>`${k}=${typeof v==='string'?v:JSON.stringify(v)}`)];
    try {
      const {stdout}=await execFileImpl('mcporter',argv,{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
      return JSON.parse(stdout.trim());
    } catch (err) {
      if(err instanceof BrokerError) throw err;
      throw new BrokerError(write?'WRITE_OUTCOME_UNKNOWN':'MCP_READ_FAILED',write?'MCP write outcome is unknown; inspect HA before retrying.':'Home Assistant read failed.');
    }
  }
  return {callRead:(name,args)=>invoke(name,args,false),callWrite:(name,args)=>invoke(name,args,true)};
}
