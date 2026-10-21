(function initializeSparringRevisions(S) {
  const {State,getEl,api,apiGet,showToast}=S;
  let record=null,busy=false,epoch=0,pendingRequest=null;
  const el=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
  const active=()=>State.sparringState==='active'&&['ACTIVE','PAUSED'].includes(State.sparringControl?.state);
  function updateSparringRevisionControls(){
    const panel=getEl('sparring-revisions');if(!panel)return;
    const disabled=busy||State.isLoading||!active()||record?.status!=='AVAILABLE'||record.expectedTurn!==State.currentTurn;
    panel.querySelectorAll('form input,form select,form textarea,form button').forEach(node=>{node.disabled=disabled;});
  }
  function resetSparringRevisions(){epoch++;record=null;pendingRequest=null;busy=false;getEl('sparring-revisions')?.remove();}
  function renderSparringRevisionHistory(value,container){
    if(!container)return;
    const section=el('section');section.className='mt-3 rounded-xl border border-primary-100 p-3';section.append(el('h3','내 생각의 수정 기록'));
    if(value?.status!=='AVAILABLE'){section.append(el('p','수정 기록을 확인할 수 없습니다. 기록이 없다는 뜻은 아닙니다.'));container.append(section);return;}
    if(!value.history.length)section.append(el('p','직접 남긴 수정 기록이 아직 없습니다.'));
    for(const event of value.history){
      const article=el('article');article.className='mt-3 border-t border-gray-200 pt-3';
      article.append(el('h4',`${event.revision}번째 수정 · ${event.priorTurn}번째 답변에서 출발`),el('p',`이전 생각: ${event.priorStatement}`),el('p',`다시 구성한 생각: ${event.revisedStatement}`),el('p',`이유와 인과 관계: ${event.explanation}`),el('p',event.supportId?'저장된 근거 설명을 참고했다고 직접 선택했습니다.':'참고한 저장 설명을 선택하지 않았습니다.'));
      article.append(el('p',event.consumedByTurn===null?'후속 대화에 아직 연결되지 않은 기록입니다. 더 최근 수정이 있으면 그 기록을 사용합니다.':`${event.consumedByTurn}번째 수락된 답변에 연결되었습니다. 이 연결이 수정의 타당성이나 학습 효과를 증명하지는 않습니다.`));
      section.append(article);
    }
    container.append(section);
  }
  function renderSparringRevisions(value){
    const previous=getEl('sparring-revisions'),draft=previous?.querySelector('form')?{
      prior:getEl('sparring-revision-prior')?.value,revised:getEl('sparring-revision-statement')?.value,explanation:getEl('sparring-revision-explanation')?.value,
      support:getEl('sparring-revision-support')?.value,sources:[...previous.querySelectorAll('[data-revision-source]:checked')].map(node=>node.value)
    }:null;
    previous?.remove();record=value?.status==='AVAILABLE'&&Number.isSafeInteger(value.revision)&&Array.isArray(value.history)&&Array.isArray(value.candidates)?value:{status:'UNAVAILABLE'};
    const anchor=getEl('input-bar');if(!anchor)return;
    const panel=el('section');panel.id='sparring-revisions';panel.className='mt-3 rounded-xl border border-primary-100 p-3';anchor.after(panel);
    panel.append(el('h3','내 생각 다시 구성하기'),el('p','이전 주장과 달라진 이유를 직접 기록합니다. 기존 답변과 평가는 유지됩니다. 저장 자체는 점수나 학습 향상으로 계산하지 않으며, 다음 답변에서 두 설명을 비교합니다.'));
    if(record.status!=='AVAILABLE'){
      panel.append(el('p','수정 기록을 현재 확인할 수 없습니다.'));const retry=el('button','수정 기록 다시 확인');retry.type='button';retry.onclick=refreshSparringRevisions;panel.append(retry);return;
    }
    if(record.candidates.length){
      const form=el('form');const prior=el('select');prior.id='sparring-revision-prior';prior.className='rounded-lg border border-gray-200 p-2';
      for(const candidate of record.candidates){const option=el('option',`${candidate.turn}번째 내 답변`);option.value=String(candidate.messageId);prior.append(option);}
      prior.value=draft?.prior||String(record.pending?.priorMessageId||record.candidates.at(-1).messageId);
      const priorLabel=el('label','다시 살펴볼 답변');priorLabel.htmlFor=prior.id;
      const original=el('p'),sources=el('fieldset'),support=el('select'),supportCopy=el('p');support.id='sparring-revision-support';
      const supportLabel=el('label','참고한 저장 설명 (선택)');supportLabel.htmlFor=support.id;
      function populate(){
        const candidate=record.candidates.find(row=>String(row.messageId)===prior.value);original.textContent=candidate?.statement||'';
        sources.replaceChildren(el('legend','내가 사용한 근거 (선택하지 않아도 저장할 수 있습니다)'));
        for(const source of candidate?.sources||[]){const label=el('label'),checkbox=el('input');checkbox.type='checkbox';checkbox.value=source.sourceId;checkbox.dataset.revisionSource='true';label.append(checkbox,document.createTextNode(source.excerpt));sources.append(label);}
        support.replaceChildren();const none=el('option','선택하지 않음');none.value='';support.append(none);
        for(const item of candidate?.support||[]){const option=el('option',item.responseText);option.value=item.id;support.append(option);}
        supportCopy.textContent='';
      }
      prior.onchange=()=>{populate();pendingRequest=null;updateSparringRevisionControls();};populate();
      for(const checkbox of sources.querySelectorAll('input'))checkbox.checked=(draft?.sources||record.pending?.sourceIds||[]).includes(checkbox.value);
      support.value=draft?.support??record.pending?.supportId??'';
      support.onchange=()=>{supportCopy.textContent=record.candidates.find(row=>String(row.messageId)===prior.value)?.support.find(row=>row.id===support.value)?.responseText||'';};support.onchange();
      const revised=el('textarea');revised.id='sparring-revision-statement';revised.maxLength=4000;revised.required=true;revised.className='w-full rounded-lg border border-gray-200 p-2';revised.value=draft?.revised??record.pending?.revisedStatement??'';
      const reason=el('textarea');reason.id='sparring-revision-explanation';reason.maxLength=4000;reason.required=true;reason.className=revised.className;reason.value=draft?.explanation??record.pending?.explanation??'';
      const revisedLabel=el('label','다시 구성한 생각');revisedLabel.htmlFor=revised.id;const reasonLabel=el('label','무엇이 달라졌고, 왜 그런가요?');reasonLabel.htmlFor=reason.id;
      const save=el('button','수정 기록 저장');save.type='submit';save.className='btn-primary mt-3';
      form.append(priorLabel,prior,original,revisedLabel,revised,reasonLabel,reason,sources,supportLabel,support,supportCopy,save);
      form.onsubmit=async event=>{
        event.preventDefault();if(busy||State.isLoading||!active()||record.expectedTurn!==State.currentTurn||!revised.value.trim()||!reason.value.trim())return;
        const sessionId=State.sessionId,version=State.sparringRequestVersion,requestEpoch=epoch;
        const body={priorMessageId:Number(prior.value),revisedStatement:revised.value.trim(),explanation:reason.value.trim(),sourceIds:[...sources.querySelectorAll('input:checked')].map(node=>node.value).sort(),supportId:support.value||null,expectedRevision:record.revision,expectedTurn:record.expectedTurn,controlRevision:State.sparringControl.revision};
        const fingerprint=JSON.stringify({sessionId,priorMessageId:body.priorMessageId,revisedStatement:body.revisedStatement,explanation:body.explanation,sourceIds:body.sourceIds,supportId:body.supportId});if(pendingRequest?.fingerprint!==fingerprint)pendingRequest={fingerprint,key:crypto.randomUUID(),body};
        busy=true;updateSparringRevisionControls();
        try{
          await api(`/api/sessions/${encodeURIComponent(sessionId)}/revisions`,{...pendingRequest.body,mutationKey:pendingRequest.key});
          if(sessionId!==State.sessionId||version!==State.sparringRequestVersion||requestEpoch!==epoch)return;
          pendingRequest=null;await refreshSparringRevisions();showToast('수정 기록을 저장했습니다. 대화는 자동으로 재개되지 않습니다.','success');
        }catch(error){if(sessionId===State.sessionId&&requestEpoch===epoch){if(error?.code==='SPARRING_REVISION_CONFLICT')pendingRequest=null;showToast(error instanceof Error?error.message:'수정 기록을 저장하지 못했습니다.','error');await refreshSparringRevisions();}}
        finally{if(requestEpoch===epoch){busy=false;updateSparringRevisionControls();}}
      };
      panel.append(form);
    }else panel.append(el('p','수락된 내 답변이 생기면 이전 생각과 새 설명을 비교할 수 있습니다.'));
    const history=el('details');history.append(el('summary','수정 기록 보기'));renderSparringRevisionHistory(record,history);panel.append(history);updateSparringRevisionControls();
  }
  async function refreshSparringRevisions(){
    const sessionId=State.sessionId,version=State.sparringRequestVersion,requestEpoch=epoch;if(!sessionId)return;
    try{const value=await apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/revisions`);if(sessionId===State.sessionId&&version===State.sparringRequestVersion&&requestEpoch===epoch)renderSparringRevisions(value);}
    catch{if(sessionId===State.sessionId&&version===State.sparringRequestVersion&&requestEpoch===epoch)renderSparringRevisions(null);}
  }
  Object.assign(S,{renderSparringRevisions,refreshSparringRevisions,resetSparringRevisions,updateSparringRevisionControls,renderSparringRevisionHistory});
  Object.assign(window,{renderSparringRevisions,refreshSparringRevisions,resetSparringRevisions,updateSparringRevisionControls,renderSparringRevisionHistory});
})(window.SocraticAI);
