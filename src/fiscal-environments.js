import {fiscalError} from './fiscal-core.js';

export const FISCAL_TIME_ZONE='America/Sao_Paulo';
export const DEFAULT_FISCAL_POLICY={defaultEnvironment:2,registerEnvironments:{},schedules:[]};
const DAY_MS=86400000;
// 0 pauses automatic issuance; it is never used as XML tpAmb.
const environment=value=>value===0 || value===1 || value===2;
const fail=(ok,code)=>{if(!ok)throw fiscalError(code);};
const object=value=>value && typeof value==='object' && !Array.isArray(value);
function registerId(value) {
  fail((typeof value==='string' || Number.isSafeInteger(value)) && /^[1-9]\d{0,18}$/.test(String(value)) &&
    BigInt(value)<=9223372036854775807n,'INVALID_FISCAL_REGISTER');
  return String(value);
}
function dateDay(value) {
  if(value==null || value==='')return null;
  fail(typeof value==='string' && /^20\d{2}-\d{2}-\d{2}$/.test(value),'INVALID_FISCAL_SCHEDULE_DATE');
  const ms=Date.parse(value+'T00:00:00Z');
  fail(Number.isFinite(ms) && new Date(ms).toISOString().slice(0,10)===value,'INVALID_FISCAL_SCHEDULE_DATE');
  return ms/DAY_MS;
}
function minutes(value) {
  fail(typeof value==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value),'INVALID_FISCAL_SCHEDULE_TIME');
  return Number(value.slice(0,2))*60+Number(value.slice(3));
}
const weekday=day=>((day+4)%7+7)%7;
const duration=s=>{if(s.allDay)return 1440;const start=minutes(s.startTime),end=minutes(s.endTime);return end>start?end-start:end+1440-start;};
function dateAllows(s,day) {
  return (s.startsOn==null || day>=dateDay(s.startsOn)) && (s.endsOn==null || day<=dateDay(s.endsOn));
}
function overlap(a,b) {
  const aStart=minutes(a.startTime),aEnd=aStart+duration(a),bStart=minutes(b.startTime),bEnd=bStart+duration(b);
  for(const day of a.weekdays)for(const delta of [-1,0,1]) {
    if(!b.weekdays.includes((day+delta+7)%7))continue;
    if(aStart>=bEnd+delta*1440 || bStart+delta*1440>=aEnd)continue;
    const low=Math.max(dateDay(a.startsOn) ?? -Infinity,(dateDay(b.startsOn) ?? -Infinity)-delta);
    const high=Math.min(dateDay(a.endsOn) ?? Infinity,(dateDay(b.endsOn) ?? Infinity)-delta);
    if(low>high)continue;
    if(!Number.isFinite(low) || !Number.isFinite(high))return true;
    const first=low+(day-weekday(low)+7)%7;
    if(first<=high)return true;
  }
  return false;
}

export function validateFiscalPolicy(value,knownRegisters) {
  fail(object(value) && environment(value.defaultEnvironment) && object(value.registerEnvironments) &&
    Array.isArray(value.schedules) && value.schedules.length<=100,'INVALID_FISCAL_POLICY');
  fail(Object.keys(value.registerEnvironments).length<=1000,'INVALID_FISCAL_POLICY');
  const assertKnown=id=>fail(!knownRegisters || knownRegisters.has(id),'FISCAL_REGISTER_NOT_FOUND');
  const registerEnvironments={};
  for(const [rawId,env] of Object.entries(value.registerEnvironments)) {
    const id=registerId(rawId);assertKnown(id);fail(environment(env),'INVALID_FISCAL_ENVIRONMENT');
    registerEnvironments[id]=env;
  }
  const seen=new Set();
  const schedules=value.schedules.map(s=>{
    fail(object(s) && typeof s.id==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) && !seen.has(s.id),
      'INVALID_FISCAL_SCHEDULE_ID');seen.add(s.id);
    fail(typeof s.name==='string' && s.name.trim().length>0 && s.name.trim().length<=100 && !/[\r\n\0]/.test(s.name),
      'INVALID_FISCAL_SCHEDULE_NAME');
    fail(typeof s.enabled==='boolean' && environment(s.environment),'INVALID_FISCAL_ENVIRONMENT');
    fail(Array.isArray(s.weekdays) && s.weekdays.length>0 && s.weekdays.length<=7 &&
      s.weekdays.every(n=>Number.isInteger(n)&&n>=0&&n<=6) && new Set(s.weekdays).size===s.weekdays.length,
      'INVALID_FISCAL_SCHEDULE_DAYS');
    fail(s.allDay==null || typeof s.allDay==='boolean','INVALID_FISCAL_SCHEDULE_TIME');
    const allDay=s.allDay===true,startTime=allDay?'00:00':s.startTime,endTime=allDay?'00:00':s.endTime;
    fail(allDay || minutes(startTime)!==minutes(endTime),'FISCAL_SCHEDULE_EMPTY_WINDOW');
    const start=dateDay(s.startsOn),end=dateDay(s.endsOn);
    fail(start==null || end==null || start<=end,'INVALID_FISCAL_SCHEDULE_DATE_RANGE');
    fail(start==null || end==null || s.weekdays.some(day=>start+(day-weekday(start)+7)%7<=end),
      'FISCAL_SCHEDULE_NO_OCCURRENCE');
    fail(Array.isArray(s.registerIds) && s.registerIds.length<=1000,'INVALID_FISCAL_REGISTER');
    const registerIds=s.registerIds.map(registerId);registerIds.forEach(assertKnown);
    fail(new Set(registerIds).size===registerIds.length,'INVALID_FISCAL_REGISTER');
    return {id:s.id,name:s.name.trim(),enabled:s.enabled,environment:s.environment,
      weekdays:[...s.weekdays].sort(),startTime,endTime,allDay,
      startsOn:start==null?null:s.startsOn,endsOn:end==null?null:s.endsOn,registerIds};
  });
  for(let i=0;i<schedules.length;i++)for(let j=i+1;j<schedules.length;j++) {
    const a=schedules[i],b=schedules[j];if(!a.enabled || !b.enabled)continue;
    // A rule for selected PDVs overrides a service-wide rule. Equal scopes cannot overlap.
    const sameScope=(!a.registerIds.length && !b.registerIds.length) ||
      (a.registerIds.length && b.registerIds.length && a.registerIds.some(id=>b.registerIds.includes(id)));
    fail(!sameScope || !overlap(a,b),'FISCAL_SCHEDULE_OVERLAP');
  }
  return {defaultEnvironment:value.defaultEnvironment,registerEnvironments,schedules};
}

function localClock(now) {
  const date=new Date(now);fail(Number.isFinite(date.getTime()),'INVALID_FISCAL_POLICY_TIME');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:FISCAL_TIME_ZONE,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .formatToParts(date).map(p=>[p.type,p.value]));
  const day=Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`)/DAY_MS;
  return {day,minute:Number(parts.hour)*60+Number(parts.minute)};
}
function activeSchedule(s,clock) {
  if(s.allDay)return s.weekdays.includes(weekday(clock.day)) && dateAllows(s,clock.day);
  const start=minutes(s.startTime),end=minutes(s.endTime);
  let anchor=clock.day;
  if(end>start) {if(clock.minute<start || clock.minute>=end)return false;}
  else if(clock.minute>=start) { /* start day */ }
  else if(clock.minute<end)anchor--;
  else return false;
  return s.weekdays.includes(weekday(anchor)) && dateAllows(s,anchor);
}
export function resolveFiscalEnvironment(config,rawId,now=Date.now(),revision='1') {
  const id=registerId(rawId),clock=localClock(now);
  const matches=config.schedules.filter(s=>s.enabled && (!s.registerIds.length || s.registerIds.includes(id)) &&
    activeSchedule(s,clock));
  const specific=matches.filter(s=>s.registerIds.length),selected=specific.length?specific:matches;
  fail(selected.length<=1,'FISCAL_SCHEDULE_OVERLAP');
  const schedule=selected[0],override=config.registerEnvironments[id];
  return {environment:schedule?.environment ?? override ?? config.defaultEnvironment,
    source:schedule?'SCHEDULE':override==null?'SERVICE_DEFAULT':'REGISTER_DEFAULT',
    scheduleId:schedule?.id || null,scheduleName:schedule?.name || null,
    policyRevision:String(revision),timeZone:FISCAL_TIME_ZONE,selectedAt:new Date(now).toISOString()};
}

export async function readFiscalPolicy(client) {
  const row=(await client.query('SELECT revision,config,updated_by,updated_at FROM fiscal_environment_policy WHERE id=1')).rows[0];
  if(!row)throw fiscalError('FISCAL_POLICY_NOT_CONFIGURED');
  return {...row,revision:String(row.revision)};
}
export async function currentFiscalEnvironment(client,id,now=Date.now()) {
  const policy=await readFiscalPolicy(client);
  const route=resolveFiscalEnvironment(policy.config,id,now,policy.revision);
  return {...route,productionEnabled:false,automaticIssuanceEnabled:route.environment!==0,
    readiness:route.environment===0?'DISABLED':route.environment===1?'PRODUCTION_NOT_READY':'HOMOLOGATION'};
}

// Only the first accepted sale resolves the clock. Replays and workers use this persisted decision.
export async function pinFiscalEnvironment(client,sale,now=Date.now()) {
  const existing=(await client.query('SELECT decision FROM fiscal_sale_environments WHERE sale_id=$1',[sale.id])).rows[0];
  if(existing)return existing.decision;
  const policy=await readFiscalPolicy(client);
  const decision=resolveFiscalEnvironment(policy.config,sale.register_id,now,policy.revision);
  const clientEnvironment=sale.raw_payload?.fiscalEnvironment;
  if(clientEnvironment!==undefined) {
    if(!environment(clientEnvironment))decision.issue='INVALID_FISCAL_ENVIRONMENT';
    // A server-side pause is safe even when a PDV still reports its old mode.
    // No document is created; a manual action must choose the real environment.
    else if(clientEnvironment!==decision.environment && decision.environment!==0)
      decision.issue='FISCAL_ENVIRONMENT_CHANGED';
  }
  await client.query(`INSERT INTO fiscal_sale_environments(sale_id,environment,policy_revision,decision,selected_at)
    VALUES($1,$2,$3,$4,$5)`,[sale.id,decision.environment,decision.policyRevision,JSON.stringify(decision),decision.selectedAt]);
  return decision;
}
