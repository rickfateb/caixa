import test from 'node:test';
import assert from 'node:assert/strict';
import {pickPromotion,promotionApplies,quotePrice} from '../src/pricing.js';
const base={active:true,starts_at:'2026-09-01T03:00:00Z',ends_at:'2026-10-01T03:00:00Z',scope:'ALL',product_ids:[],priority:0,id:'1'};
test('recorrência usa dia e horário de Brasília; fim exclusivo',()=>{
  const p={...base,weekdays:[1],local_start:'09:00:00',local_end:'12:00:00'};
  assert.equal(promotionApplies(p,'5',new Date('2026-09-28T11:59:00Z')),false);
  assert.equal(promotionApplies(p,'5',new Date('2026-09-28T12:00:00Z')),true);
  assert.equal(promotionApplies(p,'5',new Date('2026-09-28T15:00:00Z')),false);
  assert.equal(promotionApplies(p,'5',new Date('2026-09-29T13:00:00Z')),false);
});
test('produto específico vence geral em empate e maior prioridade vence',()=>{
  const all={...base,id:'9',type:'PERCENT',percent_off:10};
  const specific={...base,id:'2',scope:'PRODUCTS',product_ids:['5'],type:'PRICE',price_cents:399};
  const at=new Date('2026-09-28T13:00:00Z');
  assert.equal(pickPromotion([all,specific],'5',at).id,'2');
  assert.equal(pickPromotion([{...all,priority:1},specific],'5',at).id,'9');
  assert.equal(pickPromotion([all,specific],'6',at).id,'9');
});
test('preço temporário pode ser diferente inclusive acima do normal',()=>{
  assert.deepEqual(quotePrice(499,{type:'PRICE',price_cents:599},2),{totalCents:1198,discountCents:0,unitPriceCents:599});
});
test('10%, leve 3 pague 2 e segunda unidade por R$ 1,99',()=>{
  assert.equal(quotePrice(499,{type:'PERCENT',percent_off:10},2).totalCents,898);
  assert.equal(quotePrice(499,{type:'BUY_N_PAY_M',buy_quantity:3,pay_quantity:2},7).totalCents,2495);
  assert.deepEqual(quotePrice(499,{type:'SECOND_UNIT_PRICE',second_unit_price_cents:199},2),{totalCents:698,discountCents:300,unitPriceCents:499});
});
