import {validateIssuer,validateProfile,saleSnapshot,buildNfceIni,canonicalJson,digest} from '../src/fiscal-core.js';
export const now=Date.parse('2026-10-09T15:00:00-03:00');
export const issuer=validateIssuer({cnpj:'57423823000147',ie:'177647515117',uf:'SP',crt:1,environment:2,
  series:1,nextNumber:1,enabled:true,credentialsRef:'TEST',name:'EMPRESA DE TESTE',tradeName:'TESTE',
  street:'RUA DE TESTE',number:'1',district:'TESTE',city:'ARACATUBA',cityCode:'3502804',zipCode:'16072410',
  establishmentEvidence:'Fixture de teste; não comprova cadastro fiscal.'});
export const profile=validateProfile({ncm:'19021900',origin:0,cfop:'5102',csosn:'102',pisCst:'49',cofinsCst:'49',
  gtin:'SEM GTIN',unit:'UN',taxYear:2026,approxTaxBps:1000,approxTaxSource:'FIXTURE - SEM VALOR FISCAL',
  classificationEvidence:'Fixture; não representa classificação de produto real.'});
export const sale={id:'1',source:'POS',status:'APPROVED',client_sale_id:'test-sale',
  occurred_at:'2026-10-09T14:59:00-03:00',total_cents:'698',raw_payload:{}};
export const items=[{line_number:1,product_id:'1',product_code:'T1',description:'MERCADORIA DE TESTE',
  quantity:'2.000',unit_price_cents:'499',discount_cents:'300',total_cents:'698'}];
export const payments=[{line_number:1,method:'PIX',amount_cents:'698',simulated:true}];
export function fixture() {
  const snapshot=saleSnapshot(sale,structuredClone(issuer),items,payments,new Map([['1',profile]]),now);
  const built=buildNfceIni(snapshot,1,'12345678');
  return {id:'1',environment:2,status:'PENDING',snapshot,snapshot_hash:digest(canonicalJson(snapshot)),
    ini_payload:built.ini,access_key:built.accessKey,attempts:0};
}
// Deliberately synthetic native output for unit tests, never an issued document.
export function fakeXml(key,protocol='13526000000000001') {
  return `<nfeProc><NFe><infNFe Id="NFe${key}"><ide><tpAmb>2</tpAmb></ide></infNFe><Signature>TEST</Signature></NFe><protNFe><infProt><tpAmb>2</tpAmb><chNFe>${key}</chNFe><nProt>${protocol}</nProt><cStat>100</cStat></infProt></protNFe><qrCode><![CDATA[https://homologacao.nfce.fazenda.sp.gov.br/qrcode?test=1&value=2]]></qrCode></nfeProc>`;
}
export const authorizedResponse=key=>`[ENVIO]\nCStat=104\n[NFE1]\nTpAmb=2\nCStat=100\nchDFe=${key}\nNProt=13526000000000001\nXMotivo=Autorizado para teste\n`;
