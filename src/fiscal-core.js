// NFC-e/SP, Simples Nacional: preparation for homologation in 2026.
// Tax classification is supplied by the accountant, never inferred from a name/EAN.
import { createHash, randomInt } from 'node:crypto';

export const fiscalError = (code, status = 422) => Object.assign(new Error(code), { status });
const requireValue = (condition, code) => { if (!condition) throw fiscalError(code); };
const clean = (value, max, code) => {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max &&
    !/[\r\n\0]/.test(value), code);
  return value.trim();
};
const digits = (value, size) => typeof value === 'string' && new RegExp(`^\\d{${size}}$`).test(value);
export const digest = value => createHash('sha256').update(value).digest('hex');
// jsonb does not preserve object-key order; hash a canonical representation.
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function validCnpj(value) {
  if (!digits(value, 14) || /^(\d)\1+$/.test(value)) return false;
  const check = length => {
    const weights = length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const remainder = weights.reduce((sum, w, i) => sum + Number(value[i]) * w, 0) % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return Number(value[12]) === check(12) && Number(value[13]) === check(13);
}

export function validateIssuer(value) {
  requireValue(value && value.environment === 2, 'HOMOLOGATION_ONLY');
  requireValue(validCnpj(value.cnpj), 'INVALID_ISSUER_CNPJ');
  requireValue(digits(value.ie, 12), 'INVALID_ISSUER_IE');
  requireValue(value.uf === 'SP' && value.crt === 1, 'ONLY_SP_SIMPLES_SUPPORTED');
  requireValue(Number.isInteger(value.series) && value.series >= 1 && value.series <= 889, 'INVALID_FISCAL_SERIES');
  requireValue(Number.isInteger(value.nextNumber) && value.nextNumber >= 1 && value.nextNumber <= 999999999,
    'INVALID_FISCAL_NUMBER');
  requireValue(digits(value.cityCode, 7) && value.cityCode.startsWith('35') && digits(value.zipCode, 8),
    'INVALID_ISSUER_ADDRESS');
  requireValue(/^[A-Z][A-Z0-9_]{0,39}$/.test(value.credentialsRef || ''), 'INVALID_CREDENTIALS_REF');
  return {
    cnpj: value.cnpj, ie: value.ie, uf: 'SP', crt: 1, environment: 2,
    series: value.series, nextNumber: value.nextNumber, enabled: value.enabled === true,
    credentialsRef: value.credentialsRef, name: clean(value.name, 60, 'ISSUER_NAME_REQUIRED'),
    tradeName: clean(value.tradeName || value.name, 60, 'ISSUER_NAME_REQUIRED'),
    street: clean(value.street, 60, 'ISSUER_ADDRESS_REQUIRED'),
    number: clean(value.number, 60, 'ISSUER_ADDRESS_REQUIRED'),
    district: clean(value.district, 60, 'ISSUER_ADDRESS_REQUIRED'),
    city: clean(value.city, 60, 'ISSUER_ADDRESS_REQUIRED'), cityCode: value.cityCode, zipCode: value.zipCode,
    establishmentEvidence: clean(value.establishmentEvidence, 250, 'ESTABLISHMENT_REVIEW_REQUIRED')
  };
}

export function validateProfile(value) {
  requireValue(value && digits(value.ncm, 8), 'NCM_REQUIRED');
  requireValue(Number.isInteger(value.origin) && value.origin >= 0 && value.origin <= 8, 'ORIGIN_REQUIRED');
  requireValue((value.cfop === '5102' && value.csosn === '102') ||
    (value.cfop === '5405' && value.csosn === '500'), 'TAX_OPERATION_NOT_SUPPORTED');
  requireValue(['04','06','07','08','09','49','99'].includes(value.pisCst) &&
    ['04','06','07','08','09','49','99'].includes(value.cofinsCst), 'PIS_COFINS_CLASSIFICATION_REQUIRED');
  requireValue(value.cest == null || value.cest === '' || digits(value.cest, 7), 'INVALID_CEST');
  requireValue(value.csosn !== '500' || digits(value.cest, 7), 'CEST_REQUIRED_FOR_ST');
  requireValue(value.gtin === 'SEM GTIN' || validGtin(value.gtin), 'GTIN_CLASSIFICATION_REQUIRED');
  requireValue(value.taxYear === 2026, 'RTC_PROFILE_REQUIRED_FOR_2027');
  requireValue(Number.isInteger(value.approxTaxBps) && value.approxTaxBps >= 0 && value.approxTaxBps <= 10000,
    'APPROXIMATE_TAX_REQUIRED');
  return {
    ncm: value.ncm, cest: value.cest || null, origin: value.origin,
    cfop: value.cfop, csosn: value.csosn, pisCst: value.pisCst, cofinsCst: value.cofinsCst,
    gtin: value.gtin, unit: clean(value.unit, 6, 'FISCAL_UNIT_REQUIRED'), taxYear: 2026,
    approxTaxBps: value.approxTaxBps, approxTaxSource: clean(value.approxTaxSource, 100, 'TAX_SOURCE_REQUIRED'),
    classificationEvidence: clean(value.classificationEvidence, 250, 'TAX_REVIEW_REQUIRED')
  };
}

function validGtin(value) {
  if (typeof value !== 'string' || !/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const body = value.slice(0, -1);
  const sum = [...body].reverse().reduce((total, v, i) => total + Number(v) * (i % 2 ? 1 : 3), 0);
  return Number(value.at(-1)) === (10 - sum % 10) % 10;
}

function cents(value) {
  requireValue(/^\d+$/.test(String(value)), 'INVALID_FISCAL_AMOUNT');
  const amount = BigInt(value);
  requireValue(amount <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_FISCAL_AMOUNT');
  return amount;
}
const money = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
export function grossCents(quantity, price) {
  const [integer, fraction = ''] = normalizeQuantity(quantity).split('.');
  const scaled = BigInt(integer) * 1000n + BigInt(fraction.padEnd(3, '0'));
  requireValue(scaled > 0n, 'INVALID_FISCAL_QUANTITY');
  return (scaled * cents(price) + 500n) / 1000n;
}
function normalizeQuantity(value) {
  // PostgreSQL sale_items is numeric(14,4), even though POS accepts three decimals.
  const match=/^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value));
  requireValue(match && (!match[2] || match[2].length<4 || match[2].at(-1)==='0'), 'INVALID_FISCAL_QUANTITY');
  return match[1] + (match[2]?'.'+match[2].slice(0,3):'');
}

export function saleSnapshot(sale, issuer, items, payments, profiles, now = Date.now(), {manual=false}={}) {
  requireValue(sale.source === 'POS' && sale.status === 'APPROVED', 'SALE_NOT_ELIGIBLE');
  requireValue(issuer.environment === 2 && issuer.enabled, 'FISCAL_NOT_ENABLED');
  const at = Date.parse(sale.occurred_at);
  requireValue(Number.isFinite(at) && at <= now + 60000, 'INVALID_FISCAL_DATE');
  // Manual homologation uses the actual preparation time and retains the sale's
  // original date separately. Automatic late sales still require an offline flow.
  requireValue(manual || now - at <= 300000, 'OFFLINE_FISCAL_FLOW_REQUIRED');
  const year = new Intl.DateTimeFormat('en', {timeZone:'America/Sao_Paulo', year:'numeric'}).format(new Date(at));
  const issueYear=new Intl.DateTimeFormat('en',{timeZone:'America/Sao_Paulo',year:'numeric'}).format(new Date(now));
  requireValue(year === '2026' && issueYear==='2026', 'RTC_PROFILE_REQUIRED_FOR_2027');
  requireValue(items.length > 0 && items.length <= 200 && payments.length > 0, 'INVALID_FISCAL_SALE');
  const fiscalItems = items.map(item => {
    requireValue(item.product_id != null, 'PRODUCT_FISCAL_MAPPING_REQUIRED');
    const profile = validateProfile(profiles.get(String(item.product_id)));
    requireValue(!item.unit_of_measure || item.unit_of_measure===profile.unit, 'FISCAL_UNIT_MISMATCH');
    const gross = grossCents(item.quantity, item.unit_price_cents);
    requireValue(gross - cents(item.discount_cents || 0) === cents(item.total_cents), 'FISCAL_ITEM_TOTAL_MISMATCH');
    return {...item, quantity:normalizeQuantity(item.quantity), description: clean(item.description, 120, 'INVALID_FISCAL_DESCRIPTION'),
      product_code: clean(String(item.product_code || item.product_id), 60, 'INVALID_FISCAL_PRODUCT_CODE'),
      gross_cents: String(gross), profile};
  });
  const methods = {PIX:'17', CREDIT:'03', DEBIT:'04'};
  const fiscalPayments = payments.map(p => {
    requireValue(methods[p.method] && p.simulated === true, 'ONLY_SIMULATED_HOMOLOGATION_PAYMENTS');
    return {method:p.method, amount_cents:String(cents(p.amount_cents)), simulated:true};
  });
  const total = cents(sale.total_cents);
  requireValue(fiscalItems.reduce((sum,i) => sum + cents(i.total_cents), 0n) === total &&
    fiscalPayments.reduce((sum,p) => sum + cents(p.amount_cents), 0n) === total, 'FISCAL_SALE_TOTAL_MISMATCH');
  const cpf = sale.raw_payload?.buyerCpf;
  if (cpf != null) requireValue(validCpf(cpf), 'INVALID_BUYER_CPF');
  return {issuer, sale:{id:String(sale.id), clientSaleId:sale.client_sale_id,
    occurredAt:new Date(at).toISOString(), ...(manual?{issuedAt:new Date(now).toISOString()}:{}),
    totalCents:String(total), buyerCpf:cpf || null},
    items:fiscalItems, payments:fiscalPayments};
}

function validCpf(value) {
  if (!digits(value, 11) || /^(\d)\1+$/.test(value)) return false;
  const check = length => {
    const remainder = [...value.slice(0,length)].reduce((s,v,i) => s + Number(v) * (length + 1 - i), 0) * 10 % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return check(9) === Number(value[9]) && check(10) === Number(value[10]);
}

function localDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:'America/Sao_Paulo',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit',
    hourCycle:'h23'}).formatToParts(new Date(value)).map(p => [p.type,p.value]));
  return {month:parts.year.slice(-2) + parts.month,
    text:`${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`};
}

export function accessKey(snapshot, number, cnf) {
  requireValue(Number.isInteger(number) && number >= 1 && number <= 999999999 && digits(cnf,8), 'INVALID_FISCAL_NUMBER');
  const base = '35' + localDate(snapshot.sale.issuedAt ?? snapshot.sale.occurredAt).month + snapshot.issuer.cnpj + '65' +
    String(snapshot.issuer.series).padStart(3,'0') + String(number).padStart(9,'0') + '1' + cnf;
  const sum = [...base].reverse().reduce((s,v,i) => s + Number(v) * (2 + i % 8), 0);
  const remainder = sum % 11;
  return base + (remainder < 2 ? '0' : String(11-remainder));
}

export function buildNfceIni(snapshot, number, cnf = String(randomInt(0,100000000)).padStart(8,'0')) {
  const issuer = snapshot.issuer;
  requireValue(issuer.environment === 2, 'HOMOLOGATION_ONLY');
  let result = '';
  const section = (name, fields) => {
    result += `[${name}]\n`;
    for (const [key,value] of Object.entries(fields)) {
      if (value == null || value === '') continue;
      requireValue(!/[\r\n\0]/.test(String(value)), 'INVALID_INI_VALUE');
      result += `${key}=${value}\n`;
    }
    result += '\n';
  };
  const key = accessKey(snapshot,number,cnf);
  section('infNFe',{versao:'4.00'});
  section('Identificacao',{cNF:cnf,natOp:'VENDA DE MERCADORIAS',mod:65,serie:issuer.series,nNF:number,
    dhEmi:localDate(snapshot.sale.issuedAt ?? snapshot.sale.occurredAt).text,tpNF:1,idDest:1,tpAmb:2,tpImp:4,tpEmis:1,
    finNFe:1,indFinal:1,indPres:1,procEmi:0,cMunFG:issuer.cityCode,verProc:'Facinho-Fiscal-0.1'});
  section('Emitente',{CRT:1,CNPJCPF:issuer.cnpj,xNome:issuer.name,xFant:issuer.tradeName,IE:issuer.ie,
    xLgr:issuer.street,nro:issuer.number,xBairro:issuer.district,cMun:issuer.cityCode,xMun:issuer.city,
    cUF:35,UF:'SP',CEP:issuer.zipCode,cPais:1058,xPais:'BRASIL'});
  if (snapshot.sale.buyerCpf) section('Destinatario',{CNPJCPF:snapshot.sale.buyerCpf,indIEDest:9});
  let totalGross=0n,totalDiscount=0n,totalApprox=0n;
  snapshot.items.forEach((item,index) => {
    const suffix = String(index+1).padStart(3,'0'), tax = item.profile;
    const approximate = (cents(item.total_cents) * BigInt(tax.approxTaxBps) + 5000n) / 10000n;
    totalGross += cents(item.gross_cents); totalDiscount += cents(item.discount_cents || 0); totalApprox += approximate;
    section(`Produto${suffix}`,{cProd:item.product_code,cEAN:tax.gtin,cEANTrib:tax.gtin,
      xProd:index===0?'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL':item.description,
      NCM:tax.ncm,CEST:tax.cest,CFOP:tax.cfop,uCom:tax.unit,qCom:item.quantity,
      vUnCom:money(cents(item.unit_price_cents)),vProd:money(cents(item.gross_cents)),
      uTrib:tax.unit,qTrib:item.quantity,vUnTrib:money(cents(item.unit_price_cents)),
      vDesc:money(cents(item.discount_cents || 0)),indTot:1,vTotTrib:money(approximate)});
    section(`ICMS${suffix}`,{CSOSN:tax.csosn,orig:tax.origin});
    for (const kind of ['PIS','COFINS']) {
      const cst=kind==='PIS'?tax.pisCst:tax.cofinsCst;
      section(`${kind}${suffix}`, {CST:cst,...(['49','99'].includes(cst)?
        {vBC:'0.00',[`p${kind}`]:'0.00',[`v${kind}`]:'0.00'}:{})});
    }
  });
  section('Total',{vBC:'0.00',vICMS:'0.00',vICMSDeson:'0.00',vFCP:'0.00',vBCST:'0.00',vST:'0.00',
    vProd:money(totalGross),vFrete:'0.00',vSeg:'0.00',vDesc:money(totalDiscount),vII:'0.00',vIPI:'0.00',
    vPIS:'0.00',vCOFINS:'0.00',vOutro:'0.00',vNF:money(cents(snapshot.sale.totalCents)),vTotTrib:money(totalApprox)});
  section('Transportador',{modFrete:9});
  const methods = {PIX:'17',CREDIT:'03',DEBIT:'04'};
  snapshot.payments.forEach((p,i) => section(`pag${String(i+1).padStart(3,'0')}`,
    {tPag:methods[p.method],vPag:money(cents(p.amount_cents)),indPag:0,
      ...(['CREDIT','DEBIT'].includes(p.method)?{tpIntegra:2}:{})}));
  section('DadosAdicionais',{infCpl:`HOMOLOGACAO - SEM VALOR FISCAL. Tributos aproximados R$ ${money(totalApprox)}. ` +
    `Fonte: ${[...new Set(snapshot.items.map(i=>i.profile.approxTaxSource))].join('; ')}.`});
  return {ini:result,accessKey:key,cnf};
}

// Keep protocols as text: SP adopted 17 positions in production on 05/10/2026.
export function parseAcbrResponse(response, key) {
  requireValue(typeof response === 'string' && response.length <= 2097152, 'INVALID_ACBR_RESPONSE');
  const groups=[];let current=null;
  for (const line of response.split(/\r?\n/)) {
    if (/^\[[^\]]+\]$/.test(line.trim())) {current={};groups.push(current);continue;}
    const pair=/^([^=]+)=(.*)$/.exec(line);
    if (pair && current) current[pair[1].trim().toLowerCase()]=pair[2].trim();
  }
  const identified=groups.find(g => (g.chdfe || g.chnfe) === key && g.cstat);
  const group=identified || groups.find(g => g.cstat && !['103','104','105'].includes(g.cstat)) || groups[0] || {};
  const code=group.cstat || '';
  const authorized=code==='100' && (group.chdfe || group.chnfe)===key && /^\d{15,17}$/.test(group.nprot || '') &&
    group.tpamb === '2';
  return {authorized,code,protocol:authorized?group.nprot:null,message:(group.xmotivo || '').slice(0,500)};
}
