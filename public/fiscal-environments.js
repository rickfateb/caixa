let fiscalEnvironmentState=null,fiscalPolicyDirty=false;
const fiscalWeekdays=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const fiscalEnvironmentLabel=value=>({0:'Desabilitado',1:'Oficial',2:'Homologação'})[value]||'Não configurado';
const fiscalEnvironmentOptions=(value,inherit=false)=>
  (inherit?`<option value="" ${value==null?'selected':''}>Padrão do serviço</option>`:'')+
  [1,2,0].map(v=>`<option value="${v}" ${value===v?'selected':''}>${fiscalEnvironmentLabel(v)}</option>`).join('');
function fiscalPolicyMessage(code) {
  return ({FISCAL_SCHEDULE_OVERLAP:'Há agendas sobrepostas para os mesmos caixas. Ajuste os dias, horários ou destinos.',
    FISCAL_POLICY_CHANGED:'Outro administrador alterou a configuração. Atualize a aba antes de salvar novamente.',
    INVALID_FISCAL_SCHEDULE_DATE_RANGE:'A data final deve ser igual ou posterior à inicial.',
    FISCAL_SCHEDULE_EMPTY_WINDOW:'Informe horários de início e fim diferentes.',
    INVALID_FISCAL_SCHEDULE_DAYS:'Selecione ao menos um dia da semana.',
    FISCAL_SCHEDULE_NO_OCCURRENCE:'A vigência escolhida não contém nenhum dos dias da semana selecionados.',
    FISCAL_REGISTER_NOT_FOUND:'Um dos caixas selecionados não está mais cadastrado.',
    INVALID_FISCAL_SCHEDULE_TIME:'Informe horários válidos.',
    INVALID_FISCAL_POLICY_TIME:'Informe uma data e um horário válidos.'})[code]||code;
}
function fiscalDirty() {fiscalPolicyDirty=true;renderFiscalEnvironments();}
function renderFiscalEnvironments() {
  const data=fiscalEnvironmentState;if(!data)return;
  const config=data.config,isAdmin=me.role==='ADMINISTRADOR';
  const sources={SERVICE_DEFAULT:'Padrão do serviço',REGISTER_DEFAULT:'Padrão do caixa',SCHEDULE:'Agenda',EXISTING_DOCUMENT:'Documento anterior'};
  $('fiscal-environments').innerHTML=`<div class="heading"><div><h3>Ambientes e agendas</h3><p>Oficial, Homologação ou Desabilitado por maquininha/PDV. Horários de Brasília.</p></div>${isAdmin?'<button id="fiscal-save-policy" '+(!fiscalPolicyDirty?'disabled':'')+'>Salvar ambientes e agendas</button>':''}</div>
    <p class="info">Desabilitado recebe as vendas sem gerar cupons automaticamente. Abra a venda para gerar manualmente e escolher o ambiente. Homologação gera cupons de teste sem valor fiscal. Oficial aguarda validação para emissão real.</p>
    <p class="fiscal-dirty" role="status">${fiscalPolicyDirty?'Há alterações ainda não salvas. A prévia abaixo mostra a configuração salva.':'Configuração salva.'}</p>
    <div class="row"><label>Ambiente padrão do serviço<select id="fiscal-service-environment" ${!isAdmin?'disabled':''}>${fiscalEnvironmentOptions(config.defaultEnvironment)}</select></label>
    <label>Consultar ambiente em Brasília<input id="fiscal-preview-time" type="datetime-local"></label><button id="fiscal-preview" class="secondary">Ver prévia</button></div>
    <p>Prévia: ${safe(new Date(data.previewAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}))}. A prévia não altera o serviço.</p>`+
    table(['Loja','Maquininha / PDV','Ambiente padrão','Ambiente na prévia','Regra aplicada'],data.registers.map(r=>`<tr><td>${safe(r.unit_name)}</td><td>${safe(r.name)}${r.external_number?'<br>'+safe(r.external_number):''}${!r.active?'<br>Inativo':''}</td>
      <td><select aria-label="Ambiente de ${safe(r.name)}" data-fiscal-register="${r.id}" ${!isAdmin?'disabled':''}>${fiscalEnvironmentOptions(config.registerEnvironments[String(r.id)]??null,true)}</select></td>
      <td><span class="fiscal-badge ${{0:'disabled',1:'official',2:'homologation'}[r.effective.environment]}">${fiscalEnvironmentLabel(r.effective.environment)}${r.effective.environment===1?' · pendente':''}</span></td>
      <td>${safe(r.effective.scheduleName||sources[r.effective.source])}</td></tr>`))+
    `<div class="heading fiscal-agenda-heading"><div><h3>Agendas de ambiente</h3><p>Uma agenda para caixas selecionados prevalece sobre uma agenda para todos. Fora das janelas, vale o padrão de cada caixa.</p></div>${isAdmin?'<button id="fiscal-new-schedule" class="secondary">Nova agenda</button>':''}</div>`+
    table(['Agenda','Dias / horário','Vigência','Destino','Ambiente',''],config.schedules.map(s=>`<tr><td>${safe(s.name)}<br>${s.enabled?'Ativa':'Desativada'}</td><td>${s.weekdays.map(d=>fiscalWeekdays[d]).join(', ')}<br>${s.allDay?'Dia todo':safe(s.startTime)+' às '+safe(s.endTime)+(s.endTime<s.startTime?' (dia seguinte)':'')}</td>
      <td>${safe(s.startsOn||'Sem início')}<br>${safe(s.endsOn||'Sem término')}</td><td>${s.registerIds.length?s.registerIds.map(id=>safe(data.registers.find(r=>String(r.id)===id)?.name||id)).join(', '):'Todos os PDVs'}</td><td>${fiscalEnvironmentLabel(s.environment)}</td>
      <td>${isAdmin?`<button class="secondary" data-fiscal-edit-schedule="${safe(s.id)}">Editar</button> <button class="secondary" data-fiscal-remove-schedule="${safe(s.id)}">Remover</button>`:''}</td></tr>`));
  $('fiscal-service-environment').onchange=event=>{config.defaultEnvironment=Number(event.target.value);fiscalDirty();};
  $('fiscal-save-policy')?.addEventListener('click',async event=>{
    event.target.disabled=true;
    try {await send('/api/admin/fiscal/environments','PUT',{revision:data.revision,config});await loadFiscal();flash('Ambientes e agendas salvos.');}
    catch(error){flash(fiscalPolicyMessage(error.message),true);event.target.disabled=false;}
  });
  $('fiscal-new-schedule')?.addEventListener('click',()=>fiscalScheduleEditor());
  $('fiscal-preview').onclick=async()=>{
    if(fiscalPolicyDirty){flash('Salve ambientes e agendas antes de consultar a prévia.',true);return;}
    const value=$('fiscal-preview-time').value;
    try {
      const suffix=value?'?at='+encodeURIComponent(new Date(value+'-03:00').toISOString()):'';
      fiscalEnvironmentState=await api('/api/admin/fiscal/environments'+suffix);renderFiscalEnvironments();
    } catch(error){flash(fiscalPolicyMessage(error.message),true);}
  };
}
$('fiscal-environments').onchange=event=>{
  const input=event.target.closest('[data-fiscal-register]');if(!input || me.role!=='ADMINISTRADOR')return;
  const map=fiscalEnvironmentState.config.registerEnvironments;
  if(input.value==='')delete map[input.dataset.fiscalRegister];else map[input.dataset.fiscalRegister]=Number(input.value);
  fiscalDirty();
};
$('fiscal-environments').onclick=event=>{
  if(me?.role!=='ADMINISTRADOR')return;
  const edit=event.target.closest('[data-fiscal-edit-schedule]'),remove=event.target.closest('[data-fiscal-remove-schedule]');
  if(edit)fiscalScheduleEditor(fiscalEnvironmentState.config.schedules.find(s=>s.id===edit.dataset.fiscalEditSchedule));
  if(remove){fiscalEnvironmentState.config.schedules=fiscalEnvironmentState.config.schedules.filter(s=>s.id!==remove.dataset.fiscalRemoveSchedule);fiscalDirty();}
};
function fiscalScheduleEditor(existing) {
  const s=existing||{id:crypto.randomUUID(),name:'',enabled:true,environment:2,weekdays:[1,2,3,4,5],
    startTime:'08:00',endTime:'10:00',allDay:false,startsOn:null,endsOn:null,registerIds:[]};
  const fields=`<label>Nome da agenda<input name="name" value="${safe(s.name)}" maxlength="100" required></label>
    <label>Ambiente nesta janela<select name="environment">${fiscalEnvironmentOptions(s.environment)}</select></label>
    <label class="fiscal-check fiscal-full-width"><input name="allDay" type="checkbox" data-fiscal-all-day ${s.allDay?'checked':''}>Dia todo</label>
    <label>Horário inicial<input name="startTime" type="time" value="${safe(s.startTime)}" ${s.allDay?'disabled':''} required></label>
    <label>Horário final<input name="endTime" type="time" value="${safe(s.endTime)}" ${s.allDay?'disabled':''} required></label>
    <label>Data inicial (opcional)<input name="startsOn" type="date" value="${safe(s.startsOn)}"></label>
    <label>Última data de início (opcional)<input name="endsOn" type="date" value="${safe(s.endsOn)}"></label>
    <fieldset class="fiscal-full-width"><legend>Dias da semana</legend><div class="fiscal-checks">${fiscalWeekdays.map((day,i)=>`<label><input name="weekdays" type="checkbox" value="${i}" ${s.weekdays.includes(i)?'checked':''}>${day}</label>`).join('')}</div></fieldset>
    <label>Destinos<select name="scope" data-fiscal-scope><option value="ALL" ${!s.registerIds.length?'selected':''}>Todos os PDVs</option><option value="SELECTED" ${s.registerIds.length?'selected':''}>Escolher PDVs</option></select></label>
    <label class="fiscal-check"><input name="enabled" type="checkbox" ${s.enabled?'checked':''}>Agenda ativa</label>
    <fieldset class="fiscal-full-width" data-fiscal-targets ${!s.registerIds.length?'hidden':''}><legend>Maquininhas / PDVs</legend><div class="fiscal-checks">${fiscalEnvironmentState.registers.map(r=>`<label><input type="checkbox" name="registerIds" value="${r.id}" ${s.registerIds.includes(String(r.id))?'checked':''}>${safe(r.unit_name)} · ${safe(r.name)}</label>`).join('')}</div></fieldset>
    <p class="info fiscal-full-width">O início está incluído e o horário final encerra a janela. Se o fim for anterior ao início, a agenda termina no dia seguinte. Os dias e as datas indicam o início da janela.</p>`;
  fiscalDialog(existing?'Editar agenda fiscal':'Nova agenda fiscal',fields,data=>{
    const registerIds=data.get('scope')==='ALL'?[]:data.getAll('registerIds');
    if(data.get('scope')==='SELECTED' && !registerIds.length)throw Error('Escolha pelo menos uma maquininha/PDV.');
    const weekdays=data.getAll('weekdays').map(Number);
    if(!weekdays.length)throw Error('INVALID_FISCAL_SCHEDULE_DAYS');
    const next={id:s.id,name:data.get('name'),enabled:data.has('enabled'),environment:Number(data.get('environment')),
      weekdays,allDay:data.has('allDay'),startTime:data.has('allDay')?'00:00':data.get('startTime'),
      endTime:data.has('allDay')?'00:00':data.get('endTime'),startsOn:data.get('startsOn')||null,
      endsOn:data.get('endsOn')||null,registerIds};
    const schedules=fiscalEnvironmentState.config.schedules,index=schedules.findIndex(rule=>rule.id===s.id);
    if(index<0)schedules.push(next);else schedules[index]=next;
    fiscalPolicyDirty=true;
  },{submitLabel:'Preparar agenda',afterSave:()=>{renderFiscalEnvironments();flash('Agenda preparada. Clique em Salvar ambientes e agendas para aplicar.');}});
  const dialog=document.querySelector('dialog:last-of-type');
  dialog.querySelector('[data-fiscal-scope]').onchange=event=>dialog.querySelector('[data-fiscal-targets]').hidden=event.target.value==='ALL';
  dialog.querySelector('[data-fiscal-all-day]').onchange=event=>{
    for(const name of ['startTime','endTime'])dialog.querySelector(`[name="${name}"]`).disabled=event.target.checked;
  };
}
