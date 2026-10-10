import {buildNfceIni, canonicalJson, digest, fiscalError, saleSnapshot} from './fiscal-core.js';
import {pinFiscalEnvironment} from './fiscal-environments.js';

export function publicFiscal(row,route=null,manual=null) {
  const manualRequest=manual?{environment:manual.environment,requestedAt:new Date(manual.requested_at).toISOString()}:null;
  const common={environment:row?2:route?.environment===0 || route?.environment===1?null:2,
    requestedEnvironment:manual?.environment ?? route?.environment ?? 2,
    automaticEnvironment:route?.environment ?? 2,automaticIssuanceEnabled:route?.environment!==0,
    manualRequest,canGenerate:route?.environment===0 && !route.issue &&
      (!row || (row.status==='BLOCKED' && row.number==null)),
    model:65,hasFiscalValue:false,routing:route};
  if(route?.issue)return {...common,status:'BLOCKED',issue:route.issue};
  if(route?.environment===1 || manual?.environment===1)
    return {...common,status:'BLOCKED',issue:'PRODUCTION_NOT_READY',canGenerate:false};
  if (!row) return {...common,status:manual?'BLOCKED':'DISABLED',
    issue:route?.environment===0 && !manual?'AUTOMATIC_FISCAL_DISABLED':'FISCAL_ISSUER_NOT_ENABLED'};
  return {...common,id:String(row.id),status:row.status,
    series:row.series,number:row.number,accessKey:row.access_key,protocol:row.protocol,
    sefazCode:row.sefaz_code,message:row.sefaz_message,issue:row.last_error,
    qrCode:row.status==='AUTHORIZED'?row.qr_code:null,danfeAvailable:row.danfe_available ?? (row.danfe_pdf!=null),
    updatedAt:row.updated_at};
}

export async function fiscalForSale(client,saleId) {
  const selection=(await client.query(`SELECT e.decision,m.environment AS manual_environment,
    m.requested_at AS manual_requested_at FROM fiscal_sale_environments e
    LEFT JOIN fiscal_manual_requests m ON m.sale_id=e.sale_id WHERE e.sale_id=$1`,[saleId])).rows[0];
  const doc=(await client.query(`SELECT id,status,series,number,access_key,protocol,sefaz_code,sefaz_message,
    qr_code,last_error,updated_at,(danfe_pdf IS NOT NULL) AS danfe_available
    FROM fiscal_documents WHERE sale_id=$1 AND environment=2`,[saleId])).rows[0];
  const manual=selection?.manual_environment==null?null:
    {environment:selection.manual_environment,requested_at:selection.manual_requested_at};
  return publicFiscal(doc,selection?.decision,manual);
}

// Caller owns the sale transaction. A pending document and its immutable snapshot
// must commit with the sale; the network call happens in a separate worker.
export async function enqueueFiscal(client, saleId,
  {retryBlocked=false, now=Date.now(),manualEnvironment,actor} = {}) {
  if(manualEnvironment!==undefined && ![1,2].includes(manualEnvironment))
    throw fiscalError('INVALID_MANUAL_FISCAL_ENVIRONMENT');
  const sale=(await client.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE',[saleId])).rows[0];
  if (!sale) throw fiscalError('SALE_NOT_FOUND',404);
  if (sale.source!=='POS' || sale.status!=='APPROVED') return {...publicFiscal(null),status:'NOT_APPLICABLE'};
  const route=await pinFiscalEnvironment(client,sale,now);
  if(manualEnvironment!==undefined && route.environment!==0)
    throw fiscalError('MANUAL_FISCAL_ONLY_WHEN_DISABLED',409);
  if(route.environment===1 || route.issue)return publicFiscal(null,route);
  const existing=(await client.query('SELECT * FROM fiscal_documents WHERE sale_id=$1 AND environment=2',[saleId])).rows[0];
  let manual=null;
  if(route.environment===0) {
    manual=(await client.query('SELECT environment,requested_at FROM fiscal_manual_requests WHERE sale_id=$1',[saleId])).rows[0];
    // PDV replays and ordinary preparation never turn a disabled sale into a document.
    if(manualEnvironment===undefined)return publicFiscal(existing,route,manual);
    if(typeof actor!=='string' || !actor.trim())throw fiscalError('FISCAL_MANUAL_ACTOR_REQUIRED');
    if(manualEnvironment===1)throw fiscalError('PRODUCTION_NOT_READY',409);
    if(manual && manual.environment!==manualEnvironment)throw fiscalError('FISCAL_MANUAL_ENVIRONMENT_CHANGED',409);
    if(!manual)manual=(await client.query(`INSERT INTO fiscal_manual_requests(sale_id,environment,requested_by,requested_at)
      VALUES($1,$2,$3,$4) RETURNING environment,requested_at`,[saleId,manualEnvironment,actor,new Date(now).toISOString()])).rows[0];
  }
  if (existing && (!retryBlocked || existing.status!=='BLOCKED' || existing.number!=null))
    return publicFiscal(existing,route,manual);
  const issuer=(await client.query('SELECT * FROM fiscal_issuers WHERE unit_id=$1 FOR UPDATE',[sale.unit_id])).rows[0];
  if (!issuer?.enabled) return publicFiscal(existing,route,manual);
  let snapshot;
  try {
    const items=(await client.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY line_number',[saleId])).rows;
    const payments=(await client.query('SELECT * FROM sale_payments WHERE sale_id=$1 ORDER BY line_number',[saleId])).rows;
    const profiles=(await client.query('SELECT product_id,profile FROM fiscal_product_profiles WHERE issuer_id=$1',
      [issuer.id])).rows;
    const routing=manual?{...route,environment:manual.environment,source:'MANUAL',
      selectedAt:new Date(manual.requested_at).toISOString()}:route;
    snapshot={...saleSnapshot(sale,{...issuer.config,enabled:issuer.enabled},items,payments,
      new Map(profiles.map(p=>[String(p.product_id),p.profile])),now,{manual:manual!=null}),routing,
      ...(manual?{automaticRouting:route}:{})};
  } catch(error) {
    if (!error.status) throw error;
    const row=(await client.query(`INSERT INTO fiscal_documents(sale_id,issuer_id,series,status,last_error)
      VALUES($1,$2,$3,'BLOCKED',$4) ON CONFLICT(sale_id,environment)
      DO UPDATE SET status='BLOCKED',last_error=excluded.last_error,updated_at=now() RETURNING *`,
      [saleId,issuer.id,issuer.series,error.message])).rows[0];
    return publicFiscal(row,route,manual);
  }
  if (issuer.next_number > 999999999) throw fiscalError('FISCAL_NUMBER_EXHAUSTED');
  const number=issuer.next_number;
  const document=buildNfceIni(snapshot,number);
  const serialized=canonicalJson(snapshot);
  await client.query('UPDATE fiscal_issuers SET next_number=next_number+1 WHERE id=$1',[issuer.id]);
  const row=(await client.query(`INSERT INTO fiscal_documents
    (sale_id,issuer_id,series,number,access_key,status,snapshot,snapshot_hash,ini_payload)
    VALUES($1,$2,$3,$4,$5,'PENDING',$6,$7,$8) ON CONFLICT(sale_id,environment)
    DO UPDATE SET number=excluded.number,access_key=excluded.access_key,status='PENDING',snapshot=excluded.snapshot,
      snapshot_hash=excluded.snapshot_hash,ini_payload=excluded.ini_payload,last_error=NULL,retry_at=now(),updated_at=now()
    RETURNING *`,[saleId,issuer.id,issuer.series,number,document.accessKey,serialized,digest(serialized),document.ini])).rows[0];
  return publicFiscal(row,route,manual);
}
