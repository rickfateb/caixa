import test from 'node:test';
import assert from 'node:assert/strict';
import {processFiscalDocument} from '../src/fiscal-processing.js';
import {fixture,now,fakeXml,authorizedResponse} from './fiscal-fixtures.js';

function mocks(doc) {
  const calls=[];
  const db={query:async(sql,params)=>{calls.push({method:'sql',sql,params});return {rows:[]};}};
  const adapter={sign:()=>{calls.push({method:'sign'});return fakeXml(doc.access_key);},
    load:()=>calls.push({method:'load'}),send:()=>{calls.push({method:'send'});return authorizedResponse(doc.access_key);},
    consult:()=>{calls.push({method:'consult'});return authorizedResponse(doc.access_key);},
    xml:()=>fakeXml(doc.access_key),pdf:()=>Buffer.from('%PDF-TEST')};
  return {db,adapter,calls};
}
test('XML is persisted and SUBMITTING recorded before any SEFAZ call',async()=>{
  const doc=fixture(),{db,adapter,calls}=mocks(doc);
  assert.equal(await processFiscalDocument(db,doc,adapter,now),'AUTHORIZED');
  const send=calls.findIndex(c=>c.method==='send');
  assert(calls.slice(0,send).some(c=>c.sql?.includes('signed_xml=$2')));
  assert(calls.slice(0,send).some(c=>c.sql?.includes("status='SUBMITTING'")));
  assert(calls.some(c=>c.params?.includes('13526000000000001')));
});
test('timeout becomes UNKNOWN; restart consults the same key without sending again',async()=>{
  const doc=fixture(),m=mocks(doc);
  m.adapter.send=()=>{m.calls.push({method:'send'});throw Error('timeout');};
  assert.equal(await processFiscalDocument(m.db,doc,m.adapter,now),'UNKNOWN');
  doc.status='UNKNOWN';
  assert.equal(await processFiscalDocument(m.db,doc,m.adapter,now),'AUTHORIZED');
  assert.equal(m.calls.filter(c=>c.method==='send').length,1);
  assert.equal(m.calls.filter(c=>c.method==='consult').length,1);
});
test('unknown/not-found response requires reconciliation and never creates a second coupon',async()=>{
  const doc=fixture();doc.status='SUBMITTING';doc.signed_xml=fakeXml(doc.access_key);
  const {db,adapter,calls}=mocks(doc);adapter.consult=()=>`[CONSULTA]\nTpAmb=2\nCStat=217\nchDFe=${doc.access_key}`;
  assert.equal(await processFiscalDocument(db,doc,adapter,now),'MANUAL');
  assert.equal(calls.filter(c=>c.method==='send').length,0);
});
test('authorization without processed XML stays unresolved',async()=>{
  const doc=fixture(),{db,adapter}=mocks(doc);adapter.xml=()=>`<NFe Id="NFe${doc.access_key}"/>`;
  assert.equal(await processFiscalDocument(db,doc,adapter,now),'UNKNOWN');
});
test('PDF failure preserves authorization and a retry only renders, never re-emits',async()=>{
  const doc=fixture(),{db,adapter,calls}=mocks(doc);adapter.pdf=()=>{throw Error('font');};
  assert.equal(await processFiscalDocument(db,doc,adapter,now),'AUTHORIZED');
  assert(calls.some(c=>c.sql?.includes('DANFE_GENERATION_PENDING')));
  doc.status='AUTHORIZED';doc.authorized_xml=fakeXml(doc.access_key);
  adapter.pdf=()=>Buffer.from('%PDF-TEST');
  await processFiscalDocument(db,doc,adapter,now);
  assert.equal(calls.filter(c=>c.method==='send').length,1);
});
test('changed snapshot or production environment cannot reach the native library',async()=>{
  const doc=fixture(),{db,adapter,calls}=mocks(doc);doc.snapshot.sale.totalCents='1';
  await assert.rejects(()=>processFiscalDocument(db,doc,adapter,now),/FISCAL_SNAPSHOT_CHANGED/);
  doc.environment=1;
  await assert.rejects(()=>processFiscalDocument(db,doc,adapter,now),/HOMOLOGATION_ONLY/);
  assert.equal(calls.length,0);
});
