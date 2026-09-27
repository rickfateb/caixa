// Converte apenas os campos operacionais necessários. Não persiste dados de cliente
// nem comprovantes TEF, que podem conter dados pessoais ou de cartão.
const value = v => v == null ? '' : String(v).trim();
const source = row => row?.dados && typeof row.dados === 'object' ? row.dados : row;

function cents(v) {
  const raw=value(v);
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) throw Error('INVALID_SAURUS_AMOUNT');
  const [whole,decimal='']=raw.split('.');
  const padded=(decimal+'00000').slice(0,5);
  const amount=BigInt(whole)*100n+BigInt(padded.slice(0,2))+(Number(padded[2])>=5?1n:0n);
  if(amount>BigInt(Number.MAX_SAFE_INTEGER)) throw Error('INVALID_SAURUS_AMOUNT');
  return Number(amount);
}
const optionalCents = v => value(v)==='' ? null : cents(v);

export function normalizeSaurusSale(record) {
  const s=source(record.venda);
  if(!s||typeof s!=='object') throw Error('INVALID_SAURUS_SALE');
  const externalId=value(s.mov_idMov),storeId=value(s.emit_idLoja),registerNumber=value(s.mov_numCaixa);
  const localTime=value(s.mov_dhEmi).replace(' ','T');
  if(!externalId||!storeId||!registerNumber||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(localTime))
    throw Error('INVALID_SAURUS_SALE');
  const occurredAt=new Date(`${localTime}-03:00`);
  if(Number.isNaN(occurredAt.getTime())) throw Error('INVALID_SAURUS_SALE');
  const sourceStatus=value(s.mov_descStatus);
  const status=/aprovad/i.test(sourceStatus)?'APPROVED':/cancelad/i.test(sourceStatus)?'CANCELLED':null;
  if(!status) throw Error('UNKNOWN_SAURUS_STATUS');
  const children=(name,max) => {
    const rows=record[name]||[];
    if(!Array.isArray(rows)||rows.length>max) throw Error('INVALID_SAURUS_SALE');
    return rows.map(source);
  };
  const items=children('produtos',200).map((i,n)=>{
    const quantity=value(i.prod_qCom),description=value(i.prod_xProd);
    if(!description||!/^\d+(?:\.\d{1,4})?$/.test(quantity)||Number(quantity)<=0) throw Error('INVALID_SAURUS_ITEM');
    return {lineNumber:n+1,externalId:value(i.prod_idProd)||null,externalProductId:value(i.prod_idProduto)||null,
      productCode:value(i.prod_cProd)||null,description:description.slice(0,250),unit:value(i.prod_uCom)||null,
      quantity,unitPriceCents:cents(i.prod_vUnCom),sourceUnitPrice:value(i.prod_vUnCom),
      totalCents:cents(i.prod_vProd),discountCents:optionalCents(i.prod_vDesc)||0};
  });
  const payments=children('pagamentos',20).map((p,n)=>({lineNumber:n+1,
    externalId:value(p.fat_idFaturaPag)||null,method:(value(p.fat_descPag)||value(p.fat_idPag)||'Não informado').slice(0,60),
    amountCents:cents(p.fat_vPago),plan:value(p.fat_descPlano)||null}));
  const installments=children('parcelas',50).map((p,n)=>({lineNumber:n+1,
    externalId:value(p.fat_idFaturaParc)||null,externalPaymentId:value(p.fat_idFaturaPag)||null,
    dueDate:/^\d{4}-\d\d-\d\d/.test(value(p.fat_dVenc))?value(p.fat_dVenc).slice(0,10):null,
    amountCents:optionalCents(p.fat_vParc),paidCents:optionalCents(p.fat_vParcPago),status:value(p.fat_indStatus)||null}));
  const tef=children('tef',50).map((p,n)=>({lineNumber:n+1,
    externalId:value(p.fat_idFaturaTef)||null,externalPaymentId:value(p.fat_idFaturaPag)||null,
    transactionId:value(p.fat_idTef)||null,authorizationCode:value(p.fat_codAut)||null,
    nsu:value(p.fat_codNSU)||null,controlCode:value(p.fat_codControle)||null,
    status:value(p.fat_indStatus)||null,transactionType:value(p.fat_tpTransacao)||null,
    occurredAt: /^\d{4}-\d\d-\d\d/.test(value(p.fat_dataTransacao))?value(p.fat_dataTransacao):null}));
  return {externalId,storeId,registerNumber,occurredAt:occurredAt.toISOString(),sourceStatus,status,
    totalCents:cents(s.tot_vNF),items,payments,installments,tef};
}
