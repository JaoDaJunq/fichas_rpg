(() => {
  'use strict';

  const STORE = 'oito-marcas-personagens-v1';
  const app = document.querySelector('#app');
  const ATTRIBUTES = ['Agilidade', 'Força', 'Intelecto', 'Presença', 'Vigor'];
  const SKILLS = [
    ['Acrobacia', 'Corpo'], ['Adestramento', 'Social'], ['Artes', 'Conhecimento'], ['Atletismo', 'Corpo'],
    ['Erudição', 'Conhecimento'], ['Ladinagem', 'Corpo'], ['Diplomacia', 'Social'], ['Enganação', 'Social'],
    ['Fortitude', 'Corpo'], ['Furtividade', 'Corpo'], ['Intimidação', 'Social'], ['Intuição', 'Social'],
    ['Investigação', 'Conhecimento'], ['Luta', 'Combate'], ['Medicina', 'Conhecimento'], ['Arcana', 'Conhecimento'],
    ['Percepção', 'Conhecimento'], ['Montaria / Condução', 'Corpo'], ['Pontaria', 'Combate'], ['Ofício', 'Conhecimento'],
    ['Manobras', 'Combate'], ['Ritos e Tradições', 'Conhecimento'], ['Sobrevivência', 'Conhecimento'],
    ['Tática', 'Conhecimento'], ['Vontade', 'Social'], ['Canalização', 'Sobrenatural'], ['Liderança', 'Social']
  ];
  const STEPS = ['Identidade', 'Origem', 'Vocação', 'Atributos e perícias', 'Revisão'];
  const blank = () => ({
    id: crypto.randomUUID?.() || `char-${Date.now()}`,
    name: '', player: '', age: '', pronouns: '', kingdom: '', origin: '', socialClass: '',
    motivation: '', bond: '', flaw: '', className: '', classNotes: '', appearance: '',
    lotus: 'A marca surgiu sem explicação', attributes: Object.fromEntries(ATTRIBUTES.map(a => [a, 1])),
    trainedSkills: [], skillAttributes: {}, powers: '', equipment: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  let characters = readCharacters();
  let view = { page: 'home', characterId: null, step: 0, draft: null };

  function readCharacters() {
    try { const parsed = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  function persist() { localStorage.setItem(STORE, JSON.stringify(characters)); }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function initials(name) { return esc((name || '??').trim().split(/\s+/).slice(0,2).map(x=>x[0] || '').join('').toUpperCase()); }
  function pageShell(content, back = '') {
    return `<div class="om-shell"><header class="om-top"><button class="om-brand" data-action="home"><span class="om-lotus">✿</span><span>OITO MARCAS<small>FICHAS DE PERSONAGEM</small></span></button><div class="om-top-right">${back}<span class="om-local"><i></i> SALVO NESTE DISPOSITIVO</span></div></header>${content}<footer class="om-footer">RPG DAS OITO MARCAS <span>·</span> FICHAS PRESENCIAIS</footer></div>`;
  }
  function renderHome() {
    view.page = 'home';
    const cards = characters.map(c => `<article class="om-char-card"><div class="om-card-art"><div class="om-avatar">${initials(c.name)}</div><span class="om-mark">✿</span><span class="om-card-id">MARCADO · ${esc(c.kingdom || 'REINO DESCONHECIDO')}</span></div><div class="om-card-body"><div class="om-kicker">${esc(c.className || 'Vocação em aberto')} · ${esc(c.socialClass || 'Origem não definida')}</div><h2>${esc(c.name || 'Sem nome')}</h2><p>${esc(c.origin || c.motivation || 'A história ainda está sendo escrita.')}</p><div class="om-card-meta"><span>${esc(c.player || 'Jogador')}</span><span>${esc(c.updatedAt ? new Date(c.updatedAt).toLocaleDateString('pt-BR') : '')}</span></div><div class="om-card-actions"><button class="om-button om-primary" data-action="open" data-id="${esc(c.id)}">Acessar ficha <b>↗</b></button><button class="om-icon-button" title="Editar personagem" data-action="edit" data-id="${esc(c.id)}">✎</button><button class="om-icon-button" title="Exportar ficha" data-action="export" data-id="${esc(c.id)}">⇩</button></div></div></article>`).join('');
    app.innerHTML = pageShell(`<main class="om-main"><section class="om-heading"><div><div class="om-eyebrow">COMPÊNDIO DOS ESCOLHIDOS <span>✧</span></div><h1>Personagens</h1><p>Crie e consulte as histórias daqueles que carregam o sinal da lótus.</p></div><button class="om-button om-primary om-create" data-action="new">＋ Criar personagem</button></section>${characters.length ? `<section class="om-grid">${cards}<button class="om-add-card" data-action="new"><span>＋</span><strong>Uma nova história</strong><small>Criar personagem</small></button></section>` : `<section class="om-empty"><div class="om-empty-lotus">✿</div><div class="om-eyebrow">A PROFECIA COMEÇA A SE CUMPRIR</div><h2>Ainda não há personagens</h2><p>Crie a primeira ficha. Ela ficará salva neste navegador e poderá ser aberta antes da sessão presencial.</p><button class="om-button om-primary" data-action="new">＋ Criar primeiro personagem</button></section>`}</main>`);
  }
  function field(label, key, value, placeholder = '', type = 'text', wide = false) {
    return `<label class="om-field ${wide ? 'wide' : ''}"><span>${label}</span><input type="${type}" name="${key}" data-field="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`;
  }
  function area(label, key, value, placeholder = '', wide = false) {
    return `<label class="om-field ${wide ? 'wide' : ''}"><span>${label}</span><textarea name="${key}" data-field="${key}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
  }
  function stepIdentity(d) {
    return `<div class="om-step-intro"><div class="om-eyebrow">ETAPA 01 · QUEM É ESSA PESSOA?</div><h2>Comece pela identidade</h2><p>O lótus pode surgir em qualquer pessoa, de qualquer reino ou posição.</p></div><div class="om-form-grid">${field('Nome do personagem *','name',d.name,'Como é chamado?')}${field('Nome do jogador','player',d.player,'Quem vai interpretar?')}${field('Idade','age',d.age,'Ex.: 24','text')}${field('Pronomes','pronouns',d.pronouns,'Opcional')}${area('Aparência','appearance',d.appearance,'Traços, roupas, marcas ou detalhes que chamam atenção.',true)}</div>`;
  }
  function stepOrigin(d) {
    return `<div class="om-step-intro"><div class="om-eyebrow">ETAPA 02 · DE ONDE VEIO?</div><h2>O mundo deixou marcas</h2><p>Reino, origem e posição social ajudam a definir o que essa pessoa traz para o grupo.</p></div><div class="om-form-grid">${field('Reino','kingdom',d.kingdom,'Nome do reino')}${field('Origem / comunidade','origin',d.origin,'Vila, cidade, povo ou família')}${field('Classe social','socialClass',d.socialClass,'Nobreza, povo, clero…')}${field('Motivação para partir','motivation',d.motivation,'Dever, ambição, medo, curiosidade…', 'text', true)}${field('Vínculo importante','bond',d.bond,'Alguém ou algo que ficou para trás')}${field('Fraqueza ou conflito','flaw',d.flaw,'O que pode colocá-lo em risco?') }<div class="om-note wide"><span>✿</span><p><strong>A marca não prova quem é o infiltrado.</strong> O símbolo aparece sem seguir linhagem. A identidade do impostor será decidida em segredo pelo mestre durante a preparação da sessão.</p></div></div>`;
  }
  function stepVocation(d) {
    return `<div class="om-step-intro"><div class="om-eyebrow">ETAPA 03 · COMO ENFRENTA O DESTINO?</div><h2>Defina sua vocação</h2><p>As classes e poderes ainda estão sendo criados. Registre sua ideia agora e refine com o mestre.</p></div><div class="om-form-grid">${field('Classe / vocação','className',d.className,'Ex.: guardião, oráculo, duelista…')}${field('Como aprendeu a lutar ou agir?','classNotes',d.classNotes,'Treino, dom, tradição, sobrevivência…')}${area('Poderes e habilidades','powers',d.powers,'Descreva poderes já definidos ou ideias para discutir com o mestre.',true)}${area('Equipamentos importantes','equipment',d.equipment,'Armas, relíquias, ferramentas ou itens pessoais.',true)}<div class="om-note wide"><span>✧</span><p>Escreva livremente: esta ficha não inventa classes nem limitações antes de fecharmos as regras do sistema.</p></div></div>`;
  }
  function stepTraits(d) {
    const attrs = ATTRIBUTES.map(a => `<label class="om-attribute"><span>${a}</span><div class="om-dice-control"><button type="button" data-action="attr" data-attr="${a}" data-delta="-1">−</button><strong>${Number(d.attributes[a] || 1)}</strong><button type="button" data-action="attr" data-attr="${a}" data-delta="1">＋</button></div><small>d20</small></label>`).join('');
    const trained = new Set(d.trainedSkills || []);
    const skills = SKILLS.map(([name, group]) => `<label class="om-skill ${trained.has(name) ? 'chosen' : ''}"><input type="checkbox" data-skill="${esc(name)}" ${trained.has(name) ? 'checked' : ''}><span class="om-skill-check">${trained.has(name) ? '✓' : ''}</span><span class="om-skill-name">${esc(name)}</span><small>${group}</small></label>`).join('');
    const total = ATTRIBUTES.reduce((sum,a)=>sum+Number(d.attributes[a]||0),0);
    return `<div class="om-step-intro"><div class="om-eyebrow">ETAPA 04 · O QUE SABE FAZER?</div><h2>Atributos e perícias</h2><p>O valor do atributo define quantos d20 você rola em ações ligadas a ele. A distribuição final ainda será calibrada com o mestre.</p></div><div class="om-attributes">${attrs}<div class="om-attribute-total"><small>DADOS DISTRIBUÍDOS</small><strong>${total}</strong></div></div><div class="om-rules-hint">Cada atributo está entre 1 e 5 por enquanto. Não existe limite de pontos nesta versão: os valores ficam editáveis até fecharmos a criação de personagem.</div><div class="om-skills-head"><div><div class="om-eyebrow">PERÍCIAS</div><h3>Marque seus domínios</h3></div><span>${trained.size} selecionadas</span></div><div class="om-skills-grid">${skills}</div><div class="om-note"><span>i</span><p>As perícias são uma seleção inicial adaptada para este cenário. Marcar domínio registra sua especialidade; bônus e associações finais serão definidos nas regras.</p></div>`;
  }
  function stepReview(d) {
    const selected = (d.trainedSkills || []).map(name=>`<span class="om-tag">${esc(name)}</span>`).join('') || '<span class="om-muted">Nenhuma marcada</span>';
    return `<div class="om-step-intro"><div class="om-eyebrow">ETAPA 05 · CONFIRA ANTES DE SALVAR</div><h2>A lótus floresce</h2><p>Revise o conceito. Você poderá editar a ficha depois.</p></div><div class="om-review"><div class="om-review-hero"><div class="om-avatar">${initials(d.name)}</div><div><div class="om-eyebrow">${esc(d.kingdom || 'Reino ainda não definido')} · ${esc(d.socialClass || 'Origem livre')}</div><h3>${esc(d.name || 'Personagem sem nome')}</h3><p>${esc(d.className || 'Vocação em aberto')} · Jogador: ${esc(d.player || 'não informado')}</p></div></div><div class="om-review-grid"><section><small>HISTÓRIA</small><p><b>Origem:</b> ${esc(d.origin || '—')}</p><p><b>Motivação:</b> ${esc(d.motivation || '—')}</p><p><b>Vínculo:</b> ${esc(d.bond || '—')}</p></section><section><small>ATRIBUTOS</small><div class="om-review-attrs">${ATTRIBUTES.map(a=>`<span>${a}<b>${Number(d.attributes[a]||1)}d20</b></span>`).join('')}</div></section><section class="wide"><small>PERÍCIAS COM DOMÍNIO</small><div class="om-tags">${selected}</div></section><section class="wide"><small>PODERES E HABILIDADES</small><p>${esc(d.powers || 'A definir com o mestre.')}</p></section></div></div><div class="om-note"><span>▣</span><p>Esta ficha será armazenada somente neste navegador. Para levar para outra pessoa ou dispositivo, exporte o JSON depois de salvar.</p></div>`;
  }
  function renderWizard() {
    view.page = 'wizard';
    const d = view.draft || blank();
    const body = [stepIdentity,stepOrigin,stepVocation,stepTraits,stepReview][view.step](d);
    const steps = STEPS.map((s,i)=>`<button class="om-step ${i===view.step?'active':''} ${i<view.step?'done':''}" data-action="step" data-step="${i}"><span>${i<view.step?'✓':String(i+1).padStart(2,'0')}</span>${s}</button>`).join('');
    app.innerHTML = pageShell(`<main class="om-main om-create-main"><div class="om-wizard-top"><button class="om-back" data-action="home">← Voltar para personagens</button><span>CRIADOR DE PERSONAGEM</span></div><nav class="om-stepper">${steps}</nav><section class="om-wizard-card">${body}<div class="om-wizard-actions"><button class="om-button om-secondary" data-action="prev" ${view.step===0?'disabled':''}>← Voltar</button><span>ETAPA ${String(view.step+1).padStart(2,'0')} DE 05</span>${view.step<4?'<button class="om-button om-primary" data-action="next">Continuar →</button>':'<button class="om-button om-primary" data-action="save">Salvar personagem ✿</button>'}</div></section></main>`, '<button class="om-text-action" data-action="home">Sair</button>');
  }
  function renderSheet(id) {
    view.page = 'sheet'; view.characterId = id;
    const c = characters.find(x=>x.id===id); if (!c) return renderHome();
    const skills = (c.trainedSkills||[]).map(s=>`<div class="om-sheet-skill"><span>${esc(s)}</span><small>${esc(c.skillAttributes?.[s] ? `${c.skillAttributes[s]} · ${c.attributes?.[c.skillAttributes[s]]||1}d20` : 'Atributo a definir')}</small></div>`).join('') || '<p class="om-muted">Nenhuma perícia marcada ainda.</p>';
    app.innerHTML = pageShell(`<main class="om-main"><div class="om-sheet-actions"><button class="om-back" data-action="home">← Personagens</button><div><button class="om-button om-secondary" data-action="export" data-id="${esc(c.id)}">Exportar JSON</button><button class="om-button om-secondary" data-action="delete" data-id="${esc(c.id)}">Excluir</button><button class="om-button om-primary" data-action="edit" data-id="${esc(c.id)}">Editar ficha</button></div></div><section class="om-sheet-hero"><div class="om-avatar big">${initials(c.name)}</div><div><div class="om-eyebrow">ESCOLHIDO · ${esc(c.kingdom || 'REINO DESCONHECIDO')}</div><h1>${esc(c.name)}</h1><p>${esc(c.className || 'Vocação em aberto')} <span>·</span> ${esc(c.socialClass || 'Origem não definida')} <span>·</span> ${esc(c.player || 'Jogador não informado')}</p></div><div class="om-sheet-lotus">✿</div></section><div class="om-sheet-grid"><section class="om-panel"><div class="om-panel-head"><span>01</span><h2>Atributos</h2></div><div class="om-sheet-attrs">${ATTRIBUTES.map(a=>`<div><span>${a}</span><b>${Number(c.attributes?.[a]||1)}<small>d20</small></b><i>${'●'.repeat(Number(c.attributes?.[a]||1))}${'○'.repeat(5-Number(c.attributes?.[a]||1))}</i></div>`).join('')}</div></section><section class="om-panel"><div class="om-panel-head"><span>02</span><h2>Perícias dominadas</h2></div><div class="om-sheet-skills">${skills}</div></section><section class="om-panel"><div class="om-panel-head"><span>03</span><h2>Origem e motivação</h2></div><dl class="om-details"><dt>Origem</dt><dd>${esc(c.origin||'—')}</dd><dt>Motivação</dt><dd>${esc(c.motivation||'—')}</dd><dt>Vínculo</dt><dd>${esc(c.bond||'—')}</dd><dt>Conflito</dt><dd>${esc(c.flaw||'—')}</dd></dl></section><section class="om-panel"><div class="om-panel-head"><span>04</span><h2>Poderes e equipamento</h2></div><h3>Habilidades</h3><p>${esc(c.powers||'A definir com o mestre.')}</p><h3>Equipamento</h3><p>${esc(c.equipment||'—')}</p></section><section class="om-panel wide"><div class="om-panel-head"><span>05</span><h2>Conceito e aparência</h2></div><p>${esc(c.classNotes||'Sem notas de vocação.')}</p><p>${esc(c.appearance||'Sem descrição visual.')}</p></section></div><div class="om-sheet-bottom"><span>✿</span><p>A marca de lótus é um sinal misterioso. Sua autenticidade não é determinada nesta ficha.</p></div></main>`);
  }
  function updateDraft(el) {
    const key = el.dataset.field; if (!key || !view.draft) return;
    view.draft[key] = el.value;
  }
  function validateStep() {
    if (view.step===0 && !view.draft.name.trim()) { alert('Coloca pelo menos o nome do personagem para continuar.'); return false; }
    return true;
  }
  function saveCharacter() {
    const d = view.draft;
    if (!d.name.trim()) { view.step=0; renderWizard(); alert('Coloca pelo menos o nome do personagem.'); return; }
    d.updatedAt = new Date().toISOString();
    const old = characters.findIndex(c=>c.id===d.id);
    if (old>=0) characters[old]=d; else characters.unshift(d);
    persist(); renderSheet(d.id);
  }
  function exportCharacter(id) {
    const c=characters.find(x=>x.id===id); if(!c)return;
    const blob=new Blob([JSON.stringify(c,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`ficha-${(c.name||'personagem').toLowerCase().replace(/[^a-z0-9]+/g,'-')}.json`; a.click(); URL.revokeObjectURL(a.href);
  }
  document.addEventListener('click', e => {
    const el=e.target.closest('[data-action]'); if(!el)return;
    const {action,id}=el.dataset;
    if(action==='home'){view={page:'home',characterId:null,step:0,draft:null};return renderHome();}
    if(action==='new'){view={page:'wizard',characterId:null,step:0,draft:blank()};return renderWizard();}
    if(action==='open')return renderSheet(id);
    if(action==='edit'){const c=characters.find(x=>x.id===id);if(!c)return;view={page:'wizard',characterId:id,step:0,draft:JSON.parse(JSON.stringify(c))};return renderWizard();}
    if(action==='export')return exportCharacter(id);
    if(action==='delete'){if(confirm('Excluir esta ficha deste navegador?')){characters=characters.filter(x=>x.id!==id);persist();renderHome();}return;}
    if(action==='next'){if(!validateStep())return;view.step=Math.min(view.step+1,4);return renderWizard();}
    if(action==='prev'){view.step=Math.max(0,view.step-1);return renderWizard();}
    if(action==='step'){const target=Number(el.dataset.step);if(target<=view.step||validateStep()){view.step=target;return renderWizard();}}
    if(action==='save')return saveCharacter();
    if(action==='attr'){const key=el.dataset.attr;const n=Number(view.draft.attributes[key]||1);view.draft.attributes[key]=Math.max(1,Math.min(5,n+Number(el.dataset.delta)));return renderWizard();}
  });
  document.addEventListener('input',e=>{if(e.target.matches('[data-field]'))updateDraft(e.target);});
  document.addEventListener('change',e=>{
    if(e.target.matches('[data-skill]')){
      const name=e.target.dataset.skill;const set=new Set(view.draft.trainedSkills||[]);
      e.target.checked?set.add(name):set.delete(name);view.draft.trainedSkills=[...set];
      e.target.closest('.om-skill').classList.toggle('chosen',e.target.checked);
      e.target.closest('.om-skill').querySelector('.om-skill-check').textContent=e.target.checked?'✓':'';
    }
  });
  renderHome();
})();
