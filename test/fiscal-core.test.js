import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIssuer,validateProfile,saleSnapshot,grossCents,parseAcbrResponse,canonicalJson,buildNfceIni} from '../src/fiscal-core.js';
import {runtimeConfig} from '../src/fiscal-acbr.js';
import {issuer,profile,sale,items,payments,now,fixture,authorizedResponse} from './fiscal-fixtures.js';

test('production and unsupported regimes are blocked before allocating a number',()=>{
  assert.throws(()=>validateIssuer({...issuer,environment:1}),/HOMOLOGATION_ONLY/);
  assert.throws(()=>validateIssuer({...issuer,crt:3}),/ONLY_SP_SIMPLES_SUPPORTED/);
  assert.throws(()=>runtimeConfig({...issuer,environment:1},{}),/HOMOLOGATION_ONLY/);
  assert.throws(()=>runtimeConfig(issuer,{FISCAL_HOMOLOGATION_WORKER:'1'}),/FISCAL_RUNTIME_NOT_CONFIGURED/);
});
test('classification does not infer NCM, ST or GTIN',()=>{
  assert.throws(()=>validateProfile({...profile,ncm:''}),/NCM_REQUIRED/);
  assert.throws(()=>validateProfile({...profile,csosn:'500',cfop:'5405'}),/CEST_REQUIRED_FOR_ST/);
  assert.throws(()=>validateProfile({...profile,gtin:'7890000000001'}),/GTIN_CLASSIFICATION_REQUIRED/);
  assert.throws(()=>validateProfile({...profile,taxYear:2027}),/RTC_PROFILE_REQUIRED_FOR_2027/);
});
test('late offline uploads, Saurus imports and cancelled sales never become new normal NFC-e',()=>{
  const profiles=new Map([['1',profile]]);
  assert.throws(()=>saleSnapshot({...sale,source:'SAURUS'},issuer,items,payments,profiles,now),/SALE_NOT_ELIGIBLE/);
  assert.throws(()=>saleSnapshot({...sale,status:'CANCELLED'},issuer,items,payments,profiles,now),/SALE_NOT_ELIGIBLE/);
  assert.throws(()=>saleSnapshot({...sale,occurred_at:'2026-10-08T15:00:00-03:00'},issuer,items,payments,profiles,now),/OFFLINE_FISCAL_FLOW_REQUIRED/);
});
test('manual homologation keeps the sale date and uses the actual emission date in XML and key',()=>{
  const issueTime=Date.parse('2026-11-01T12:30:00-03:00');
  const snapshot=saleSnapshot(sale,issuer,items,payments,new Map([['1',profile]]),issueTime,{manual:true});
  assert.equal(snapshot.sale.occurredAt,'2026-10-09T17:59:00.000Z');
  assert.equal(snapshot.sale.issuedAt,'2026-11-01T15:30:00.000Z');
  const built=buildNfceIni(snapshot,1,'12345678');
  assert.match(built.ini,/dhEmi=01\/11\/2026 12:30:00/);assert.match(built.ini,/tpAmb=2/);
  assert.equal(built.accessKey.slice(2,6),'2611');
  assert.throws(()=>saleSnapshot(sale,issuer,items,payments,new Map([['1',profile]]),issueTime),/OFFLINE_FISCAL_FLOW_REQUIRED/);
  assert.throws(()=>saleSnapshot(sale,issuer,items,payments,new Map([['1',profile]]),
    Date.parse('2027-01-01T12:00:00-03:00'),{manual:true}),/RTC_PROFILE_REQUIRED_FOR_2027/);
});
test('manual requests retain production, payment, eligibility and classification restrictions',()=>{
  const options={manual:true};
  assert.throws(()=>saleSnapshot(sale,{...issuer,environment:1},items,payments,new Map([['1',profile]]),now,options),/FISCAL_NOT_ENABLED/);
  assert.throws(()=>saleSnapshot({...sale,status:'CANCELLED'},issuer,items,payments,new Map([['1',profile]]),now,options),/SALE_NOT_ELIGIBLE/);
  assert.throws(()=>saleSnapshot(sale,issuer,items,[{...payments[0],simulated:false}],new Map([['1',profile]]),now,options),/ONLY_SIMULATED_HOMOLOGATION_PAYMENTS/);
  assert.throws(()=>saleSnapshot(sale,issuer,items,payments,new Map(),now,options),/NCM_REQUIRED/);
});
test('fractional quantities round in integer cents and discounts keep totals consistent',()=>{
  assert.equal(grossCents('0.125','499'),62n);
  assert.equal(grossCents('0.500','1'),1n);
  assert.equal(grossCents('2.0000','499'),998n);
  assert.throws(()=>grossCents('0.0001','499'),/INVALID_FISCAL_QUANTITY/);
  assert.throws(()=>saleSnapshot(sale,issuer,[{...items[0],discount_cents:'299'}],payments,new Map([['1',profile]]),now),/FISCAL_ITEM_TOTAL_MISMATCH/);
  const doc=fixture();
  assert.match(doc.ini_payload,/vProd=9\.98/);
  assert.match(doc.ini_payload,/vDesc=3\.00/);
  assert.match(doc.ini_payload,/vNF=6\.98/);
  assert.equal(doc.access_key.length,44);
});
test('simulated payments are explicit, homologation marked and secrets absent from INI',()=>{
  const doc=fixture();
  assert.match(doc.ini_payload,/mod=65/);assert.match(doc.ini_payload,/tpAmb=2/);
  assert.match(doc.ini_payload,/HOMOLOGACAO - SEM VALOR FISCAL/);
  assert.doesNotMatch(doc.ini_payload,/CSC=|Senha=|PFX=/);
  assert.throws(()=>saleSnapshot(sale,issuer,items,[{...payments[0],simulated:false}],new Map([['1',profile]]),now),/ONLY_SIMULATED_HOMOLOGATION_PAYMENTS/);
});
test('INI injection is rejected and jsonb key-order changes do not change the hash',()=>{
  assert.throws(()=>validateIssuer({...issuer,name:'TEST\n[NFe]\nAmbiente=1'}),/ISSUER_NAME_REQUIRED/);
  assert.equal(canonicalJson({b:2,a:{y:1,x:2}}),canonicalJson({a:{x:2,y:1},b:2}));
  const doc=fixture();doc.snapshot.issuer.name='TEST\nINJECTION=1';
  assert.throws(()=>buildNfceIni(doc.snapshot,1,'12345678'),/INVALID_INI_VALUE/);
});
test('batch success alone is insufficient and 17-position protocols remain exact text',()=>{
  const key=fixture().access_key;
  const result=parseAcbrResponse(authorizedResponse(key),key);
  assert.equal(result.authorized,true);assert.equal(result.protocol,'13526000000000001');
  assert.equal(parseAcbrResponse('[ENVIO]\nCStat=104',key).authorized,false);
  assert.equal(parseAcbrResponse(authorizedResponse('0'.repeat(44)),key).authorized,false);
  assert.equal(parseAcbrResponse(authorizedResponse(key).replace('TpAmb=2','TpAmb=1'),key).authorized,false);
});
