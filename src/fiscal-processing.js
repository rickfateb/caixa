import {canonicalJson,digest,fiscalError,parseAcbrResponse} from './fiscal-core.js';

function xmlField(xml,field) {
  return new RegExp(`<(?:[\\w]+:)?${field}[^>]*>([\\s\\S]*?)<\\/(?:[\\w]+:)?${field}>`).exec(xml)?.[1];
}
function qrUrl(xml) {
  const value=xmlField(xml,'qrCode')?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,'$1').replace(/&amp;/g,'&');
  if (!value || value.length>4096) return null;
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;} catch {return null;}
}
const authorizedXml=(xml,key,protocol) => typeof xml==='string' && xml.includes(`Id="NFe${key}"`) &&
  /<(?:\w+:)?Signature\b/.test(xml) && /<(?:\w+:)?protNFe\b/.test(xml) &&
  xmlField(xml,'chNFe')===key && xmlField(xml,'nProt')===protocol && xmlField(xml,'cStat')==='100' &&
  xmlField(xml,'tpAmb')==='2';

export async function processFiscalDocument(client,document,adapter,now=Date.now()) {
  if (document.environment!==2 || document.snapshot?.issuer?.environment!==2) throw fiscalError('HOMOLOGATION_ONLY');
  if(document.snapshot.routing && document.snapshot.routing.environment!==2)throw fiscalError('FISCAL_ENVIRONMENT_CHANGED');
  if (digest(canonicalJson(document.snapshot))!==document.snapshot_hash) throw fiscalError('FISCAL_SNAPSHOT_CHANGED');
  const update=async(sql,values=[])=>client.query(`UPDATE fiscal_documents SET ${sql},updated_at=now() WHERE id=$1`,
    [document.id,...values]);
  const makePdf=async() => {
    try {const pdf=adapter.pdf();await update('danfe_pdf=$2,last_error=NULL',[pdf]);}
    catch {await update("last_error='DANFE_GENERATION_PENDING',retry_at=now()+interval '1 minute'");}
  };
  if (document.status==='AUTHORIZED') {adapter.load(document.authorized_xml);await makePdf();return 'AUTHORIZED';}
  let firstSend=false;
  if (document.status==='PENDING') {
    if (now-Date.parse(document.snapshot.sale.occurredAt)>300000) throw fiscalError('OFFLINE_FISCAL_FLOW_REQUIRED');
    const xml=adapter.sign(document.ini_payload);
    if (!xml?.includes(`Id="NFe${document.access_key}"`) || !/<(?:\w+:)?Signature\b/.test(xml))
      throw fiscalError('SIGNED_XML_KEY_MISMATCH');
    await update("signed_xml=$2,status='SIGNED'",[xml]);document.signed_xml=xml;firstSend=true;
  } else {
    if (!document.signed_xml) throw fiscalError('SIGNED_XML_MISSING');
    adapter.load(document.signed_xml);
  }
  let raw;
  if (firstSend) {
    // Commit SUBMITTING before the call; a crash after this point must consult.
    await update("status='SUBMITTING',attempts=attempts+1");
    try {raw=adapter.send();}
    catch {await update("status='UNKNOWN',last_error='SEFAZ_RESPONSE_UNKNOWN',retry_at=now()+interval '10 seconds'");return 'UNKNOWN';}
  } else {
    await update('attempts=attempts+1');
    try {raw=adapter.consult(document.access_key);}
    catch {await update("status='UNKNOWN',last_error='SEFAZ_CONSULT_FAILED',retry_at=now()+interval '1 minute'");return 'UNKNOWN';}
  }
  const result=parseAcbrResponse(raw,document.access_key);
  if (result.authorized) {
    const xml=adapter.xml();
    if (!authorizedXml(xml,document.access_key,result.protocol)) {
      await update("status='UNKNOWN',last_error='AUTHORIZED_XML_NOT_AVAILABLE',retry_at=now()+interval '1 minute'");
      return 'UNKNOWN';
    }
    const qr=qrUrl(xml);
    if (!qr) throw fiscalError('AUTHORIZED_QR_CODE_MISSING');
    await update("status='AUTHORIZED',authorized_xml=$2,protocol=$3,sefaz_code=$4,sefaz_message=$5,qr_code=$6,last_error=NULL",
      [xml,result.protocol,result.code,result.message,qr]);
    await makePdf();return 'AUTHORIZED';
  }
  // A batch-level 104 or an uncertain query is not document authorization.
  const uncertain=['','103','104','105','108','109'].includes(result.code);
  const status=uncertain?'UNKNOWN':firstSend && !['204','539'].includes(result.code)?'REJECTED':'MANUAL';
  await update('status=$2,sefaz_code=$3,sefaz_message=$4,last_error=$5,retry_at=now()+interval \'1 minute\'',
    [status,result.code,result.message,status==='MANUAL'?'SEFAZ_RECONCILIATION_REQUIRED':null]);
  return status;
}
