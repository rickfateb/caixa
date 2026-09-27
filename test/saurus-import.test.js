import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSaurusSale} from '../src/saurus-import.js';

test('converte venda Saurus com itens fracionados, pagamentos, parcelas e TEF sem dados de cliente',()=>{
  const source={venda:{dados:{mov_idMov:'812',emit_idLoja:'6',mov_numCaixa:'12',mov_dhEmi:'2026-09-26T23:53:52',
    mov_descStatus:'Venda Aprovada',tot_vNF:'5.49',dest_xNome:'Nome privado'}},
    produtos:[{dados:{prod_idProd:'45',prod_idProduto:'223',prod_cProd:'789',prod_xProd:'Produto',prod_qCom:'1.2000',
      prod_uCom:'KG',prod_vUnCom:'4.5000',prod_vProd:'5.4900',prod_vDesc:'0'}}],
    pagamentos:[{dados:{fat_idFaturaPag:'77',fat_descPag:'PIX',fat_vPago:'5.49'}}],
    parcelas:[{dados:{fat_idFaturaParc:'88',fat_idFaturaPag:'77',fat_dVenc:'2026-09-27',fat_vParc:'5.49'}}],
    tef:[{dados:{fat_idFaturaTef:'90',fat_idFaturaPag:'77',fat_codNSU:'123'}}]};
  const parsed=normalizeSaurusSale(source);
  assert.equal(parsed.occurredAt,'2026-09-27T02:53:52.000Z');
  assert.equal(parsed.items[0].quantity,'1.2000');
  assert.equal(parsed.items[0].totalCents,549);
  assert.equal(parsed.payments[0].amountCents,549);
  assert.equal(parsed.installments[0].externalPaymentId,'77');
  assert.equal(parsed.tef[0].nsu,'123');
  assert.ok(!JSON.stringify(parsed).includes('Nome privado'));
});

test('não inventa estado para venda Saurus com status desconhecido',()=>{
  assert.throws(()=>normalizeSaurusSale({venda:{mov_idMov:'1',emit_idLoja:'6',mov_numCaixa:'12',
    mov_dhEmi:'2026-09-26T23:53:52',mov_descStatus:'Aberta',tot_vNF:'1'}}),/UNKNOWN_SAURUS_STATUS/);
});
