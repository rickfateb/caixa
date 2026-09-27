export const TIME_ZONE = 'America/Sao_Paulo';
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export function promotionApplies(p, productId, at = new Date()) {
  if (!p.active || at < new Date(p.starts_at) || at >= new Date(p.ends_at)) return false;
  if (p.scope === 'PRODUCTS' && !p.product_ids.map(String).includes(String(productId))) return false;
  if (p.weekdays != null) {
    const time = Object.fromEntries(parts.formatToParts(at).map(x => [x.type, x.value]));
    const weekday = days.indexOf(time.weekday);
    const local = `${time.hour}:${time.minute}`;
    if (!p.weekdays.includes(weekday) || local < p.local_start.slice(0,5) || local >= p.local_end.slice(0,5)) return false;
  }
  return true;
}
export function pickPromotion(promotions, productId, at = new Date()) {
  return promotions.filter(p => promotionApplies(p, productId, at))
    .sort((a,b) => b.priority-a.priority || Number(b.scope==='PRODUCTS')-Number(a.scope==='PRODUCTS') || Number(b.id)-Number(a.id))[0] || null;
}
export function quotePrice(baseCents, promotion, quantity = 1) {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0 || !Number.isFinite(quantity) || quantity <= 0) throw Error('INVALID_PRICE_OR_QUANTITY');
  const regular = Math.round(baseCents * quantity);
  if (!promotion) return { totalCents:regular, discountCents:0, unitPriceCents:baseCents };
  if (promotion.type === 'PRICE') return { totalCents:Math.round(Number(promotion.price_cents)*quantity), discountCents:0, unitPriceCents:Number(promotion.price_cents) };
  let total = regular;
  if (promotion.type === 'PERCENT') total = regular - Math.round(regular*Number(promotion.percent_off)/100);
  if (promotion.type === 'BUY_N_PAY_M' && Number.isInteger(quantity))
    total = regular-Math.floor(quantity/promotion.buy_quantity)*(promotion.buy_quantity-promotion.pay_quantity)*baseCents;
  if (promotion.type === 'SECOND_UNIT_PRICE' && Number.isInteger(quantity))
    total = regular-Math.floor(quantity/2)*Math.max(0,baseCents-Number(promotion.second_unit_price_cents));
  total = Math.min(regular,total);
  return { totalCents:total, discountCents:regular-total, unitPriceCents:baseCents };
}
