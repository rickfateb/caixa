const $=id=>document.getElementById(id);
const safe=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const brl=cents=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(cents||0)/100);
const asCents=value=>Math.round(Number(String(value).replace(',','.'))*100);
let token=sessionStorage.getItem('facinho_google_token')||'';
let me=null,units=[],products=[],promotions=[],salesOffset=0;
const flash=(message,error=false)=>{const el=$('flash');el.textContent=message;el.className='flash'+(error?' error':'');el.hidden=false;setTimeout(()=>el.hidden=true,7000);};
async function api(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
  return data;
}
const send=(url,method,body)=>api(url,{method,body:JSON.stringify(body)});
const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${safe(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${headers.length}">Nenhum registro.</td></tr>`}</tbody></table></div>`;
function selectUnits(){for(const id of ['price-unit','register-unit','settings-unit','sales-unit']){const el=$(id),old=el.value;el.innerHTML=(id==='sales-unit'?'<option value="">Todas</option>':'')+units.filter(u=>u.active).map(u=>`<option value="${u.id}">${safe(u.name)} (${safe(u.acronym)})</option>`).join('');if(units.some(u=>String(u.id)===old))el.value=old;}}
async function loadUnits(){units=await api('/api/admin/units');selectUnits();$('units-list').innerHTML=table(['Sigla','Unidade','ID externo','Status',''],units.map(u=>`<tr><td>${safe(u.acronym)}</td><td>${safe(u.name)}</td><td>${safe(u.external_id)}</td><td>${u.active?'Ativa':'Inativa'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-edit-unit="${u.id}">Editar</button>`:''}</td></tr>`));}
async function loadProducts(){const q=encodeURIComponent($('product-search').value);products=await api(`/api/admin/products?limit=200&q=${q}`);$('products-list').innerHTML=table(['Código','Produto','Categoria','Preço padrão','EAN','Status',''],products.map(p=>`<tr><td>${safe(p.code)}</td><td>${safe(p.description)}</td><td>${safe(p.category)}</td><td>${p.default_sale_price_cents==null?'—':brl(p.default_sale_price_cents)}</td><td>${safe((p.barcodes||[]).join(', '))}</td><td>${p.active?'Ativo':'Inativo'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-edit-product="${p.id}">Editar</button>`:''}</td></tr>`));$('price-product').innerHTML=products.map(p=>`<option value="${p.id}">${safe(p.description)}</option>`).join('');}
async function loadPrices(){const unit=$('price-unit').value;if(!unit)return;$('prices-list').innerHTML=table(['Produto','Código','Categoria','Preço','Ativo',''],(await api(`/api/admin/unit-products/${unit}`)).map(p=>`<tr><td>${safe(p.description)}</td><td>${safe(p.code)}</td><td>${safe(p.category)}</td><td>${brl(p.sale_price_cents)}</td><td>${p.active?'Sim':'Não'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-remove-price="${p.product_id}">Remover preço específico</button>`:''}</td></tr>`));}
const localDate=value=>value?new Date(value).toLocaleString('sv-SE',{timeZone:'America/Sao_Paulo'}).replace(' ','T').slice(0,16):'';
async function loadPromotions(){promotions=await api('/api/admin/promotions');$('promotions-list').innerHTML=table(['Nome','Regra','Abrangência','Vigência (Brasília)','Status',''],promotions.map(p=>`<tr><td>${safe(p.name)}</td><td>${safe(({PRICE:'Preço temporário',PERCENT:'Desconto',BUY_N_PAY_M:'Compre e pague',SECOND_UNIT_PRICE:'2ª unidade por preço fixo'})[p.type])}</td><td>${p.scope==='ALL'?'Todos os produtos':`${p.product_ids.length} produto(s)`} · ${p.unit_ids.length?`${p.unit_ids.length} unidade(s)`:'Todas as unidades'}</td><td>${safe(localDate(p.starts_at))} a ${safe(localDate(p.ends_at))}${p.weekdays?' · semanal':''}</td><td>${p.active?'Ativa':'Inativa'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-edit-promotion="${p.id}">Editar</button>`:''}</td></tr>`));}
async function loadRegisters(){$('registers-list').innerHTML=table(['Unidade','Caixa','Número','Status',''],(await api('/api/admin/registers')).map(r=>`<tr><td>${safe(units.find(u=>u.id===r.unit_id)?.name)}</td><td>${safe(r.name)}</td><td>${safe(r.external_number)}</td><td>${r.active?'Ativo':'Inativo'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-toggle-register="${r.id}" data-active="${r.active}">${r.active?'Desativar':'Ativar'}</button> <button class="secondary" data-rotate-register="${r.id}">Gerar nova chave</button>`:''}</td></tr>`));}
function showRegisterToken(data){
  const result=$('token-result');
  result.innerHTML=`<strong>Chave do caixa ${safe(data.name)}</strong><p>Guarde esta chave agora. Após sair desta página, ela não poderá ser consultada novamente.</p><div class="token-key"><input id="register-token" type="password" readonly autocomplete="off" spellcheck="false" aria-label="Chave do caixa" value="${safe(data.token)}"><button type="button" class="secondary" data-token-action="toggle" aria-controls="register-token" aria-pressed="false">Mostrar</button><button type="button" data-token-action="copy">Copiar</button></div>`;
  result.hidden=false;
  result.scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function loadSettings(){const unit=$('settings-unit').value;if(unit)$('settings-value').value=JSON.stringify((await api(`/api/admin/settings/${unit}`)).settings,null,2);}
async function loadSales(more=false){
  if(!more)salesOffset=0;
  const params=new URLSearchParams({offset:String(salesOffset),source:$('sales-source').value,
    unitId:$('sales-unit').value,q:$('sales-search').value.trim()});
  const rows=await api(`/api/admin/sales?${params}`);
  const body=rows.map(s=>`<tr><td>${new Date(s.occurred_at).toLocaleString('pt-BR')}</td><td>${s.source==='SAURUS'?'Saurus':'Portal Caixa'}</td><td>${safe(s.unit_name||'A vincular')}</td><td>${safe(s.register_name||s.external_register_number||'—')}</td><td>${safe(s.external_sale_id||s.client_sale_id)}</td><td>${safe(s.source_status||s.status)}</td><td>${safe(s.item_count)}</td><td>${brl(s.total_cents)}</td><td><button class="secondary" data-sale-detail="${s.id}">Detalhes</button></td></tr>`);
  if(more){const old=$('sales-list').querySelector('tbody');if(old)old.insertAdjacentHTML('beforeend',body.join(''));}
  else $('sales-list').innerHTML=table(['Data','Origem','Unidade','Caixa','ID','Status','Itens','Total',''],body);
  salesOffset+=rows.length;$('more-sales').hidden=rows.length<100;
}
async function showSaleDetail(id){
  const s=await api(`/api/admin/sales/${id}`);
  const d=document.createElement('dialog');d.className='sale-dialog';
  const headings={items:'Itens',payments:'Pagamentos',installments:'Parcelas',tef:'TEF'};
  const sections={
    items:table(['#','Produto','ID de origem','Código','Quantidade','Medida','Unitário','Desconto','Total'],s.items.map(i=>`<tr><td>${i.line_number}</td><td>${safe(i.description)}</td><td>${safe(i.external_product_id||i.product_id)}</td><td>${safe(i.product_code||i.barcode)}</td><td>${safe(i.quantity)}</td><td>${safe(i.unit_of_measure)}</td><td>${brl(i.unit_price_cents)}</td><td>${brl(i.discount_cents)}</td><td>${brl(i.total_cents)}</td></tr>`)),
    payments:table(['#','Forma','ID de origem','Valor','Referência'],s.payments.map(p=>`<tr><td>${p.line_number}</td><td>${safe(p.method)}</td><td>${safe(p.external_payment_id)}</td><td>${brl(p.amount_cents)}</td><td>${safe(p.provider_reference)}</td></tr>`)),
    installments:table(['#','ID de origem','Pagamento','Vencimento','Valor','Pago','Status'],s.installments.map(p=>`<tr><td>${p.line_number}</td><td>${safe(p.external_id)}</td><td>${safe(p.external_payment_id)}</td><td>${p.due_date?new Date(p.due_date).toLocaleDateString('pt-BR',{timeZone:'UTC'}):'—'}</td><td>${p.amount_cents==null?'—':brl(p.amount_cents)}</td><td>${p.paid_cents==null?'—':brl(p.paid_cents)}</td><td>${safe(p.status)}</td></tr>`)),
    tef:table(['#','ID de origem','Pagamento','NSU','Autorização','Controle','Tipo','Status'],s.tef.map(p=>`<tr><td>${p.line_number}</td><td>${safe(p.external_id)}</td><td>${safe(p.external_payment_id)}</td><td>${safe(p.nsu)}</td><td>${safe(p.authorization_code)}</td><td>${safe(p.control_code)}</td><td>${safe(p.transaction_type)}</td><td>${safe(p.status)}</td></tr>`))
  };
  d.innerHTML=`<div class="heading"><div><h2>Venda ${safe(s.external_sale_id||s.client_sale_id)}</h2><p>${s.source==='SAURUS'?'Saurus':'Portal Caixa'} · ${safe(s.unit_name||'Unidade a vincular')} · Caixa ${safe(s.register_name||s.external_register_number||'—')} · ${new Date(s.occurred_at).toLocaleString('pt-BR')} · ${brl(s.total_cents)}</p></div><button class="secondary" data-close>Fechar</button></div><nav class="sale-tabs">${Object.entries(headings).map(([key,label])=>`<button data-sale-tab="${key}" class="${key==='items'?'selected':''}">${label} (${s[key].length})</button>`).join('')}</nav><div class="sale-detail-content">${sections.items}</div>`;
  d.querySelector('[data-close]').onclick=()=>d.close();
  d.addEventListener('click',e=>{const key=e.target.closest('[data-sale-tab]')?.dataset.saleTab;if(!key)return;
    d.querySelectorAll('[data-sale-tab]').forEach(b=>b.classList.toggle('selected',b.dataset.saleTab===key));
    d.querySelector('.sale-detail-content').innerHTML=sections[key];});
  d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
}
async function loadMappings(){
  const [rows,registers]=await Promise.all([api('/api/admin/saurus-mappings'),api('/api/admin/registers')]);
  const unitOptions=id=>`<option value="">A vincular</option>`+units.map(u=>`<option value="${u.id}" ${String(u.id)===String(id)?'selected':''}>${safe(u.name)} (${safe(u.acronym)})</option>`).join('');
  const registerOptions=(unitId,registerId)=>`<option value="">Sem vínculo com caixa</option>`+registers.filter(r=>String(r.unit_id)===String(unitId)).map(r=>`<option value="${r.id}" ${String(r.id)===String(registerId)?'selected':''}>${safe(r.name)}</option>`).join('');
  $('mappings-list').innerHTML=table(['Loja de origem','Caixa de origem','Vendas','Unidade Facinho','Caixa Facinho',''],rows.map(m=>`<tr data-map-store="${safe(m.external_store_id)}" data-map-register="${safe(m.external_register_number)}"><td>${safe(m.external_store_id)}</td><td>${safe(m.external_register_number)}</td><td>${m.sale_count}</td><td><select data-map-unit>${unitOptions(m.unit_id)}</select></td><td><select data-map-target>${registerOptions(m.unit_id,m.register_id)}</select></td><td>${me.role==='ADMINISTRADOR'?'<button class="secondary" data-save-mapping>Salvar vínculo</button>':''}</td></tr>`));
  $('mappings-list').onchange=e=>{if(!e.target.matches('[data-map-unit]'))return;
    const row=e.target.closest('tr');row.querySelector('[data-map-target]').innerHTML=registerOptions(e.target.value,null);};
}
async function choose(tab){document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('selected',b.dataset.tab===tab));document.querySelectorAll('.panel').forEach(p=>p.hidden=p.id!==tab);try{await ({units:loadUnits,products:loadProducts,prices:loadPrices,promotions:loadPromotions,registers:loadRegisters,settings:loadSettings,sales:()=>loadSales(),['saurus-mappings']:loadMappings}[tab]||(()=>{}))();}catch(e){flash(e.message,true);}}
function editor(kind,item={}){
  const fields=kind==='unit'?[['name','Nome da unidade'],['acronym','Sigla'],['externalId','ID da unidade no cadastro atual'],['document','Documento']]:[
    ['description','Descrição'],['code','Código do produto'],['externalId','ID no cadastro atual'],['barcodes','Códigos de barras separados por vírgula'],
    ['category','Categoria'],['subcategory','Subcategoria'],['brand','Marca'],['unitOfMeasure','Medida'],['ncm','NCM'],
    ['status','Status'],['itemType','Tipo do item'],['registeredDescription','Descrição registrada'],
    ['purchaseCostCents','Compra (R$)'],['costCents','Custo (R$)'],['defaultPriceCents','Preço de venda padrão (R$)']];
  const d=document.createElement('dialog');d.innerHTML=`<h2>${item.id?'Editar':'Novo'} ${kind==='unit'?'unidade':'produto'}</h2><form method="dialog"><div class="grid">${fields.map(([key,label])=>`<label>${safe(label)}<input name="${key}" autocomplete="off"></label>`).join('')}</div><label><input name="active" type="checkbox" style="width:auto" checked> Ativo</label><menu><button type="button" class="secondary" data-close>Cancelar</button><button type="submit">Salvar</button></menu></form>`;
  document.body.append(d);d.querySelector('[data-close]').onclick=()=>d.close();
  for(const [key] of fields){const el=d.querySelector(`[name="${key}"]`);let val=key==='defaultPriceCents'?item.default_sale_price_cents:item[key]??item[key.replace(/[A-Z]/g,m=>'_'+m.toLowerCase())]??'';if(key==='barcodes')val=(item.barcodes||[]).join(', ');if(key.endsWith('Cents'))val=val==null||val===''?'':Number(val)/100;el.value=val??'';}
  d.querySelector('[name="active"]').checked=item.active!==false;
  d.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);const body=Object.fromEntries(fields.map(([key])=>[key,String(f.get(key)||'').trim()]));body.active=!!f.get('active');
    if(kind==='product'){body.barcodes=body.barcodes.split(',').map(v=>v.trim()).filter(Boolean);for(const k of ['purchaseCostCents','costCents','defaultPriceCents'])body[k]=body[k]===''?null:asCents(body[k]);}
    try{await send(kind==='unit'?(item.id?`/api/admin/units/${item.id}`:'/api/admin/units'):(item.id?`/api/admin/products/${item.id}`:'/api/admin/products'),item.id?(kind==='unit'?'PATCH':'PUT'):'POST',body);d.close();flash('Cadastro salvo.');await(kind==='unit'?loadUnits():loadProducts());}catch(err){alert(err.message);}});
  d.addEventListener('close',()=>d.remove());d.showModal();
}
function promotionEditor(item={}){
  const chosen=new Map((item.product_ids||[]).map(id=>[String(id),products.find(p=>String(p.id)===String(id))?.description||`Produto #${id}`]));
  const d=document.createElement('dialog');d.classList.add('promotion-dialog');
  d.innerHTML=`<h2>${item.id?'Editar':'Nova'} promoção</h2><form><div class="grid">
    <label>Nome<input name="name" required maxlength="120" value="${safe(item.name||'')}"></label>
    <label>Tipo<select name="type"><option value="PRICE">Preço temporário</option><option value="PERCENT">Desconto percentual</option><option value="BUY_N_PAY_M">Compre N, pague M</option><option value="SECOND_UNIT_PRICE">2ª unidade por preço fixo</option></select></label>
    <label data-rule="PRICE">Preço promocional (R$)<input name="priceCents" type="number" min="0" step="0.01" value="${item.price_cents==null?'':Number(item.price_cents)/100}"></label>
    <label data-rule="PERCENT">Desconto (%)<input name="percentOff" type="number" min="0.01" max="100" step="0.01" value="${item.percent_off??''}"></label>
    <label data-rule="BUY_N_PAY_M">Levar N unidades<input name="buyQuantity" type="number" min="2" max="100" value="${item.buy_quantity??3}"></label>
    <label data-rule="BUY_N_PAY_M">Pagar M unidades<input name="payQuantity" type="number" min="1" value="${item.pay_quantity??2}"></label>
    <label data-rule="SECOND_UNIT_PRICE">Preço da 2ª unidade (R$)<input name="secondUnitPriceCents" type="number" min="0" step="0.01" value="${item.second_unit_price_cents==null?'':Number(item.second_unit_price_cents)/100}"></label>
    <label>Início da vigência (Brasília)<input name="startsAt" type="datetime-local" required value="${safe(localDate(item.starts_at))}"></label>
    <label>Fim da vigência (Brasília)<input name="endsAt" type="datetime-local" required value="${safe(localDate(item.ends_at))}"></label>
    <label>Prioridade<input name="priority" type="number" min="-1000" max="1000" value="${item.priority??0}"></label>
  </div><label><input type="checkbox" name="recurrent" ${item.weekdays?'checked':''}> Repetir em dias da semana, dentro da vigência</label>
  <div data-repeat><div class="checks">${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map((x,i)=>`<label><input type="checkbox" name="weekday" value="${i}" ${(item.weekdays||[]).includes(i)?'checked':''}> ${x}</label>`).join('')}</div><div class="grid"><label>Das<input name="localStart" type="time" value="${safe(item.local_start?.slice(0,5)||'08:00')}"></label><label>Até<input name="localEnd" type="time" value="${safe(item.local_end?.slice(0,5)||'22:00')}"></label></div></div>
  <label>Produtos<select name="scope"><option value="ALL">Todos os produtos</option><option value="PRODUCTS">Produtos específicos</option></select></label>
  <div data-products><label>Buscar produto<input name="searchProduct" placeholder="Descrição, código ou EAN"></label><div data-search-results></div><div data-selected-products></div></div>
  <fieldset><legend>Unidades</legend><label><input type="checkbox" name="allUnits" ${!item.unit_ids?.length?'checked':''}> Todas as unidades</label><div class="checks" data-unit-checks>${units.filter(u=>u.active).map(u=>`<label><input type="checkbox" name="unitId" value="${u.id}" ${(item.unit_ids||[]).map(String).includes(String(u.id))?'checked':''}> ${safe(u.name)}</label>`).join('')}</div></fieldset>
  <label><input type="checkbox" name="active" ${item.active!==false?'checked':''}> Promoção ativa</label>
  <menu><button type="button" class="secondary" data-close>Cancelar</button><button type="submit">Salvar promoção</button></menu></form>`;
  document.body.append(d);const f=d.querySelector('form');f.elements.type.value=item.type||'PRICE';f.elements.scope.value=item.scope||'ALL';
  const redraw=()=>{
    d.querySelectorAll('[data-rule]').forEach(el=>el.hidden=el.dataset.rule!==f.elements.type.value);
    d.querySelector('[data-repeat]').hidden=!f.elements.recurrent.checked;
    d.querySelector('[data-products]').hidden=f.elements.scope.value!=='PRODUCTS';
    d.querySelector('[data-unit-checks]').hidden=f.elements.allUnits.checked;
    d.querySelector('[data-selected-products]').innerHTML=[...chosen].map(([id,name])=>`<button type="button" class="secondary" data-remove-product="${id}">${safe(name)} ×</button>`).join('');
  };
  f.addEventListener('change',redraw);d.querySelector('[data-close]').onclick=()=>d.close();
  d.addEventListener('click',e=>{const id=e.target.closest('[data-add-product]')?.dataset.addProduct;if(id){chosen.set(id,e.target.textContent);redraw();}const remove=e.target.closest('[data-remove-product]')?.dataset.removeProduct;if(remove){chosen.delete(remove);redraw();}});
  let timer;f.elements.searchProduct.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(async()=>{const q=f.elements.searchProduct.value.trim();const results=d.querySelector('[data-search-results]');if(!q){results.innerHTML='';return;}try{const matches=await api(`/api/admin/products?limit=30&q=${encodeURIComponent(q)}`);results.innerHTML=matches.map(p=>`<button type="button" class="secondary" data-add-product="${p.id}">${safe(p.description)} · ${safe(p.code)}</button>`).join('')||'Nenhum produto encontrado.';}catch(err){results.textContent=err.message;}},250);});
  f.addEventListener('submit',async e=>{e.preventDefault();const val=name=>f.elements[name].value;
    if(!f.elements.allUnits.checked&&!f.querySelectorAll('[name="unitId"]:checked').length){alert('Selecione pelo menos uma unidade ou marque todas.');return;}
    if(val('scope')==='PRODUCTS'&&!chosen.size){alert('Selecione pelo menos um produto.');return;}
    if((val('type')==='PRICE'&&!val('priceCents'))||(val('type')==='SECOND_UNIT_PRICE'&&!val('secondUnitPriceCents'))||
      (val('type')==='PERCENT'&&!val('percentOff'))){alert('Informe o valor da promoção.');return;}
    const body={name:val('name').trim(),type:val('type'),scope:val('scope'),priority:Number(val('priority')),
      startsAt:`${val('startsAt')}:00-03:00`,endsAt:`${val('endsAt')}:00-03:00`,
      productIds:val('scope')==='ALL'?[]:[...chosen.keys()],unitIds:f.elements.allUnits.checked?[]:[...f.querySelectorAll('[name="unitId"]:checked')].map(x=>x.value),
      weekdays:f.elements.recurrent.checked?[...f.querySelectorAll('[name="weekday"]:checked')].map(x=>Number(x.value)):null,
      localStart:f.elements.recurrent.checked?val('localStart'):null,localEnd:f.elements.recurrent.checked?val('localEnd'):null,active:f.elements.active.checked,
      priceCents:asCents(val('priceCents')),percentOff:Number(val('percentOff')),
      buyQuantity:Number(val('buyQuantity')),payQuantity:Number(val('payQuantity')),
      secondUnitPriceCents:asCents(val('secondUnitPriceCents'))};
    try{await send(item.id?`/api/admin/promotions/${item.id}`:'/api/admin/promotions',item.id?'PUT':'POST',body);d.close();flash('Promoção salva.');await loadPromotions();}catch(err){alert(err.message);}
  });
  d.addEventListener('close',()=>d.remove());redraw();d.showModal();
}
document.addEventListener('click',async e=>{const button=e.target.closest('button');if(!button)return;
  try{
    if(button.dataset.tab)await choose(button.dataset.tab);
    if(button.dataset.editUnit)editor('unit',units.find(u=>String(u.id)===button.dataset.editUnit));
    if(button.dataset.editProduct)editor('product',products.find(p=>String(p.id)===button.dataset.editProduct));
    if(button.id==='new-unit')editor('unit');if(button.id==='new-product')editor('product');
    if(button.id==='new-promotion')promotionEditor();
    if(button.dataset.editPromotion)promotionEditor(promotions.find(p=>String(p.id)===button.dataset.editPromotion));
    if(button.id==='save-price'){const cents=asCents($('price-value').value);if(!Number.isSafeInteger(cents)||cents<0)throw Error('Preço inválido.');await send(`/api/admin/unit-products/${$('price-unit').value}/${$('price-product').value}`,'PUT',{salePriceCents:cents});flash('Preço salvo.');await loadPrices();}
    if(button.dataset.removePrice){if(confirm('Remover o preço desta unidade? O caixa passará a usar o preço padrão, quando cadastrado.')){await api(`/api/admin/unit-products/${$('price-unit').value}/${button.dataset.removePrice}`,{method:'DELETE'});flash('Preço específico removido.');await loadPrices();}}
    if(button.id==='create-register'){
      const data=await send('/api/admin/registers','POST',{unitId:$('register-unit').value,name:$('register-name').value,externalNumber:$('register-number').value});
      showRegisterToken(data);
      await loadRegisters();
    }
    if(button.dataset.rotateRegister){
      if(!confirm('Gerar uma nova chave para este caixa? A chave anterior deixará de funcionar imediatamente no aplicativo do caixa.'))return;
      const data=await send(`/api/admin/registers/${button.dataset.rotateRegister}/rotate-token`,'POST',{});
      showRegisterToken(data);
      flash('Nova chave gerada. Atualize o aplicativo do caixa com esta chave.');
    }
    if(button.dataset.tokenAction==='toggle'){
      const input=$('register-token');
      const visible=input.type==='password';
      input.type=visible?'text':'password';
      button.textContent=visible?'Ocultar':'Mostrar';
      button.setAttribute('aria-pressed',String(visible));
    }
    if(button.dataset.tokenAction==='copy'){
      await navigator.clipboard.writeText($('register-token').value);
      flash('Chave copiada.');
    }
    if(button.dataset.toggleRegister){await send(`/api/admin/registers/${button.dataset.toggleRegister}`,'PATCH',{active:button.dataset.active!=='true'});await loadRegisters();}
    if(button.id==='save-settings'){let settings;try{settings=JSON.parse($('settings-value').value);}catch{throw Error('JSON inválido.');}await send(`/api/admin/settings/${$('settings-unit').value}`,'PUT',{settings});flash('Configurações salvas.');}
    if(button.id==='refresh-sales')await loadSales();
    if(button.id==='more-sales')await loadSales(true);
    if(button.id==='refresh-mappings')await loadMappings();
    if(button.dataset.saleDetail)await showSaleDetail(button.dataset.saleDetail);
    if(button.dataset.saveMapping){
      const row=button.closest('tr');
      const store=encodeURIComponent(row.dataset.mapStore),number=encodeURIComponent(row.dataset.mapRegister);
      await send(`/api/admin/saurus-mappings/${store}/${number}`,'PUT',{
        unitId:row.querySelector('[data-map-unit]').value||null,registerId:row.querySelector('[data-map-target]').value||null});
      flash('Vínculo salvo.');await loadMappings();
    }
  }catch(err){flash(err.message,true);}
});
for(const [id,fn] of [['price-unit',loadPrices],['settings-unit',loadSettings]])$(id).addEventListener('change',()=>fn().catch(err=>flash(err.message,true)));
for(const id of ['sales-source','sales-unit'])$(id).addEventListener('change',()=>loadSales().catch(err=>flash(err.message,true)));
let salesSearchTimer;$('sales-search').addEventListener('input',()=>{clearTimeout(salesSearchTimer);salesSearchTimer=setTimeout(()=>loadSales().catch(err=>flash(err.message,true)),300);});
let searchTimer;$('product-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadProducts().catch(err=>flash(err.message,true)),300);});
let priceTimer;$('price-product-search').addEventListener('input',()=>{clearTimeout(priceTimer);priceTimer=setTimeout(async()=>{try{const q=encodeURIComponent($('price-product-search').value);const found=await api(`/api/admin/products?limit=200&q=${q}`);$('price-product').innerHTML=found.map(p=>`<option value="${p.id}">${safe(p.description)} · ${safe(p.code)}</option>`).join('');}catch(err){flash(err.message,true);}},300);});
async function activate(idToken){token=idToken;sessionStorage.setItem('facinho_google_token',token);try{me=await api('/api/me');$('login').hidden=true;$('workspace').hidden=false;$('account').textContent=`${me.name||me.email} · ${me.role}`;await loadUnits();await loadProducts();if(me.role!=='ADMINISTRADOR'){document.querySelectorAll('#new-unit,#new-product,#new-promotion,#save-price,#create-register,#save-settings').forEach(el=>el.hidden=true);}}catch(e){sessionStorage.removeItem('facinho_google_token');token='';$('login-error').textContent=e.message;}}
async function boot(){const config=await api('/api/public-config');if(token)await activate(token);const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=()=>{google.accounts.id.initialize({client_id:config.googleClientId,callback:credential=>activate(credential.credential)});google.accounts.id.renderButton($('google-button'),{theme:'outline',size:'large',text:'signin_with',locale:'pt_BR'});};document.head.append(script);}
boot().catch(e=>{$('login-error').textContent=e.message;});
