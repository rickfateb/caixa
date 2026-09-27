const $=id=>document.getElementById(id);
const safe=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const brl=cents=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(cents||0)/100);
const asCents=value=>Math.round(Number(String(value).replace(',','.'))*100);
let token=sessionStorage.getItem('facinho_google_token')||'';
let me=null,units=[],products=[];
const flash=(message,error=false)=>{const el=$('flash');el.textContent=message;el.className='flash'+(error?' error':'');el.hidden=false;setTimeout(()=>el.hidden=true,7000);};
async function api(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
  return data;
}
const send=(url,method,body)=>api(url,{method,body:JSON.stringify(body)});
const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${safe(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${headers.length}">Nenhum registro.</td></tr>`}</tbody></table></div>`;
function selectUnits(){for(const id of ['price-unit','register-unit','settings-unit']){const el=$(id),old=el.value;el.innerHTML=units.filter(u=>u.active).map(u=>`<option value="${u.id}">${safe(u.name)} (${safe(u.acronym)})</option>`).join('');if(units.some(u=>String(u.id)===old))el.value=old;}}
async function loadUnits(){units=await api('/api/admin/units');selectUnits();$('units-list').innerHTML=table(['Sigla','Unidade','ID externo','Status',''],units.map(u=>`<tr><td>${safe(u.acronym)}</td><td>${safe(u.name)}</td><td>${safe(u.external_id)}</td><td>${u.active?'Ativa':'Inativa'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-edit-unit="${u.id}">Editar</button>`:''}</td></tr>`));}
async function loadProducts(){const q=encodeURIComponent($('product-search').value);products=await api(`/api/admin/products?limit=200&q=${q}`);$('products-list').innerHTML=table(['Código','Produto','Categoria','EAN','Status',''],products.map(p=>`<tr><td>${safe(p.code)}</td><td>${safe(p.description)}</td><td>${safe(p.category)}</td><td>${safe((p.barcodes||[]).join(', '))}</td><td>${p.active?'Ativo':'Inativo'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-edit-product="${p.id}">Editar</button>`:''}</td></tr>`));$('price-product').innerHTML=products.map(p=>`<option value="${p.id}">${safe(p.description)}</option>`).join('');}
async function loadPrices(){const unit=$('price-unit').value;if(!unit)return;$('prices-list').innerHTML=table(['Produto','Código','Categoria','Preço','Ativo'],(await api(`/api/admin/unit-products/${unit}`)).map(p=>`<tr><td>${safe(p.description)}</td><td>${safe(p.code)}</td><td>${safe(p.category)}</td><td>${brl(p.sale_price_cents)}</td><td>${p.active?'Sim':'Não'}</td></tr>`));}
async function loadRegisters(){$('registers-list').innerHTML=table(['Unidade','Caixa','Número','Status',''],(await api('/api/admin/registers')).map(r=>`<tr><td>${safe(units.find(u=>u.id===r.unit_id)?.name)}</td><td>${safe(r.name)}</td><td>${safe(r.external_number)}</td><td>${r.active?'Ativo':'Inativo'}</td><td>${me.role==='ADMINISTRADOR'?`<button class="secondary" data-toggle-register="${r.id}" data-active="${r.active}">${r.active?'Desativar':'Ativar'}</button>`:''}</td></tr>`));}
async function loadSettings(){const unit=$('settings-unit').value;if(unit)$('settings-value').value=JSON.stringify((await api(`/api/admin/settings/${unit}`)).settings,null,2);}
async function loadSales(){$('sales-list').innerHTML=table(['Data da venda','Unidade','Caixa','ID da venda','Status','Total'],(await api('/api/admin/sales')).map(s=>`<tr><td>${new Date(s.occurred_at).toLocaleString('pt-BR')}</td><td>${safe(s.unit_name)}</td><td>${safe(s.register_name)}</td><td>${safe(s.client_sale_id)}</td><td>${safe(s.status)}</td><td>${brl(s.total_cents)}</td></tr>`));}
async function choose(tab){document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('selected',b.dataset.tab===tab));document.querySelectorAll('.panel').forEach(p=>p.hidden=p.id!==tab);try{await ({units:loadUnits,products:loadProducts,prices:loadPrices,registers:loadRegisters,settings:loadSettings,sales:loadSales}[tab]||(()=>{}))();}catch(e){flash(e.message,true);}}
function editor(kind,item={}){
  const fields=kind==='unit'?[['name','Nome da unidade'],['acronym','Sigla'],['externalId','ID da unidade no cadastro atual'],['document','Documento']]:[
    ['description','Descrição'],['code','Código do produto'],['externalId','ID no cadastro atual'],['barcodes','Códigos de barras separados por vírgula'],
    ['category','Categoria'],['subcategory','Subcategoria'],['brand','Marca'],['unitOfMeasure','Medida'],['ncm','NCM'],
    ['status','Status'],['itemType','Tipo do item'],['registeredDescription','Descrição registrada'],
    ['purchaseCostCents','Compra (R$)'],['costCents','Custo (R$)']];
  const d=document.createElement('dialog');d.innerHTML=`<h2>${item.id?'Editar':'Novo'} ${kind==='unit'?'unidade':'produto'}</h2><form method="dialog"><div class="grid">${fields.map(([key,label])=>`<label>${safe(label)}<input name="${key}" autocomplete="off"></label>`).join('')}</div><label><input name="active" type="checkbox" style="width:auto" checked> Ativo</label><menu><button type="button" class="secondary" data-close>Cancelar</button><button type="submit">Salvar</button></menu></form>`;
  document.body.append(d);d.querySelector('[data-close]').onclick=()=>d.close();
  for(const [key] of fields){const el=d.querySelector(`[name="${key}"]`);let val=item[key]??item[key.replace(/[A-Z]/g,m=>'_'+m.toLowerCase())]??'';if(key==='barcodes')val=(item.barcodes||[]).join(', ');if(key.endsWith('Cents'))val=val===''?'':Number(val)/100;el.value=val;}
  d.querySelector('[name="active"]').checked=item.active!==false;
  d.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);const body=Object.fromEntries(fields.map(([key])=>[key,String(f.get(key)||'').trim()]));body.active=!!f.get('active');
    if(kind==='product'){body.barcodes=body.barcodes.split(',').map(v=>v.trim()).filter(Boolean);for(const k of ['purchaseCostCents','costCents'])body[k]=body[k]===''?null:asCents(body[k]);}
    try{await send(kind==='unit'?(item.id?`/api/admin/units/${item.id}`:'/api/admin/units'):(item.id?`/api/admin/products/${item.id}`:'/api/admin/products'),item.id?(kind==='unit'?'PATCH':'PUT'):'POST',body);d.close();flash('Cadastro salvo.');await(kind==='unit'?loadUnits():loadProducts());}catch(err){alert(err.message);}});
  d.addEventListener('close',()=>d.remove());d.showModal();
}
document.addEventListener('click',async e=>{const button=e.target.closest('button');if(!button)return;
  try{
    if(button.dataset.tab)await choose(button.dataset.tab);
    if(button.dataset.editUnit)editor('unit',units.find(u=>String(u.id)===button.dataset.editUnit));
    if(button.dataset.editProduct)editor('product',products.find(p=>String(p.id)===button.dataset.editProduct));
    if(button.id==='new-unit')editor('unit');if(button.id==='new-product')editor('product');
    if(button.id==='save-price'){const cents=asCents($('price-value').value);if(!Number.isSafeInteger(cents)||cents<0)throw Error('Preço inválido.');await send(`/api/admin/unit-products/${$('price-unit').value}/${$('price-product').value}`,'PUT',{salePriceCents:cents});flash('Preço salvo.');await loadPrices();}
    if(button.id==='create-register'){const data=await send('/api/admin/registers','POST',{unitId:$('register-unit').value,name:$('register-name').value,externalNumber:$('register-number').value});$('token-result').hidden=false;$('token-result').innerHTML=`Guarde agora o token do caixa <strong>${safe(data.name)}</strong>. Ele só será exibido desta vez.<code>${safe(data.token)}</code>`;await loadRegisters();}
    if(button.dataset.toggleRegister){await send(`/api/admin/registers/${button.dataset.toggleRegister}`,'PATCH',{active:button.dataset.active!=='true'});await loadRegisters();}
    if(button.id==='save-settings'){let settings;try{settings=JSON.parse($('settings-value').value);}catch{throw Error('JSON inválido.');}await send(`/api/admin/settings/${$('settings-unit').value}`,'PUT',{settings});flash('Configurações salvas.');}
    if(button.id==='refresh-sales')await loadSales();
  }catch(err){flash(err.message,true);}
});
for(const [id,fn] of [['price-unit',loadPrices],['settings-unit',loadSettings]])$(id).addEventListener('change',()=>fn().catch(err=>flash(err.message,true)));
let searchTimer;$('product-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadProducts().catch(err=>flash(err.message,true)),300);});
async function activate(idToken){token=idToken;sessionStorage.setItem('facinho_google_token',token);try{me=await api('/api/me');$('login').hidden=true;$('workspace').hidden=false;$('account').textContent=`${me.name||me.email} · ${me.role}`;await loadUnits();await loadProducts();if(me.role!=='ADMINISTRADOR'){document.querySelectorAll('#new-unit,#new-product,#save-price,#create-register,#save-settings').forEach(el=>el.hidden=true);}}catch(e){sessionStorage.removeItem('facinho_google_token');token='';$('login-error').textContent=e.message;}}
async function boot(){const config=await api('/api/public-config');if(token)await activate(token);const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=()=>{google.accounts.id.initialize({client_id:config.googleClientId,callback:credential=>activate(credential.credential)});google.accounts.id.renderButton($('google-button'),{theme:'outline',size:'large',text:'signin_with',locale:'pt_BR'});};document.head.append(script);}
boot().catch(e=>{$('login-error').textContent=e.message;});
