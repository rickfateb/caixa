async function loadFiscal() {
  const [issuers,documents,policy]=await Promise.all([api('/api/admin/fiscal/issuers'),api('/api/admin/fiscal/documents'),
    api('/api/admin/fiscal/environments')]);
  fiscalEnvironmentState=policy;fiscalPolicyDirty=false;renderFiscalEnvironments();
  $('fiscal-issuers').innerHTML=`<h3>Emitentes por loja</h3>${me.role==='ADMINISTRADOR'?'<button id="new-fiscal-issuer">Cadastrar emitente de teste</button>':''}` +
    table(['Loja','CNPJ','Série','Próximo número','Situação',''],issuers.map(i=>`<tr><td>${safe(i.unit_name)}</td><td>${safe(i.cnpj)}</td><td>${i.series}</td><td>${i.next_number}</td><td>${i.enabled?'Ativo em homologação':'Desativado'}</td><td>${me.role==='ADMINISTRADOR'?`<button data-fiscal-profile="${i.id}" class="secondary">Classificar produto</button> <button data-fiscal-toggle="${i.id}" data-enabled="${!i.enabled}" class="secondary">${i.enabled?'Desativar':'Ativar testes'}</button>`:''}</td></tr>`));
  const labels={DISABLED:'Emissor desativado',BLOCKED:'Emissão bloqueada',PENDING:'Na fila',SIGNED:'Assinada',SUBMITTING:'Enviando',UNKNOWN:'Consultando SEFAZ',AUTHORIZED:'Autorizada em teste',REJECTED:'Rejeitada',MANUAL:'Revisar'};
  const issues={NCM_REQUIRED:'Classificação fiscal do produto pendente.',PRODUCT_FISCAL_MAPPING_REQUIRED:'Produto sem vínculo fiscal.',
    OFFLINE_FISCAL_FLOW_REQUIRED:'Venda fora do prazo de emissão normal; revisar a operação offline.',
    FISCAL_RUNTIME_NOT_CONFIGURED:'Certificado e emissor de teste aguardam configuração.',
    DANFE_GENERATION_PENDING:'Cupom autorizado em teste; PDF pendente.',RTC_PROFILE_REQUIRED_FOR_2027:'Regras fiscais de 2027 aguardam atualização.',
    PRODUCTION_NOT_READY:'Ambiente oficial escolhido; emissão real aguarda validação.',
    FISCAL_ENVIRONMENT_CHANGED:'O ambiente mudou antes do recebimento. Revisar o teste; nenhum cupom foi emitido.',
    INVALID_FISCAL_ENVIRONMENT:'O caixa informou um ambiente fiscal inválido.'};
  $('fiscal-documents').innerHTML=table(['Loja','Venda','Ambiente escolhido','Série / número','Situação','Retorno','Arquivos'],documents.map(d=>`<tr><td>${safe(d.unitName)}</td><td>${safe(d.saleId)}</td><td>${d.requestedEnvironment===1?'Oficial':'Homologação'}</td><td>${safe(d.series||'—')} / ${safe(d.number||'Pendente')}</td><td>${safe(labels[d.status]||d.status)}</td><td>${safe(d.message||issues[d.issue]||d.issue||'')}</td><td>${d.status==='AUTHORIZED'?`<button class="secondary" data-fiscal-file="${d.id}" data-type="xml">XML</button> ${d.danfeAvailable?`<button class="secondary" data-fiscal-file="${d.id}" data-type="pdf">Cupom PDF</button>`:''}`:''}</td></tr>`));
  $('new-fiscal-issuer')?.addEventListener('click',()=>fiscalIssuerEditor());
  $('fiscal-issuers').onclick=async event=>{
    const toggle=event.target.closest('[data-fiscal-toggle]'),profile=event.target.closest('[data-fiscal-profile]');
    try {
      if(toggle){await send(`/api/admin/fiscal/issuers/${toggle.dataset.fiscalToggle}`,'PATCH',{enabled:toggle.dataset.enabled==='true'});await loadFiscal();}
      if(profile) await fiscalProfileEditor(profile.dataset.fiscalProfile);
    } catch(error){flash(error.message,true);}
  };
  $('fiscal-documents').onclick=async event=>{
    const button=event.target.closest('[data-fiscal-file]');if(!button)return;
    try {
      const response=await fetch(`/api/admin/fiscal/documents/${button.dataset.fiscalFile}/${button.dataset.type}`,
        {headers:{Authorization:`Bearer ${token}`}});
      if(!response.ok)throw Error('Arquivo fiscal ainda indisponível.');
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
      link.href=url;link.download=`nfce-homologacao-${button.dataset.fiscalFile}.${button.dataset.type}`;
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error){flash(error.message,true);}
  };
}

function fiscalDialog(title,fields,onSave,{afterSave,submitLabel='Salvar'}={}) {
  const dialog=document.createElement('dialog');
  dialog.className='fiscal-dialog';
  dialog.innerHTML=`<h2>${safe(title)}</h2><form><div class="grid">${fields}</div><p data-error class="error" role="alert"></p><menu><button type="button" class="secondary" data-close>Cancelar</button><button type="submit">${safe(submitLabel)}</button></menu></form>`;
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const button=dialog.querySelector('[type="submit"]');button.disabled=true;
    try {await onSave(new FormData(event.target));dialog.close();if(afterSave)await afterSave();
      else {await loadFiscal();flash('Cadastro fiscal salvo para homologação.');}}
    catch(error){dialog.querySelector('[data-error]').textContent=fiscalPolicyMessage(error.message);}
    finally{button.disabled=false;}
  };
  dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
}
const fiscalInput=(name,label,type='text')=>`<label>${safe(label)}<input name="${name}" type="${type}" required></label>`;
function fiscalIssuerEditor() {
  const fields=`<label>Loja<select name="unitId" required>${units.filter(u=>u.active).map(u=>`<option value="${u.id}">${safe(u.name)}</option>`).join('')}</select></label>` +
    [['cnpj','CNPJ (somente números)'],['ie','Inscrição estadual'],['name','Razão social'],['tradeName','Nome fantasia'],
      ['street','Logradouro'],['number','Número'],['district','Bairro'],['city','Município'],['cityCode','Código IBGE do município'],
      ['zipCode','CEP (somente números)'],['series','Série de teste'],['nextNumber','Próximo número de teste'],
      ['credentialsRef','Identificador da configuração do certificado'],['establishmentEvidence','Referência da conferência do estabelecimento']]
      .map(([name,label])=>fiscalInput(name,label,['series','nextNumber'].includes(name)?'number':'text')).join('');
  fiscalDialog('Emitente NFC-e de teste em São Paulo',fields,data=>{
    const config=Object.fromEntries(data);delete config.unitId;
    Object.assign(config,{uf:'SP',crt:1,environment:2,enabled:false,series:Number(config.series),nextNumber:Number(config.nextNumber)});
    return send('/api/admin/fiscal/issuers','POST',{unitId:data.get('unitId'),config});
  });
}
async function fiscalProfileEditor(issuerId) {
  const rows=await api('/api/admin/products?limit=200');
  const fields=`<label>Produto<select name="productId" required>${rows.map(p=>`<option value="${p.id}">${safe(p.description)}</option>`).join('')}</select></label>` +
    [['ncm','NCM (8 dígitos)'],['cest','CEST (7 dígitos, se aplicável)'],['origin','Origem fiscal (0 a 8)'],
      ['cfop','CFOP'],['csosn','CSOSN'],['pisCst','CST do PIS'],['cofinsCst','CST da Cofins'],['unit','Unidade fiscal'],
      ['gtin','GTIN confirmado ou SEM GTIN'],['approxTaxBps','Tributos aproximados (25,34% = 2534)'],
      ['approxTaxSource','Fonte e versão dos tributos aproximados'],['classificationEvidence','Referência da classificação contábil']]
      .map(([name,label])=>name==='cest'?`<label>${safe(label)}<input name="cest"></label>`:
        fiscalInput(name,label,['origin','approxTaxBps'].includes(name)?'number':'text')).join('');
  fiscalDialog('Classificação de mercadoria em 2026',fields,data=>{
    const profile=Object.fromEntries(data),productId=profile.productId;delete profile.productId;
    Object.assign(profile,{origin:Number(profile.origin),approxTaxBps:Number(profile.approxTaxBps),taxYear:2026});
    return send(`/api/admin/fiscal/issuers/${issuerId}/products/${productId}`,'PUT',profile);
  });
}
document.getElementById('refresh-fiscal').onclick=()=>loadFiscal().catch(error=>flash(error.message,true));
