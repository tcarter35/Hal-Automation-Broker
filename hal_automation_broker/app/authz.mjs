import { timingSafeEqual } from 'node:crypto';

export function tokenRole(candidate, workerToken, haToken) {
  const supplied=Buffer.from(candidate||'');
  if(supplied.length===workerToken.length&&timingSafeEqual(supplied,workerToken))return 'worker';
  if(supplied.length===haToken.length&&timingSafeEqual(supplied,haToken))return 'ha';
  return null;
}
export function routeAllowed(role,method,path) {
  if(role==='worker')return method==='POST'&&path==='/v1/proposals';
  if(role==='ha')return (method==='GET'&&['/v1/proposals','/v1/capabilities'].includes(path))||(method==='POST'&&(path==='/v1/recover'||/^\/v1\/proposals\/[0-9a-f-]+\/(approve-native|reject|validation-failed)$/.test(path)));
  return false;
}