import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import {enqueueFiscal,fiscalForSale} from '../src/fiscal-store.js';
import {DEFAULT_FISCAL_POLICY} from '../src/fiscal-environments.js';
import {installFiscalRoutes} from '../src/fiscal-routes.js';
import {issuer,profile,now} from './fiscal-fixtures.js';
import {canonicalJson,digest} from '../src/fiscal-core.js';

async function database() {
  const db=new PGlite();
  for (const path of ['001_initial','002_promotions','003_units','004_sales_saurus','005_media_pos','006_sync_dispatch','010_fiscal_homologation','011_fiscal_environments','012_fiscal_disabled'])
    await db.exec(readFileSync(new URL(`../sql/${path}.sql`,import.meta.url),'utf8'));
  await db.exec(`INSERT INTO units(name,acronym) VALUES('LOJA TESTE','T1'),('OUTRA LOJA','T2');
    INSERT INTO products(description,ncm) VALUES('TESTE','19021900');
    INSERT INTO registers(unit_id,name,token_hash) VALUES(1,'CAIXA 1','TEST-1'),(2,'CAIXA 2','TEST-2');`);
  await db.query(`INSERT INTO fiscal_issuers(unit_id,cnpj,series,next_number,config,enabled,reviewed_by)
    VALUES(1,$1,1,1,$2,true,'ADMIN TEST')`,[issuer.cnpj,JSON.stringify(issuer)]);
  await db.query(`INSERT INTO fiscal_product_profiles(issuer_id,product_id,profile,reviewed_by)
    VALUES(1,1,$1,'ADMIN TEST')`,[JSON.stringify(profile)]);
  return db;
}
async function addSale(db,id=1) {
  await db.query(`INSERT INTO sales(id,unit_id,register_id,client_sale_id,occurred_at,status,total_cents,payload_hash,raw_payload)
    OVERRIDING SYSTEM VALUE VALUES($1,1,1,$2,$3,'APPROVED',698,'fixture','{}')`,
    [id,'test-sale-'+id,'2026-10-09T14:59:00-03:00']);
  await db.query(`INSERT INTO sale_items(sale_id,line_number,product_id,description,quantity,unit_price_cents,total_cents,discount_cents)
    VALUES($1,1,1,'TESTE',2,499,698,300)`,[id]);
  await db.query(`INSERT INTO sale_payments(sale_id,line_number,method,amount_cents,simulated)
    VALUES($1,1,'PIX',698,true)`,[id]);
}
async function prepare(db,id,options) {
  await db.query('BEGIN');
  try {const result=await enqueueFiscal(db,id,options);await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK');throw error;}
}
const disableAutomatic=db=>db.query('UPDATE fiscal_environment_policy SET config=$1',
  [JSON.stringify({...DEFAULT_FISCAL_POLICY,defaultEnvironment:0})]);
test('Postgres migrations are idempotent and reject production or duplicate fiscal numbering',async()=>{
  const db=await database();
  try {
    await db.exec(readFileSync(new URL('../sql/010_fiscal_homologation.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../sql/011_fiscal_environments.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../sql/012_fiscal_disabled.sql',import.meta.url),'utf8'));
    await assert.rejects(()=>db.query(`INSERT INTO fiscal_issuers(unit_id,cnpj,environment,series,next_number,config,reviewed_by)
      VALUES(2,$1,1,1,1,'{}','TEST')`,[issuer.cnpj]),error=>error.code==='23514');
    await assert.rejects(()=>db.query(`INSERT INTO fiscal_issuers(unit_id,cnpj,series,next_number,config,reviewed_by)
      VALUES(2,$1,1,1,'{}','TEST')`,[issuer.cnpj]),error=>error.code==='23505');
  } finally {await db.close();}
});
test('same sale replays one document; another sale receives the next number',async()=>{
  const db=await database();
  try {
    await addSale(db);await addSale(db,2);
    await db.query('BEGIN');const first=await enqueueFiscal(db,1,{now});await db.query('COMMIT');
    await db.query('BEGIN');const repeat=await enqueueFiscal(db,1,{now});await db.query('COMMIT');
    assert.equal(first.status,'PENDING',first.issue);assert.equal(first.id,repeat.id);assert.equal(first.accessKey,repeat.accessKey);
    await db.query('BEGIN');const second=await enqueueFiscal(db,2,{now});await db.query('COMMIT');
    assert.equal(first.number,1);assert.equal(second.number,2);
    const row=(await db.query('SELECT snapshot,snapshot_hash FROM fiscal_documents WHERE id=$1',[first.id])).rows[0];
    assert.equal(digest(canonicalJson(row.snapshot)),row.snapshot_hash);
    await db.query('UPDATE fiscal_product_profiles SET profile=$1',[JSON.stringify({...profile,ncm:'19023000'})]);
    assert.equal((await db.query('SELECT snapshot FROM fiscal_documents WHERE id=$1',[first.id])).rows[0].snapshot.items[0].profile.ncm,profile.ncm);
  } finally {await db.close();}
});
test('rollback removes the document and rolls back the number reservation',async()=>{
  const db=await database();
  try {
    await addSale(db);await db.query('BEGIN');await enqueueFiscal(db,1,{now});await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_documents')).rows[0].count,0);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_sale_environments')).rows[0].count,0);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
  } finally {await db.close();}
});

test('official selection never falls back to homologation, consumes no number and survives configuration changes',async()=>{
  const db=await database();
  try {
    await addSale(db);
    await db.query('UPDATE fiscal_environment_policy SET config=$1',
      [JSON.stringify({...DEFAULT_FISCAL_POLICY,registerEnvironments:{'1':1}})]);
    await db.query('BEGIN');const official=await enqueueFiscal(db,1,{now});await db.query('COMMIT');
    assert.equal(official.status,'BLOCKED');assert.equal(official.issue,'PRODUCTION_NOT_READY');
    assert.equal(official.requestedEnvironment,1);assert.equal(official.environment,null);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_documents')).rows[0].count,0);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
    await db.query('UPDATE fiscal_environment_policy SET config=$1,revision=2',[JSON.stringify(DEFAULT_FISCAL_POLICY)]);
    await db.query('BEGIN');const repeat=await enqueueFiscal(db,1,{now:now+60000,retryBlocked:true});await db.query('COMMIT');
    assert.deepEqual(repeat,official);assert.equal((await fiscalForSale(db,1)).requestedEnvironment,1);
  } finally {await db.close();}
});
test('schedule decision is frozen per sale; a new sale observes the end boundary and stale Android environment is blocked',async()=>{
  const db=await database();
  try {
    await addSale(db);await addSale(db,2);await addSale(db,3);
    const config={...DEFAULT_FISCAL_POLICY,defaultEnvironment:1,schedules:[{id:'test-window',name:'Teste',
      enabled:true,environment:2,weekdays:[5],startTime:'14:00',endTime:'15:01',startsOn:null,endsOn:null,registerIds:['1']}]};
    await db.query('UPDATE fiscal_environment_policy SET config=$1',[JSON.stringify(config)]);
    await db.query('BEGIN');const first=await enqueueFiscal(db,1,{now});await db.query('COMMIT');
    await db.query('BEGIN');const repeat=await enqueueFiscal(db,1,{now:now+60000});await db.query('COMMIT');
    assert.equal(first.status,'PENDING');assert.equal(repeat.accessKey,first.accessKey);
    assert.equal(repeat.routing.scheduleId,'test-window');assert.equal(repeat.requestedEnvironment,2);
    await db.query('BEGIN');const second=await enqueueFiscal(db,2,{now:now+60000});await db.query('COMMIT');
    assert.equal(second.requestedEnvironment,1);assert.equal(second.issue,'PRODUCTION_NOT_READY');
    await db.query('UPDATE fiscal_environment_policy SET config=$1,revision=2',[JSON.stringify(DEFAULT_FISCAL_POLICY)]);
    await db.query('UPDATE sales SET raw_payload=$1 WHERE id=3',[JSON.stringify({fiscalEnvironment:1})]);
    await db.query('BEGIN');const stale=await enqueueFiscal(db,3,{now});await db.query('COMMIT');
    assert.equal(stale.issue,'FISCAL_ENVIRONMENT_CHANGED');assert.equal(stale.status,'BLOCKED');
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,2);
    await db.exec('DELETE FROM fiscal_sale_environments WHERE sale_id=1');
    await db.exec(readFileSync(new URL('../sql/011_fiscal_environments.sql',import.meta.url),'utf8'));
    assert.equal((await fiscalForSale(db,1)).routing.source,'EXISTING_DOCUMENT');
    assert.equal((await fiscalForSale(db,1)).requestedEnvironment,2);
  } finally {await db.close();}
});

test('environment APIs enforce admin permissions, optimistic revision, audit and per-PDV resolution',async()=>{
  const db=await database();let server;
  try {
    const app=express();app.use(express.json());
    const authGoogle=(req,_res,next)=>{req.user={email:'TEST',role:req.get('authorization')==='Bearer ADMIN'?'ADMINISTRADOR':'COLABORADOR'};next();};
    const admin=(req,res,next)=>req.user.role==='ADMINISTRADOR'?next():res.status(403).json({error:'ADMIN_REQUIRED'});
    const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release:()=>{}})};
    const audits=[];
    installFiscalRoutes(app,pool,{requireGoogle:authGoogle,admin,
      requireRegister:(req,_res,next)=>{req.register={id:req.get('authorization')==='Bearer OTHER'?2:1};next();},
      audit:async(...args)=>audits.push(args.slice(1))});
    app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const put=(body,admin=true)=>fetch(base+'/api/admin/fiscal/environments',{method:'PUT',
      headers:{Authorization:admin?'Bearer ADMIN':'Bearer READER','Content-Type':'application/json'},body:JSON.stringify(body)});
    const config={...DEFAULT_FISCAL_POLICY,registerEnvironments:{'1':1,'2':2}};
    assert.equal((await put({revision:'1',config},false)).status,403);
    assert.equal((await put({revision:'1',config})).status,200);
    assert.equal(String((await db.query('SELECT revision FROM unit_sync_state WHERE unit_id=1')).rows[0].revision),'2');
    assert.equal(audits.length,1);assert.equal(audits[0][1],'FISCAL_ENVIRONMENTS_CHANGED');
    assert.equal((await put({revision:'1',config})).status,409);
    assert.equal(String((await db.query('SELECT revision FROM unit_sync_state WHERE unit_id=1')).rows[0].revision),'2');
    assert.equal((await put({revision:'2',config:{...config,registerEnvironments:{'99':1}}})).status,422);
    const list=await (await fetch(base+'/api/admin/fiscal/environments?at=2026-10-09T15%3A00%3A00-03%3A00')).json();
    assert.equal(list.revision,'2');assert.equal(list.registers[0].effective.environment,1);
    assert.equal(list.registers[0].token_hash,undefined);assert.equal(list.timeZone,'America/Sao_Paulo');
    assert.equal((await fetch(base+'/api/admin/fiscal/environments?at=invalid')).status,422);
    const mine=await (await fetch(base+'/api/v1/fiscal/environment')).json();
    const other=await (await fetch(base+'/api/v1/fiscal/environment',{headers:{Authorization:'Bearer OTHER'}})).json();
    assert.equal(mine.environment,1);assert.equal(mine.productionEnabled,false);assert.equal(other.environment,2);
  } finally {if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
test('missing classification creates a blocked document without consuming a number',async()=>{
  const db=await database();
  try {
    await addSale(db);await db.exec('DELETE FROM fiscal_product_profiles');
    await db.query('BEGIN');const blocked=await enqueueFiscal(db,1,{now});await db.query('COMMIT');
    assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.number,null);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
    await db.query(`INSERT INTO fiscal_product_profiles(issuer_id,product_id,profile,reviewed_by) VALUES(1,1,$1,'TEST')`,[JSON.stringify(profile)]);
    await db.query('BEGIN');const ready=await enqueueFiscal(db,1,{now,retryBlocked:true});await db.query('COMMIT');
    assert.equal(ready.id,blocked.id);assert.equal(ready.status,'PENDING',ready.issue);assert.equal(ready.number,1);
  } finally {await db.close();}
});
test('PDV can only consult its own sale, and unauthorized users cannot configure emitters',async()=>{
  const db=await database();let server;
  try {
    await addSale(db);await db.query('BEGIN');await enqueueFiscal(db,1,{now});await db.query('COMMIT');
    const app=express();app.use(express.json());
    const authRegister=(req,_res,next)=>{req.register={id:req.get('authorization')==='Bearer OTHER'?2:1};next();};
    const authGoogle=(req,_res,next)=>{req.user={email:'TEST',role:req.get('authorization')==='Bearer ADMIN'?'ADMINISTRADOR':'COLABORADOR'};next();};
    const admin=(req,res,next)=>req.user.role==='ADMINISTRADOR'?next():res.status(403).json({error:'ADMIN_REQUIRED'});
    installFiscalRoutes(app,{query:(...args)=>db.query(...args)},
      {requireGoogle:authGoogle,admin,requireRegister:authRegister,audit:async()=>{}});
    app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(base+'/api/v1/sales/test-sale-1/fiscal');
    assert.equal(response.status,200);assert.equal((await response.json()).status,'PENDING');
    assert.equal((await fetch(base+'/api/v1/sales/test-sale-1/fiscal',{headers:{Authorization:'Bearer OTHER'}})).status,404);
    assert.equal((await fetch(base+'/api/admin/fiscal/issuers',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    const docs=await (await fetch(base+'/api/admin/fiscal/documents')).json();
    assert.equal(docs.length,1);assert.equal(docs[0].hasFiscalValue,false);
    assert.equal(docs[0].snapshot,undefined);assert.equal(docs[0].ini_payload,undefined);
    for (const type of ['xml','pdf'])
      assert.equal((await fetch(base+`/api/v1/sales/test-sale-1/fiscal/${type}`)).status,404);
    await db.query(`UPDATE fiscal_documents SET status='AUTHORIZED',authorized_xml=$1,danfe_pdf=$2`,
      ['<test-only-homologation/>',Buffer.from('%PDF-1.7 TEST-ONLY')]);
    for (const [type,expected] of [['xml','<test-only-homologation/>'],['pdf','%PDF-1.7 TEST-ONLY']]) {
      const file=await fetch(base+`/api/v1/sales/test-sale-1/fiscal/${type}`);
      assert.equal(file.status,200);assert.equal(await file.text(),expected);
      assert.equal((await fetch(base+`/api/v1/sales/test-sale-1/fiscal/${type}`,
        {headers:{Authorization:'Bearer OTHER'}})).status,404);
    }
  } finally {if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});

test('disabled sales reserve no number; agenda/configuration changes and all replays keep them disabled',async()=>{
  const db=await database();
  try {
    await addSale(db);await addSale(db,2);await disableAutomatic(db);
    const first=await prepare(db,1,{now});
    assert.equal(first.status,'DISABLED');assert.equal(first.issue,'AUTOMATIC_FISCAL_DISABLED');
    assert.equal(first.requestedEnvironment,0);assert.equal(first.environment,null);
    assert.equal(first.automaticIssuanceEnabled,false);assert.equal(first.canGenerate,true);
    await db.query('UPDATE fiscal_environment_policy SET config=$1,revision=2',[JSON.stringify(DEFAULT_FISCAL_POLICY)]);
    assert.deepEqual(await prepare(db,1,{now:now+86400000,retryBlocked:true}),first);
    assert.deepEqual(await fiscalForSale(db,1),first);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_documents')).rows[0].count,0);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_manual_requests')).rows[0].count,0);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
    assert.equal((await prepare(db,2,{now})).status,'PENDING');
  } finally {await db.close();}
});
test('explicit manual generation creates one current-date coupon and preserves the disabled routing',async()=>{
  const db=await database();
  try {
    await addSale(db);await disableAutomatic(db);await prepare(db,1,{now});
    const options={now:now+86400000,manualEnvironment:2,actor:'ADMIN TEST',retryBlocked:true};
    const first=await prepare(db,1,options);
    assert.equal(first.status,'PENDING',first.issue);assert.equal(first.canGenerate,false);
    assert.equal(first.requestedEnvironment,2);assert.equal(first.automaticEnvironment,0);assert.equal(first.environment,2);
    assert.equal(first.automaticIssuanceEnabled,false);assert.equal(first.routing.environment,0);
    const repeat=await prepare(db,1,options);assert.equal(first.id,repeat.id);assert.equal(first.accessKey,repeat.accessKey);
    assert.deepEqual(await prepare(db,1,{now:now+86400000}),repeat);
    const row=(await db.query('SELECT snapshot,snapshot_hash,ini_payload FROM fiscal_documents')).rows[0];
    assert.equal(row.snapshot.routing.environment,2);assert.equal(row.snapshot.routing.source,'MANUAL');
    assert.equal(row.snapshot.automaticRouting.environment,0);
    assert.equal(row.snapshot.sale.occurredAt,'2026-10-09T17:59:00.000Z');
    assert.equal(row.snapshot.sale.issuedAt,'2026-10-10T18:00:00.000Z');
    assert.match(row.ini_payload,/dhEmi=10\/10\/2026 15:00:00/);assert.match(row.ini_payload,/tpAmb=2/);
    assert.equal(digest(canonicalJson(row.snapshot)),row.snapshot_hash);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,2);
    assert.equal((await db.query('SELECT requested_by FROM fiscal_manual_requests')).rows[0].requested_by,'ADMIN TEST');
    await db.exec(readFileSync(new URL('../sql/011_fiscal_environments.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../sql/012_fiscal_disabled.sql',import.meta.url),'utf8'));
    assert.equal((await fiscalForSale(db,1)).routing.environment,0);
    await assert.rejects(()=>db.query('UPDATE fiscal_documents SET environment=0'),error=>error.code==='23514');
    await assert.rejects(()=>db.query('UPDATE fiscal_manual_requests SET environment=0'),error=>error.code==='23514');
  } finally {await db.close();}
});
test('manual production, invalid environments and attempts to override automatic modes never allocate a number',async()=>{
  const db=await database();
  try {
    await addSale(db);await disableAutomatic(db);await prepare(db,1,{now});
    await assert.rejects(()=>prepare(db,1,{now,manualEnvironment:1,actor:'ADMIN'}),/PRODUCTION_NOT_READY/);
    for(const manualEnvironment of [0,3,'2',true])
      await assert.rejects(()=>prepare(db,1,{now,manualEnvironment,actor:'ADMIN'}),/INVALID_MANUAL_FISCAL_ENVIRONMENT/);
    await assert.rejects(()=>prepare(db,1,{now,manualEnvironment:2}),/FISCAL_MANUAL_ACTOR_REQUIRED/);
    await addSale(db,2);await addSale(db,3);
    await db.query('UPDATE fiscal_environment_policy SET config=$1',[JSON.stringify({...DEFAULT_FISCAL_POLICY,defaultEnvironment:1})]);
    await assert.rejects(()=>prepare(db,2,{now,manualEnvironment:2,actor:'ADMIN'}),/MANUAL_FISCAL_ONLY_WHEN_DISABLED/);
    await db.query('UPDATE fiscal_environment_policy SET config=$1',[JSON.stringify(DEFAULT_FISCAL_POLICY)]);
    await assert.rejects(()=>prepare(db,3,{now,manualEnvironment:2,actor:'ADMIN'}),/MANUAL_FISCAL_ONLY_WHEN_DISABLED/);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_documents')).rows[0].count,0);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_manual_requests')).rows[0].count,0);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
  } finally {await db.close();}
});
test('manual pending configuration/classification requires another manual action after it is fixed',async()=>{
  const db=await database();
  try {
    await addSale(db);await disableAutomatic(db);await prepare(db,1,{now});
    const options={now,manualEnvironment:2,actor:'ADMIN',retryBlocked:true};
    await db.exec('UPDATE fiscal_issuers SET enabled=false');
    const disabled=await prepare(db,1,options);
    assert.equal(disabled.status,'BLOCKED');assert.equal(disabled.issue,'FISCAL_ISSUER_NOT_ENABLED');
    assert.equal(disabled.canGenerate,true);assert.equal(disabled.manualRequest.environment,2);
    await db.exec('UPDATE fiscal_issuers SET enabled=true; DELETE FROM fiscal_product_profiles');
    assert.equal((await prepare(db,1,{now,retryBlocked:true})).id,undefined);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_documents')).rows[0].count,0);
    const blocked=await prepare(db,1,options);
    assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.number,null);assert.equal(blocked.canGenerate,true);
    await db.query(`INSERT INTO fiscal_product_profiles(issuer_id,product_id,profile,reviewed_by)
      VALUES(1,1,$1,'ADMIN TEST')`,[JSON.stringify(profile)]);
    assert.equal((await prepare(db,1,{now,retryBlocked:true})).status,'BLOCKED');
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
    const ready=await prepare(db,1,options);
    assert.equal(ready.id,blocked.id);assert.equal(ready.status,'PENDING');assert.equal(ready.number,1);
  } finally {await db.close();}
});
test('manual transaction rollback removes the request and document, leaving the sale disabled',async()=>{
  const db=await database();
  try {
    await addSale(db);await disableAutomatic(db);const disabled=await prepare(db,1,{now});
    await db.query('BEGIN');await enqueueFiscal(db,1,{now,manualEnvironment:2,actor:'ADMIN'});await db.query('ROLLBACK');
    assert.deepEqual(await fiscalForSale(db,1),disabled);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_manual_requests')).rows[0].count,0);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_documents')).rows[0].count,0);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
    await db.exec("UPDATE sales SET status='CANCELLED' WHERE id=1");
    assert.equal((await prepare(db,1,{now,manualEnvironment:2,actor:'ADMIN'})).status,'NOT_APPLICABLE');
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_manual_requests')).rows[0].count,0);
  } finally {await db.close();}
});
test('portal reads are passive; manual endpoints require an admin and audit one idempotent sale request',async({mock})=>{
  const db=await database();let server;
  try {
    await addSale(db);await disableAutomatic(db);await prepare(db,1,{now});
    mock.method(Date,'now',()=>now+86400000);
    const app=express();app.use(express.json());
    const authGoogle=(req,_res,next)=>{req.user={email:'ADMIN TEST',role:req.get('authorization')==='Bearer ADMIN'?'ADMINISTRADOR':'COLABORADOR'};next();};
    const admin=(req,res,next)=>req.user.role==='ADMINISTRADOR'?next():res.status(403).json({error:'ADMIN_REQUIRED'});
    const audits=[],pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release:()=>{}})};
    installFiscalRoutes(app,pool,{requireGoogle:authGoogle,admin,
      requireRegister:(req,_res,next)=>{req.register={id:1};next();},audit:async(...args)=>audits.push(args.slice(1))});
    app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const request=(body,authorized=true)=>fetch(base+'/api/admin/fiscal/sales/1/prepare',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:authorized?'Bearer ADMIN':'Bearer READER'},body:JSON.stringify(body)});
    const disabled=await (await fetch(base+'/api/admin/fiscal/sales/1')).json();
    assert.equal(disabled.status,'DISABLED');assert.equal(disabled.canGenerate,true);
    const preview=await (await fetch(base+'/api/admin/fiscal/environments')).json();
    assert.equal(preview.config.defaultEnvironment,0);assert.equal(preview.registers[0].effective.environment,0);
    const mode=await (await fetch(base+'/api/v1/fiscal/environment')).json();
    assert.equal(mode.environment,0);assert.equal(mode.automaticIssuanceEnabled,false);assert.equal(mode.readiness,'DISABLED');
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_manual_requests')).rows[0].count,0);
    assert.equal((await request({environment:2},false)).status,403);
    assert.equal((await request({environment:0})).status,422);
    assert.equal((await request({environment:1})).status,409);
    assert.equal((await request({environment:2,actor:'IMPOSTOR'})).status,422);
    assert.equal((await request({})).status,200);
    assert.equal((await db.query('SELECT count(*) AS count FROM fiscal_documents')).rows[0].count,0);
    const response=await request({environment:2});assert.equal(response.status,200);const first=await response.json();
    assert.equal(first.status,'PENDING',first.issue);
    const repeat=await (await request({environment:2})).json();assert.equal(repeat.id,first.id);
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,2);
    const record=audits.find(a=>a[1]==='FISCAL_MANUAL_REQUESTED');
    assert.equal(record[0],'ADMIN TEST');assert.equal(record[4].automaticEnvironment,0);assert.equal(record[4].environment,2);
    const docs=await (await fetch(base+'/api/admin/fiscal/documents')).json();
    assert.equal(docs[0].automaticEnvironment,0);assert.equal(docs[0].manualRequest.environment,2);
    assert.equal((await (await fetch(base+'/api/admin/fiscal/sales/1')).json()).id,first.id);
    assert.equal((await fetch(base+'/api/admin/fiscal/sales/999')).status,404);
  } finally {if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
