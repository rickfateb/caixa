import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_FISCAL_POLICY,resolveFiscalEnvironment,validateFiscalPolicy} from '../src/fiscal-environments.js';
const config=changes=>({...structuredClone(DEFAULT_FISCAL_POLICY),...changes});
const rule=changes=>({id:'morning',name:'Teste da manhã',enabled:true,environment:2,weekdays:[5],
  startTime:'08:00',endTime:'10:00',startsOn:null,endsOn:null,registerIds:[],...changes});
const at=(policy,time,id='1')=>resolveFiscalEnvironment(validateFiscalPolicy(policy),id,Date.parse(time));
const reject=(policy,code)=>assert.throws(()=>validateFiscalPolicy(policy),e=>e.message===code);

test('register default overrides service default and unconfigured registers inherit it',()=>{
  const c=config({defaultEnvironment:1,registerEnvironments:{'1':2}});
  assert.equal(at(c,'2026-10-09T12:00:00Z').environment,2);
  assert.equal(at(c,'2026-10-09T12:00:00Z','2').environment,1);
  assert.equal(at(c,'2026-10-09T12:00:00Z').source,'REGISTER_DEFAULT');
});
test('weekly windows use Brasilia rather than UTC; start included and end excluded',()=>{
  const c=config({defaultEnvironment:1,schedules:[rule()]});
  assert.equal(at(c,'2026-10-09T10:59:59Z').environment,1);
  assert.equal(at(c,'2026-10-09T11:00:00Z').environment,2);
  assert.equal(at(c,'2026-10-09T12:59:59Z').environment,2);
  assert.equal(at(c,'2026-10-09T13:00:00Z').environment,1);
});
test('selected-register schedule overrides global schedule and other PDVs remain on the global rule',()=>{
  const c=config({schedules:[rule(),rule({id:'exception',environment:1,registerIds:['2']})]});
  assert.equal(at(c,'2026-10-09T09:00:00-03:00','1').environment,2);
  assert.equal(at(c,'2026-10-09T09:00:00-03:00','2').environment,1);
  assert.equal(at(c,'2026-10-09T09:00:00-03:00','2').scheduleId,'exception');
  assert.equal(at(c,'2026-10-09T10:00:00-03:00','2').environment,2);
});
test('overnight window belongs to its starting weekday and date, including the final night',()=>{
  const c=config({defaultEnvironment:1,schedules:[rule({startTime:'22:00',endTime:'02:00',
    startsOn:'2026-10-09',endsOn:'2026-10-09'})]});
  assert.equal(at(c,'2026-10-09T01:00:00-03:00').environment,1);
  assert.equal(at(c,'2026-10-09T22:00:00-03:00').environment,2);
  assert.equal(at(c,'2026-10-10T01:59:59-03:00').environment,2);
  assert.equal(at(c,'2026-10-10T02:00:00-03:00').environment,1);
  assert.equal(at(c,'2026-10-16T23:00:00-03:00').environment,1);
});
test('midnight and year rollover retain local weekday and correct date bounds',()=>{
  const c=config({defaultEnvironment:1,schedules:[rule({weekdays:[4],startsOn:'2026-12-31',
    endsOn:'2026-12-31',startTime:'23:00',endTime:'01:00'})]});
  assert.equal(at(c,'2027-01-01T03:30:00Z').environment,2);
  assert.equal(at(c,'2027-01-01T04:00:00Z').environment,1);
});
test('whole-day agendas cover midnight through the next midnight and require an occurrence within date bounds',()=>{
  const c=config({defaultEnvironment:1,schedules:[rule({allDay:true,startsOn:'2026-10-09',endsOn:'2026-10-09'})]});
  assert.equal(at(c,'2026-10-09T00:00:00-03:00').environment,2);
  assert.equal(at(c,'2026-10-09T23:59:59-03:00').environment,2);
  assert.equal(at(c,'2026-10-10T00:00:00-03:00').environment,1);
  reject(config({schedules:[rule({startsOn:'2026-10-10',endsOn:'2026-10-10'})]}),'FISCAL_SCHEDULE_NO_OCCURRENCE');
});
test('invalid environments, unknown PDVs and empty selection days are refused',()=>{
  reject(config({defaultEnvironment:'1'}),'INVALID_FISCAL_POLICY');
  reject(config({registerEnvironments:{'1':3}}),'INVALID_FISCAL_ENVIRONMENT');
  reject(config({schedules:[rule({weekdays:[]})]}),'INVALID_FISCAL_SCHEDULE_DAYS');
  assert.throws(()=>validateFiscalPolicy(config({schedules:[rule({registerIds:['2']})]}),new Set(['1'])),
    e=>e.message==='FISCAL_REGISTER_NOT_FOUND');
});
test('impossible dates, backwards date ranges and empty time windows are refused',()=>{
  reject(config({schedules:[rule({startsOn:'2026-02-30'})]}),'INVALID_FISCAL_SCHEDULE_DATE');
  reject(config({schedules:[rule({startsOn:'2026-10-10',endsOn:'2026-10-09'})]}),'INVALID_FISCAL_SCHEDULE_DATE_RANGE');
  reject(config({schedules:[rule({startTime:'08:00',endTime:'08:00'})]}),'FISCAL_SCHEDULE_EMPTY_WINDOW');
});
test('same-scope overlaps are rejected; touching windows are allowed',()=>{
  reject(config({schedules:[rule(),rule({id:'conflict',startTime:'09:00'})]}),'FISCAL_SCHEDULE_OVERLAP');
  assert.doesNotThrow(()=>validateFiscalPolicy(config({schedules:[rule(),rule({id:'next',startTime:'10:00',endTime:'11:00'})]})));
});
test('overnight overlaps are detected across adjacent date ranges and weekdays',()=>{
  reject(config({schedules:[rule({startTime:'22:00',endTime:'02:00',startsOn:'2026-10-09',endsOn:'2026-10-09'}),
    rule({id:'saturday',weekdays:[6],startTime:'01:00',endTime:'03:00',startsOn:'2026-10-10',endsOn:'2026-10-10'})]}),
    'FISCAL_SCHEDULE_OVERLAP');
});
test('disjoint PDVs and genuinely disjoint date ranges may have the same clock window',()=>{
  assert.doesNotThrow(()=>validateFiscalPolicy(config({schedules:[rule({registerIds:['1']}),rule({id:'other',registerIds:['2']})]})));
  assert.doesNotThrow(()=>validateFiscalPolicy(config({schedules:[rule({endsOn:'2026-10-09'}),rule({id:'future',startsOn:'2026-10-16'})]})));
});
test('disabled schedules do not affect resolution; enabling a conflicting schedule is refused',()=>{
  const c=config({defaultEnvironment:1,schedules:[rule({enabled:false}),rule({id:'active'})]});
  assert.equal(at(c,'2026-10-09T09:00:00-03:00').scheduleId,'active');
  c.schedules[0].enabled=true;reject(c,'FISCAL_SCHEDULE_OVERLAP');
});
test('an ambiguous stored configuration blocks resolution rather than choosing array order',()=>{
  const c=config({schedules:[rule(),rule({id:'bad-direct-db-edit',environment:1})]});
  assert.throws(()=>resolveFiscalEnvironment(c,'1',Date.parse('2026-10-09T09:00:00-03:00')),
    e=>e.message==='FISCAL_SCHEDULE_OVERLAP');
});

test('disabled service/PDV defaults and schedules participate in the same precedence rules',()=>{
  const c=config({defaultEnvironment:0,registerEnvironments:{'1':2},schedules:[
    rule({environment:1}),rule({id:'pause',environment:0,registerIds:['2']})]});
  assert.equal(at(c,'2026-10-09T07:59:59-03:00','1').environment,2);
  assert.equal(at(c,'2026-10-09T07:59:59-03:00','2').environment,0);
  assert.equal(at(c,'2026-10-09T08:00:00-03:00','1').environment,1);
  assert.equal(at(c,'2026-10-09T08:00:00-03:00','2').environment,0);
  assert.equal(at(c,'2026-10-09T08:00:00-03:00','2').scheduleId,'pause');
  assert.equal(at(c,'2026-10-09T10:00:00-03:00','1').environment,2);
  assert.equal(at(c,'2026-10-09T10:00:00-03:00','2').environment,0);
  reject(config({schedules:[rule({environment:0}),rule({id:'conflict',environment:2})]}),'FISCAL_SCHEDULE_OVERLAP');
});
test('disabled overnight agenda targets only selected PDVs and resumes at the end boundary',()=>{
  const c=config({defaultEnvironment:1,schedules:[rule({environment:0,registerIds:['1'],
    startTime:'22:00',endTime:'02:00',startsOn:'2026-10-09',endsOn:'2026-10-09'})]});
  assert.equal(at(c,'2026-10-09T22:00:00-03:00','1').environment,0);
  assert.equal(at(c,'2026-10-10T01:59:59-03:00','1').environment,0);
  assert.equal(at(c,'2026-10-10T01:59:59-03:00','2').environment,1);
  assert.equal(at(c,'2026-10-10T02:00:00-03:00','1').environment,1);
});
test('whole-day disabled agenda can pause all PDVs within its validity dates',()=>{
  const c=config({schedules:[rule({environment:0,allDay:true,startsOn:'2026-10-09',endsOn:'2026-10-09'})]});
  for(const id of ['1','2']) {
    assert.equal(at(c,'2026-10-09T00:00:00-03:00',id).environment,0);
    assert.equal(at(c,'2026-10-09T23:59:59-03:00',id).environment,0);
    assert.equal(at(c,'2026-10-10T00:00:00-03:00',id).environment,2);
  }
  reject(config({defaultEnvironment:-1}),'INVALID_FISCAL_POLICY');
  reject(config({schedules:[rule({environment:'0'})]}),'INVALID_FISCAL_ENVIRONMENT');
});
