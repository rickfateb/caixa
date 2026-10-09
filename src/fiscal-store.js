import {buildNfceIni, canonicalJson, digest, fiscalError, saleSnapshot} from './fiscal-core.js';

export function publicFiscal(row) {
  if (!row) return {status:'DISABLED',environment:2,model:65,hasFiscalValue:false};
  return {id:String(row.id),status:row.status,environment:2,model:65,hasFiscalValue:false,
    series:row.series,number:row.number,accessKey:row.access_key,protocol:row.protocol,
    sefazCode:row.sefaz_code,message:row.sefaz_message,issue:row.last_error,
    qrCode:row.status==='AUTHORIZED'?row.qr_code:null,danfeAvailable:row.danfe_available ?? (row.danfe_pdf!=null),
    updatedAt:row.updated_at};
}

// Caller owns the sale transaction. A pending document and its immutable snapshot
// must commit with the sale; the network call happens in a separate worker.
export async function enqueueFiscal(client, saleId, {retryBlocked=false, now=Date.now()} = {}) {
  const sale=(await client.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE',[saleId])).rows[0];
  if (!sale) throw fiscalError('SALE_NOT_FOUND',404);
  if (sale.source!=='POS' || sale.status!=='APPROVED') return {...publicFiscal(null),status:'NOT_APPLICABLE'};
  const existing=(await client.query('SELECT * FROM fiscal_documents WHERE sale_id=$1 AND environment=2',[saleId])).rows[0];
  if (existing && (!retryBlocked || existing.status!=='BLOCKED' || existing.number!=null)) return publicFiscal(existing);
  const issuer=(await client.query('SELECT * FROM fiscal_issuers WHERE unit_id=$1 FOR UPDATE',[sale.unit_id])).rows[0];
  if (!issuer?.enabled) return publicFiscal(existing);
  let snapshot;
  try {
    const items=(await client.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY line_number',[saleId])).rows;
    const payments=(await client.query('SELECT * FROM sale_payments WHERE sale_id=$1 ORDER BY line_number',[saleId])).rows;
    const profiles=(await client.query('SELECT product_id,profile FROM fiscal_product_profiles WHERE issuer_id=$1',
      [issuer.id])).rows;
    snapshot=saleSnapshot(sale,{...issuer.config,enabled:issuer.enabled},items,payments,
      new Map(profiles.map(p=>[String(p.product_id),p.profile])),now);
  } catch(error) {
    if (!error.status) throw error;
    const row=(await client.query(`INSERT INTO fiscal_documents(sale_id,issuer_id,series,status,last_error)
      VALUES($1,$2,$3,'BLOCKED',$4) ON CONFLICT(sale_id,environment)
      DO UPDATE SET status='BLOCKED',last_error=excluded.last_error,updated_at=now() RETURNING *`,
      [saleId,issuer.id,issuer.series,error.message])).rows[0];
    return publicFiscal(row);
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
  return publicFiscal(row);
}
