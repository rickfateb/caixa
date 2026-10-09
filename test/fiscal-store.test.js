import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import {enqueueFiscal} from '../src/fiscal-store.js';
import {installFiscalRoutes} from '../src/fiscal-routes.js';
import {issuer,profile,now} from './fiscal-fixtures.js';
import {canonicalJson,digest} from '../src/fiscal-core.js';

async function database() {
  const db=new PGlite();
  for (const path of ['001_initial','002_promotions','003_units','004_sales_saurus','005_media_pos','010_fiscal_homologation'])
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
test('Postgres migrations are idempotent and reject production or duplicate fiscal numbering',async()=>{
  const db=await database();
  try {
    await db.exec(readFileSync(new URL('../sql/010_fiscal_homologation.sql',import.meta.url),'utf8'));
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
    assert.equal((await db.query('SELECT next_number FROM fiscal_issuers')).rows[0].next_number,1);
  } finally {await db.close();}
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
