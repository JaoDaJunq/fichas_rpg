(() => {
  'use strict';

  const STORAGE_KEY = 'fichas-daemon-state-v2';
  const DEVICE_KEY = 'fichas-daemon-device-v1';
  const app = document.querySelector('#app');
  const modalRoot = document.querySelector('#modal-root');
  const toastRoot = document.querySelector('#toast-root');
  const syncChannel = 'BroadcastChannel' in window ? new BroadcastChannel('fichas-daemon-sync-v1') : null;

  const ATTRIBUTES = [
    ['con', 'Constituição'], ['fr', 'Força'], ['dex', 'Destreza'], ['agi', 'Agilidade'],
    ['int', 'Inteligência'], ['will', 'Força de Vontade'], ['per', 'Percepção'], ['car', 'Carisma']
  ];

  const DEFAULT_SKILLS = [
    ['Acrobacia', 30], ['Armas Brancas', 35], ['Armas de Fogo', 25], ['Atletismo', 35],
    ['Condução', 20], ['Disfarce', 20], ['Furtividade', 30], ['Investigação', 35],
    ['Lábia', 30], ['Medicina', 15], ['Ocultismo', 20], ['Sobrevivência', 25]
  ];

  const SECTIONS = [
    ['skills', 'Perícias'], ['attributes', 'Atributos'], ['reserves', 'Reservas'], ['combat', 'Combate'],
    ['magic', 'Magia'], ['inventory', 'Inventário'], ['upgrades', 'Aprimoramentos'], ['powers', 'Poderes e Fraquezas'],
    ['identity', 'Identidade'], ['notes', 'Anotações']
  ];

  const ui = {
    role: null,
    campaignId: null,
    sheetId: null,
    masterTab: 'overview',
    sheetMode: 'play',
    openSections: new Set(['skills', 'attributes']),
    playerMode: 'list'
  };

  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uid('device');
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function freshState() {
    return { version: 2, campaigns: {}, recent: { role: null, campaignId: null, sheetId: null } };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : freshState();
    } catch {
      return freshState();
    }
  }

  function normalizeSheet(s) {
    if (!s) return s;
    const defaults = {
      title: '', race: '', sect: '', kit: '', level: '', fatalism: '', epicScale: '',
      concept: '', age: '', profession: '', notes: ''
    };
    Object.entries(defaults).forEach(([key, value]) => { if (s[key] == null) s[key] = value; });
    s.attributes ||= {};
    ATTRIBUTES.forEach(([key]) => { if (s.attributes[key] == null) s.attributes[key] = 10; });
    s.skills ||= [];
    s.reserves ||= { skillPoints: 0, upgradePoints: 0, heroPoints: 0, magicPoints: 0 };
    ['skillPoints','upgradePoints','heroPoints','magicPoints'].forEach(key => { if (s.reserves[key] == null) s.reserves[key] = 0; });
    s.combat ||= { hp: 20, hpMax: 20, initiative: 0, defense: 0, armor: 0, damageBonus: 0, attacks: [] };
    if (!Array.isArray(s.combat.attacks)) s.combat.attacks = [];
    ['hp','hpMax','initiative','defense','armor','damageBonus'].forEach(key => { if (s.combat[key] == null) s.combat[key] = key === 'hpMax' ? 20 : key === 'hp' ? 20 : 0; });
    ['magic','inventory','upgrades','powers','weaknesses'].forEach(key => { if (!Array.isArray(s[key])) s[key] = []; });
    return s;
  }

  function normalizeStateShape(target) {
    target.campaigns ||= {};
    Object.values(target.campaigns).forEach(c => {
      c.rules = { ...defaultRules(), ...(c.rules || {}) };
      c.sheets ||= {};
      c.logs ||= [];
      Object.values(c.sheets).forEach(normalizeSheet);
    });
    return target;
  }

  let state = normalizeStateShape(loadState());

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    syncChannel?.postMessage({ type: 'state-updated', at: Date.now() });
  }

  function reloadState() {
    state = normalizeStateShape(loadState());
    return state;
  }

  function renderCurrentViewAfterSync() {
    reloadState();
    if (ui.role === 'master') {
      if (ui.campaignId && state.campaigns[ui.campaignId]) return renderMasterDashboard();
      return renderMasterLobby();
    }
    if (ui.role === 'player') {
      if (ui.campaignId && ui.sheetId && state.campaigns[ui.campaignId]?.sheets?.[ui.sheetId]) return renderSheet();
      return renderPlayerLobby();
    }
  }

  function defaultRules() {
    return {
      attributeMultiplier: 4,
      autoFailAbove: 95,
      criticalDivisor: 4,
      skillPointRate: 1,
      maxSkill: 95,
      hpFormula: 'CON + FR',
      allowPlayerHp: true
    };
  }

  function newSheet(ownerName, characterName, campaignId) {
    const attributes = {};
    ATTRIBUTES.forEach(([key]) => attributes[key] = 10);
    const id = uid('sheet');
    return {
      id,
      campaignId,
      ownerDeviceId: deviceId(),
      ownerName: ownerName || 'Jogador',
      name: characterName || 'Novo personagem',
      concept: '',
      age: '',
      profession: '',
      title: '',
      race: '',
      sect: '',
      kit: '',
      level: '',
      fatalism: '',
      epicScale: '',
      attributes,
      skills: DEFAULT_SKILLS.map(([name, value]) => ({ id: uid('skill'), name, value })),
      reserves: { skillPoints: 0, upgradePoints: 0, heroPoints: 0, magicPoints: 0 },
      combat: { hp: 20, hpMax: 20, initiative: 0, defense: 0, armor: 0, damageBonus: 0, attacks: [] },
      magic: [],
      inventory: [],
      upgrades: [],
      powers: [],
      weaknesses: [],
      notes: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function newCampaign(name, masterName, pin) {
    const id = uid('camp');
    const code = makeCode();
    return {
      id,
      name: name || 'Nova mesa',
      code,
      masterName: masterName || 'Mestre',
      masterPin: String(pin || '1234'),
      rules: defaultRules(),
      sheets: {},
      logs: [],
      createdAt: Date.now()
    };
  }

  function makeCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }

  function esc(value = '') {
    return String(value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function toast(message) {
    toastRoot.innerHTML = `<div class="toast">${esc(message)}</div>`;
    setTimeout(() => { toastRoot.innerHTML = ''; }, 2600);
  }

  function modal({ title, copy = '', body = '', actions = '' }) {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-close-modal>
        <div class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
          <div class="modal-head">
            <div><h2 class="modal-title">${title}</h2>${copy ? `<p class="modal-copy">${copy}</p>` : ''}</div>
            <button class="btn icon ghost" data-close-modal aria-label="Fechar">×</button>
          </div>
          ${body}
          ${actions ? `<div class="flex gap8 mt20">${actions}</div>` : ''}
        </div>
      </div>`;
  }

  function closeModal() { modalRoot.innerHTML = ''; }

  function campaign() { return state.campaigns[ui.campaignId] || null; }
  function sheet() { const c = campaign(); return c?.sheets?.[ui.sheetId] || null; }

  function topbar(sub = '') {
    return `
      <header class="topbar">
        <button class="brand btn ghost" data-action="go-hub" style="padding:0;border:0;background:transparent">
          <span class="brand-mark">D</span>
          <span><span class="brand-title">Fichas Daemon</span><span class="brand-sub">${esc(sub || 'Mesa digital')}</span></span>
        </button>
        <div class="top-actions">
          ${ui.role ? `<span class="pill gold hide-mobile">${ui.role === 'master' ? 'Mestre' : 'Jogador'}</span>` : ''}
          <button class="btn ghost small" data-action="go-hub">Trocar perfil</button>
        </div>
      </header>`;
  }

  function renderHub() {
    ui.role = null; ui.campaignId = null; ui.sheetId = null;
    app.innerHTML = `
      <main class="hub">
        <div class="hub-wrap">
          <div class="hub-head">
            <div class="eyebrow">Sua mesa, sem ficha perdida</div>
            <h1 class="hub-title">Quem vai jogar?</h1>
            <p class="hub-copy">Escolha como quer entrar. Jogadores cuidam das próprias fichas; o mestre acompanha a mesa inteira, PV, evolução e regras.</p>
          </div>
          <div class="role-grid">
            <button class="role-card" data-action="choose-player">
              <div class="role-icon">♟</div>
              <div class="role-name">Sou Jogador</div>
              <div class="role-desc">Entre por código, crie personagens e abra suas fichas para rolar perícias, controlar PV e evoluir.</div>
              <span class="role-go">ENTRAR →</span>
            </button>
            <button class="role-card" data-action="choose-master">
              <div class="role-icon">♜</div>
              <div class="role-name">Sou Mestre</div>
              <div class="role-desc">Crie a mesa, acompanhe todas as fichas, dê pontos de evolução e ajuste as regras usadas pelo grupo.</div>
              <span class="role-go">GERENCIAR →</span>
            </button>
          </div>
          <div class="hub-foot">Os dados deste protótipo ficam salvos neste navegador.</div>
        </div>
      </main>`;
  }

  function mySheets() {
    const result = [];
    Object.values(state.campaigns).forEach(c => {
      Object.values(c.sheets || {}).forEach(s => {
        if (s.ownerDeviceId === deviceId()) result.push({ campaign: c, sheet: s });
      });
    });
    return result.sort((a,b) => b.sheet.updatedAt - a.sheet.updatedAt);
  }

  function renderPlayerLobby() {
    reloadState();
    ui.role = 'player';
    const sheets = mySheets();
    app.innerHTML = `
      <div class="shell">
        ${topbar('Área do jogador')}
        <main class="content">
          <div class="page-head">
            <div><div class="eyebrow">Área do jogador</div><h1 class="page-title">Suas fichas</h1><p class="page-copy">Continue um personagem ou entre em uma nova mesa.</p></div>
            <button class="btn primary" data-action="join-table">+ Entrar em mesa</button>
          </div>
          ${sheets.length ? `<div class="grid two">${sheets.map(({campaign:c,sheet:s}) => `
            <article class="card gold-edge">
              <div class="flex between center gap12">
                <div><h2 class="card-title">${esc(s.name)}</h2><p class="card-copy">${esc(c.name)} · Mestre ${esc(c.masterName)}</p></div>
                <span class="pill">${Math.max(0,s.combat.hp)}/${s.combat.hpMax} PV</span>
              </div>
              <div class="sep"></div>
              <div class="flex between center gap8 wrap">
                <span class="small-text muted">${s.reserves.skillPoints} pts. de perícia · ${s.reserves.upgradePoints} aprim.</span>
                <div class="flex gap8 wrap"><button class="btn primary small" data-action="open-sheet" data-mode="play" data-campaign="${c.id}" data-sheet="${s.id}">Jogar</button><button class="btn small" data-action="open-sheet" data-mode="edit" data-campaign="${c.id}" data-sheet="${s.id}">Editar</button></div>
              </div>
            </article>`).join('')}</div>` : `
            <div class="empty"><strong>Nenhuma ficha neste navegador.</strong>Entre em uma mesa pelo código de convite para criar seu primeiro personagem.<div class="mt16"><button class="btn primary" data-action="join-table">Entrar em mesa</button></div></div>`}
        </main>
      </div>`;
  }

  function renderMasterLobby() {
    reloadState();
    ui.role = 'master';
    const campaigns = Object.values(state.campaigns).sort((a,b) => b.createdAt - a.createdAt);
    app.innerHTML = `
      <div class="shell">
        ${topbar('Área do mestre')}
        <main class="content">
          <div class="page-head">
            <div><div class="eyebrow">Área do mestre</div><h1 class="page-title">Suas mesas</h1><p class="page-copy">Abra uma mesa existente ou crie uma nova campanha.</p></div>
            <button class="btn primary" data-action="create-table">+ Criar mesa</button>
          </div>
          ${campaigns.length ? `<div class="grid two">${campaigns.map(c => `
            <article class="card">
              <div class="flex between center gap12">
                <div><h2 class="card-title">${esc(c.name)}</h2><p class="card-copy">Mestre ${esc(c.masterName)}</p></div>
                <span class="pill gold">${Object.keys(c.sheets || {}).length} fichas</span>
              </div>
              <div class="code-box mt16"><div><div class="small-text muted">Código de convite</div><div class="code">${esc(c.code)}</div></div><button class="btn small" data-action="copy-code" data-code="${esc(c.code)}">Copiar</button></div>
              <div class="flex between center gap8 mt16 wrap"><span class="small-text muted">Criada em ${new Date(c.createdAt).toLocaleDateString('pt-BR')}</span><button class="btn primary small" data-action="master-login" data-campaign="${c.id}">Abrir painel</button></div>
            </article>`).join('')}</div>` : `
            <div class="empty"><strong>Você ainda não criou nenhuma mesa.</strong>Crie uma campanha e compartilhe o código com os jogadores.<div class="mt16"><button class="btn primary" data-action="create-table">Criar primeira mesa</button></div></div>`}
        </main>
      </div>`;
  }

  function renderSheet() {
    const c = campaign(); const s = sheet();
    if (!c || !s) return ui.role === 'master' ? renderMasterDashboard() : renderPlayerLobby();
    normalizeSheet(s);
    return ui.sheetMode === 'edit' ? renderEditSheet(c, s) : renderPlaySheet(c, s);
  }

  function renderSheetModeSwitch() {
    return `<div class="sheet-mode-tabs" aria-label="Visualização da ficha">
      <button class="sheet-mode-btn ${ui.sheetMode === 'play' ? 'active' : ''}" data-action="sheet-mode" data-mode="play">◈ Modo de jogo</button>
      <button class="sheet-mode-btn ${ui.sheetMode === 'edit' ? 'active' : ''}" data-action="sheet-mode" data-mode="edit">✎ Editar ficha</button>
    </div>`;
  }

  function renderSheetBackButton() {
    return ui.role === 'master'
      ? '<button class="btn ghost" data-action="back-master-dashboard">Painel do mestre</button>'
      : '<button class="btn ghost" data-action="player-home">Minhas fichas</button>';
  }

  function renderEditSheet(c, s) {
    app.innerHTML = `
      <div class="shell">
        ${topbar(c.name)}
        <main class="content">
          <div class="sheet-toolbar">
            <div class="flex gap8 wrap">${renderSheetBackButton()}${renderSheetModeSwitch()}</div>
            <button class="btn" data-action="quick-roll">Rolar d100</button>
          </div>
          <div class="page-head sheet-page-head">
            <div class="identity-hero">
              <div class="avatar">${esc((s.name || '?').slice(0,1).toUpperCase())}</div>
              <div><div class="eyebrow">Atualização da ficha</div><h1 class="char-name">${esc(s.name)}</h1><div class="char-sub">${esc(s.ownerName)} · ${esc(c.name)} · código ${esc(c.code)}</div></div>
            </div>
            <span class="pill gold">Alterações salvas automaticamente</span>
          </div>
          <div class="sheet-layout">
            <div class="sheet-main"><div class="section-stack">${SECTIONS.map((sec,i) => renderSection(sec,i,s,c)).join('')}</div></div>
            <aside class="sheet-side">
              <div class="card gold-edge"><div class="eyebrow">Evolução</div><h3 class="card-title">Pontos disponíveis</h3>
                <div class="stat-grid" style="grid-template-columns:1fr 1fr">
                  <div class="stat"><div class="stat-label">Perícia</div><div class="stat-value">${s.reserves.skillPoints}</div></div>
                  <div class="stat"><div class="stat-label">Aprim.</div><div class="stat-value">${s.reserves.upgradePoints}</div></div>
                </div>
                <p class="card-copy mt12">Aqui é onde a ficha cresce. Durante a sessão, use o Modo de jogo para enxergar tudo mais rápido.</p>
              </div>
              <div class="card"><div class="eyebrow">Últimos testes</div><h3 class="card-title">Rolagens da mesa</h3>${renderMiniLogs(c)}</div>
            </aside>
          </div>
        </main>
        ${renderHpDock(s)}
      </div>`;
  }

  function isCombatSkill(skill) {
    return /(arma|armas|combate|briga|luta|esquiva|tiro|arco|lança|espada|machado)/i.test(skill.name || '');
  }

  function renderGameSkillRows(skills, empty = 'Nenhuma perícia cadastrada.') {
    if (!skills.length) return `<div class="game-empty">${empty}</div>`;
    return `<div class="game-skill-list">${skills.map(sk => `
      <button class="game-skill-row" data-action="roll-skill" data-skill="${sk.id}" title="Rolar ${esc(sk.name)}">
        <span class="game-skill-name">${esc(sk.name)}</span>
        <strong class="game-skill-value">${Number(sk.value) || 0}%</strong>
        <span class="game-die">d100</span>
      </button>`).join('')}</div>`;
  }

  function parsePercent(value = '') {
    const match = String(value).match(/(\d{1,3})\s*%/);
    return match ? Math.max(1, Math.min(100, Number(match[1]))) : null;
  }

  function renderGameAttacks(s) {
    if (!s.combat.attacks.length) return '<div class="game-empty">Nenhum ataque cadastrado.</div>';
    return `<div class="game-attack-list">${s.combat.attacks.map((attack, index) => {
      const target = parsePercent(attack.detail || '');
      return `<div class="game-attack-row">
        <div class="game-attack-main"><strong>${esc(attack.name)}</strong>${attack.detail ? `<span>${esc(attack.detail)}</span>` : ''}</div>
        ${target ? `<button class="game-roll-mini" data-action="roll-attack" data-index="${index}" title="Rolar ataque">${target}% ◆</button>` : '<span class="game-chip">ataque</span>'}
      </div>`;
    }).join('')}</div>`;
  }

  function renderGameList(list, empty = 'Nada anotado.') {
    if (!list.length) return `<div class="game-empty">${empty}</div>`;
    return `<div class="game-read-list">${list.map(item => {
      const title = typeof item === 'string' ? item : item.name;
      const detail = typeof item === 'string' ? '' : (item.detail || item.value || '');
      return `<div class="game-read-item"><strong>${esc(title || '')}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</div>`;
    }).join('')}</div>`;
  }

  function renderResourceOrb(label, value, key = '') {
    const controls = key ? `<div class="orb-controls"><button data-action="resource-minus" data-resource="${key}" aria-label="Diminuir ${label}">−</button><button data-action="resource-plus" data-resource="${key}" aria-label="Aumentar ${label}">+</button></div>` : '';
    return `<div class="resource-orb"><span>${label}</span><strong>${value}</strong>${controls}</div>`;
  }

  function renderPlaySheet(c, s) {
    const allSkills = [...s.skills].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));
    const combatSkills = allSkills.filter(isCombatSkill);
    const generalSkills = allSkills.filter(sk => !isCombatSkill(sk));
    const hpPct = Math.max(0, Math.min(100, (s.combat.hp / Math.max(1, s.combat.hpMax)) * 100));
    const meta = [s.title, s.race, s.profession, s.concept].filter(Boolean);

    app.innerHTML = `
      <div class="shell play-shell">
        ${topbar(c.name)}
        <main class="content game-content">
          <div class="sheet-toolbar game-toolbar">
            <div class="flex gap8 wrap">${renderSheetBackButton()}${renderSheetModeSwitch()}</div>
            <button class="btn" data-action="quick-roll">Rolar d100</button>
          </div>

          <article class="game-sheet">
            <header class="game-identity">
              <div class="game-identity-copy">
                <div class="game-kicker">FICHA DE JOGO · ${esc(c.name)}</div>
                <h1>${esc(s.name)}</h1>
                <div class="game-owner">${esc(s.ownerName)}${meta.length ? ` · ${meta.map(esc).join(' · ')}` : ''}</div>
                <div class="game-id-lines">
                  ${s.sect ? `<span><b>Seita</b>${esc(s.sect)}</span>` : ''}
                  ${s.kit ? `<span><b>Kit</b>${esc(s.kit)}</span>` : ''}
                  ${s.level ? `<span><b>Nível</b>${esc(s.level)}</span>` : ''}
                  ${s.age ? `<span><b>Idade</b>${esc(s.age)}</span>` : ''}
                  ${s.fatalism ? `<span><b>Fatalismo</b>${esc(s.fatalism)}</span>` : ''}
                  ${s.epicScale ? `<span><b>Escala épica</b>${esc(s.epicScale)}</span>` : ''}
                </div>
              </div>
              <div class="game-vital-card">
                <span>PV</span>
                <div><strong>${s.combat.hp}</strong><small>/ ${s.combat.hpMax}</small></div>
                <div class="game-hp-track"><span style="width:${hpPct}%"></span></div>
                <div class="game-vital-actions"><button data-action="hp-minus">−</button><button data-action="hp-plus">+</button></div>
              </div>
            </header>

            <div class="game-columns">
              <div class="game-column">
                <section class="game-panel attributes-panel">
                  <div class="game-panel-head"><h2>Atributos</h2><span>toque para testar</span></div>
                  <div class="game-attributes">${ATTRIBUTES.map(([key, name]) => `
                    <button class="game-attribute" data-action="roll-attr-now" data-attr="${key}">
                      <span>${name}</span><strong>${s.attributes[key]}</strong><small>${s.attributes[key] * c.rules.attributeMultiplier}%</small>
                    </button>`).join('')}</div>
                </section>

                <section class="game-panel combat-panel">
                  <div class="game-panel-head"><h2>Combate</h2><span>o que importa na hora</span></div>
                  <div class="game-combat-stats">
                    <div><span>Iniciativa</span><strong>${s.combat.initiative}</strong></div>
                    <div><span>Defesa</span><strong>${s.combat.defense}</strong></div>
                    <div><span>Armadura</span><strong>${s.combat.armor}</strong></div>
                    <div><span>Bônus dano</span><strong>${s.combat.damageBonus}</strong></div>
                  </div>
                  <h3 class="game-subtitle">Ataques</h3>
                  ${renderGameAttacks(s)}
                  ${combatSkills.length ? `<h3 class="game-subtitle">Perícias de combate</h3>${renderGameSkillRows(combatSkills)}` : ''}
                </section>

                <section class="game-panel reserves-panel">
                  <div class="game-panel-head"><h2>Reservas</h2><span>controle rápido</span></div>
                  <div class="resource-orbs">
                    ${renderResourceOrb('PV', `${s.combat.hp}/${s.combat.hpMax}`)}
                    ${renderResourceOrb('PH', s.reserves.heroPoints, 'heroPoints')}
                    ${renderResourceOrb('PM', s.reserves.magicPoints, 'magicPoints')}
                    ${renderResourceOrb('Perícia', s.reserves.skillPoints)}
                    ${renderResourceOrb('Aprim.', s.reserves.upgradePoints)}
                  </div>
                </section>

                <section class="game-panel">
                  <div class="game-panel-head"><h2>Aprimoramentos</h2><span>${s.upgrades.length}</span></div>
                  ${renderGameList(s.upgrades, 'Nenhum aprimoramento cadastrado.')}
                </section>
              </div>

              <div class="game-column game-column-wide">
                <section class="game-panel skills-panel">
                  <div class="game-panel-head"><h2>Perícias</h2><span>1d100 contra o valor</span></div>
                  ${renderGameSkillRows(generalSkills, 'Nenhuma perícia geral cadastrada.')}
                </section>

                <div class="game-pair">
                  <section class="game-panel">
                    <div class="game-panel-head"><h2>Magia</h2><span>${s.magic.length}</span></div>
                    ${renderGameList(s.magic, 'Nenhuma magia anotada.')}
                  </section>
                  <section class="game-panel">
                    <div class="game-panel-head"><h2>Equipamentos</h2><span>${s.inventory.length}</span></div>
                    ${renderGameList(s.inventory, 'Inventário vazio.')}
                  </section>
                </div>

                <div class="game-pair">
                  <section class="game-panel">
                    <div class="game-panel-head"><h2>Poderes</h2><span>${s.powers.length}</span></div>
                    ${renderGameList(s.powers, 'Nenhum poder cadastrado.')}
                  </section>
                  <section class="game-panel danger-panel">
                    <div class="game-panel-head"><h2>Fraquezas</h2><span>${s.weaknesses.length}</span></div>
                    ${renderGameList(s.weaknesses, 'Nenhuma fraqueza cadastrada.')}
                  </section>
                </div>

                <section class="game-panel notes-panel">
                  <div class="game-panel-head"><h2>Anotações rápidas</h2><span>leitura</span></div>
                  <p>${s.notes ? esc(s.notes).replaceAll('\n','<br>') : 'Sem anotações ainda. Use “Editar ficha” para registrar pistas, contatos e observações.'}</p>
                </section>
              </div>
            </div>
          </article>
        </main>
        ${renderHpDock(s)}
      </div>`;
  }

  function renderSection([key,name], index, s, c) {
    const open = ui.openSections.has(key);
    return `<section class="sheet-section ${open ? 'open' : ''}" data-section="${key}">
      <button class="section-toggle" data-action="toggle-section" data-section="${key}">
        <span class="section-name"><span class="section-index">${String(index+1).padStart(2,'0')}</span>${name}</span>
        <span class="section-meta">${sectionSummary(key,s)} <span class="chevron">⌄</span></span>
      </button>
      <div class="section-body">${renderSectionBody(key,s,c)}</div>
    </section>`;
  }

  function sectionSummary(key,s) {
    const map = {
      skills: `${s.skills.length} perícias`,
      attributes: '8 atributos',
      reserves: `${s.reserves.heroPoints} heroicos`,
      combat: `${s.combat.hp}/${s.combat.hpMax} PV`,
      magic: `${s.magic.length} registros`, inventory: `${s.inventory.length} itens`,
      upgrades: `${s.upgrades.length} aprim.`, powers: `${s.powers.length + s.weaknesses.length} registros`,
      identity: s.profession || 'perfil', notes: s.notes ? 'com notas' : 'vazio'
    };
    return map[key] || '';
  }

  function renderSectionBody(key,s,c) {
    switch(key) {
      case 'skills': return `
        <div class="skill-list">${s.skills.sort((a,b)=>a.name.localeCompare(b.name)).map(sk => `
          <div class="skill-row"><span class="skill-name">${esc(sk.name)}</span><span class="skill-value">${sk.value}%</span><button class="roll-btn" title="Rolar 1d100" data-action="roll-skill" data-skill="${sk.id}">◆</button></div>`).join('')}</div>
        <div class="flex gap8 mt12 wrap"><button class="btn small" data-action="add-skill">+ Perícia</button>${s.reserves.skillPoints > 0 ? `<button class="btn success small" data-action="spend-skill">Gastar pontos (${s.reserves.skillPoints})</button>` : ''}</div>`;
      case 'attributes': return `<div class="stat-grid">${ATTRIBUTES.map(([k,n]) => `<div class="stat"><div class="stat-label">${n}</div><div class="stat-value">${s.attributes[k]}</div><div class="stat-test">teste ${s.attributes[k]*c.rules.attributeMultiplier}%</div></div>`).join('')}</div><div class="flex gap8 mt12"><button class="btn small" data-action="edit-attributes">Editar atributos</button><button class="btn small" data-action="roll-attribute">Testar atributo</button></div>`;
      case 'reserves': return `<div class="stat-grid"><div class="stat"><div class="stat-label">Perícia</div><div class="stat-value">${s.reserves.skillPoints}</div></div><div class="stat"><div class="stat-label">Aprimoramento</div><div class="stat-value">${s.reserves.upgradePoints}</div></div><div class="stat"><div class="stat-label">Heroicos</div><div class="stat-value">${s.reserves.heroPoints}</div></div><div class="stat"><div class="stat-label">Magia</div><div class="stat-value">${s.reserves.magicPoints}</div></div></div>`;
      case 'combat': return `
        <div class="stat-grid"><div class="stat"><div class="stat-label">PV</div><div class="stat-value">${s.combat.hp}/${s.combat.hpMax}</div></div><div class="stat"><div class="stat-label">Iniciativa</div><div class="stat-value">${s.combat.initiative}</div></div><div class="stat"><div class="stat-label">Defesa</div><div class="stat-value">${s.combat.defense}</div></div><div class="stat"><div class="stat-label">Armadura</div><div class="stat-value">${s.combat.armor}</div></div></div>
        <div class="mt12">${renderGenericList(s.combat.attacks,'Nenhum ataque salvo.','remove-attack')}</div>
        <div class="flex gap8 mt12"><button class="btn small" data-action="edit-combat">Editar combate</button><button class="btn small" data-action="add-attack">+ Ataque</button></div>`;
      case 'magic': return `${renderGenericList(s.magic,'Nenhuma magia anotada.','remove-magic')}<button class="btn small mt12" data-action="add-magic">+ Magia</button>`;
      case 'inventory': return `${renderGenericList(s.inventory,'Inventário vazio.','remove-inventory')}<button class="btn small mt12" data-action="add-inventory">+ Item</button>`;
      case 'upgrades': return `${renderGenericList(s.upgrades,'Nenhum aprimoramento.','remove-upgrade')}<div class="flex gap8 mt12"><button class="btn small" data-action="add-upgrade">+ Aprimoramento</button>${s.reserves.upgradePoints > 0 ? `<span class="pill green">${s.reserves.upgradePoints} ponto(s) disponível(is)</span>` : ''}</div>`;
      case 'powers': return `<div class="grid two"><div><div class="label">Poderes</div><div class="mt8">${renderGenericList(s.powers,'Nenhum poder.','remove-power')}</div><button class="btn small mt12" data-action="add-power">+ Poder</button></div><div><div class="label">Fraquezas</div><div class="mt8">${renderGenericList(s.weaknesses,'Nenhuma fraqueza.','remove-weakness')}</div><button class="btn small mt12" data-action="add-weakness">+ Fraqueza</button></div></div>`;
      case 'identity': return `<div class="grid two">
        <div class="field"><label class="label">Nome</label><input class="input" data-bind="name" value="${esc(s.name)}"></div>
        <div class="field"><label class="label">Jogador</label><input class="input" data-bind="ownerName" value="${esc(s.ownerName)}"></div>
        <div class="field"><label class="label">Título</label><input class="input" data-bind="title" value="${esc(s.title)}" placeholder="Ex.: O Vigia"></div>
        <div class="field"><label class="label">Raça</label><input class="input" data-bind="race" value="${esc(s.race)}"></div>
        <div class="field"><label class="label">Conceito</label><input class="input" data-bind="concept" value="${esc(s.concept)}" placeholder="Ex.: investigador ocultista"></div>
        <div class="field"><label class="label">Profissão</label><input class="input" data-bind="profession" value="${esc(s.profession)}"></div>
        <div class="field"><label class="label">Seita</label><input class="input" data-bind="sect" value="${esc(s.sect)}"></div>
        <div class="field"><label class="label">Kit</label><input class="input" data-bind="kit" value="${esc(s.kit)}"></div>
        <div class="field"><label class="label">Nível</label><input class="input" data-bind="level" value="${esc(s.level)}"></div>
        <div class="field"><label class="label">Idade</label><input class="input" data-bind="age" value="${esc(s.age)}"></div>
        <div class="field"><label class="label">Fatalismo</label><input class="input" data-bind="fatalism" value="${esc(s.fatalism)}"></div>
        <div class="field"><label class="label">Escala épica</label><input class="input" data-bind="epicScale" value="${esc(s.epicScale)}"></div>
      </div><div class="hint mt12">Esses dados aparecem de forma compacta no Modo de jogo. Alterações são salvas automaticamente.</div>`;
      case 'notes': return `<textarea class="textarea" data-bind="notes" placeholder="Anotações da sessão, pistas, contatos, promessas, coisas estranhas...">${esc(s.notes)}</textarea><div class="hint mt8">Salvamento automático neste navegador.</div>`;
      default: return '';
    }
  }

  function renderGenericList(list, empty, removeAction) {
    if (!list.length) return `<div class="empty" style="padding:18px">${empty}</div>`;
    return `<div class="list">${list.map((item,index) => {
      const title = typeof item === 'string' ? item : item.name;
      const sub = typeof item === 'string' ? '' : (item.detail || item.value || '');
      return `<div class="list-item"><div class="list-main"><div class="list-title">${esc(title)}</div>${sub ? `<div class="list-sub">${esc(sub)}</div>` : ''}</div><button class="btn danger small" data-action="${removeAction}" data-index="${index}">Remover</button></div>`;
    }).join('')}</div>`;
  }

  function renderHpDock(s) {
    const pct = Math.max(0, Math.min(100, (s.combat.hp / Math.max(1,s.combat.hpMax))*100));
    return `<div class="hp-dock"><button class="hp-btn" data-action="hp-minus">−</button><div class="hp-core"><div class="hp-line"><span class="hp-label">Pontos de vida</span><span class="hp-value">${s.combat.hp} / ${s.combat.hpMax}</span></div><div class="hp-track"><div class="hp-fill" style="width:${pct}%"></div></div></div><input class="input hp-input" type="number" min="0" max="999" value="${s.combat.hp}" data-bind-combat="hp"><button class="hp-btn" data-action="hp-plus">+</button></div>`;
  }

  function renderMiniLogs(c) {
    const logs = (c.logs || []).slice(0,4);
    if (!logs.length) return `<div class="empty mt12" style="padding:16px">Ainda sem rolagens.</div>`;
    return `<div class="list mt12">${logs.map(l => `<div class="list-item"><div class="list-main"><div class="list-title">${esc(l.character)} · ${esc(l.label)}</div><div class="list-sub">${l.roll} contra ${l.target}% · ${esc(l.result)}</div></div></div>`).join('')}</div>`;
  }

  function renderMasterDashboard() {
    const c = campaign(); if (!c) return renderMasterLobby();
    const sheets = Object.values(c.sheets || {});
    app.innerHTML = `
      <div class="shell">
        ${topbar(c.name)}
        <main class="content">
          <div class="page-head">
            <div><div class="eyebrow">Painel do mestre</div><h1 class="page-title">${esc(c.name)}</h1><p class="page-copy">Mestre ${esc(c.masterName)} · ${sheets.length} ficha(s) na mesa.</p></div>
            <div class="flex gap8 wrap"><button class="btn ghost" data-action="master-home">Minhas mesas</button><button class="btn" data-action="master-create-sheet">+ Criar ficha</button><button class="btn primary" data-action="copy-code" data-code="${esc(c.code)}">Convite ${esc(c.code)}</button></div>
          </div>
          <div class="master-layout">
            <nav class="master-nav">
              ${[['overview','Visão geral'],['players','Fichas'],['rules','Regras'],['history','Rolagens']].map(([k,n]) => `<button class="btn ${ui.masterTab===k?'active':''}" data-action="master-tab" data-tab="${k}">${n}</button>`).join('')}
            </nav>
            <section>${renderMasterTab(c,sheets)}</section>
          </div>
        </main>
      </div>`;
  }

  function renderMasterTab(c,sheets) {
    if (ui.masterTab === 'overview') {
      const totalHp = sheets.reduce((sum,s)=>sum+Math.max(0,s.combat.hp),0);
      const totalMax = sheets.reduce((sum,s)=>sum+s.combat.hpMax,0);
      return `<div class="kpi-grid"><div class="kpi"><div class="kpi-label">Jogadores</div><div class="kpi-value">${sheets.length}</div></div><div class="kpi"><div class="kpi-label">PV atual</div><div class="kpi-value">${totalHp}</div></div><div class="kpi"><div class="kpi-label">PV máximo</div><div class="kpi-value">${totalMax}</div></div><div class="kpi"><div class="kpi-label">Rolagens</div><div class="kpi-value">${c.logs.length}</div></div></div>
      <div class="card gold-edge"><div class="flex between center gap12 wrap"><div><div class="eyebrow">Convite da mesa</div><h2 class="card-title">Código ${esc(c.code)}</h2><p class="card-copy">Passe este código para os jogadores criarem a ficha dentro da mesa.</p></div><button class="btn primary" data-action="copy-code" data-code="${esc(c.code)}">Copiar código</button></div></div>
      <div class="mt16">${renderPlayers(c,sheets)}</div>`;
    }
    if (ui.masterTab === 'players') return renderPlayers(c,sheets,true);
    if (ui.masterTab === 'rules') return renderRules(c);
    if (ui.masterTab === 'history') return renderHistory(c);
  }

  function renderPlayers(c,sheets,full=false) {
    if (!sheets.length) return `<div class="empty"><strong>Ninguém entrou ainda.</strong>Compartilhe o código <span class="mono gold">${esc(c.code)}</span> ou crie uma ficha manualmente para testar o sistema.<div class="mt16"><button class="btn primary" data-action="master-create-sheet">+ Criar primeira ficha</button></div></div>`;
    return `<div class="player-grid">${sheets.map(s => {
      const pct = Math.max(0,Math.min(100,(s.combat.hp/Math.max(1,s.combat.hpMax))*100));
      return `<article class="player-card"><div class="player-card-head"><div><div class="player-name">${esc(s.name)}</div><div class="player-owner">Jogador: ${esc(s.ownerName)}</div></div><span class="pill ${pct<30?'red':pct<65?'gold':'green'}">${s.combat.hp}/${s.combat.hpMax} PV</span></div>
      <div class="mini-hp"><div class="mini-hp-line"><span>Vida</span><span>${Math.round(pct)}%</span></div><div class="mini-track"><div class="mini-fill" style="width:${pct}%"></div></div></div>
      ${full ? `<div class="stat-grid mt12" style="grid-template-columns:1fr 1fr"><div class="stat"><div class="stat-label">Pts perícia</div><div class="stat-value">${s.reserves.skillPoints}</div></div><div class="stat"><div class="stat-label">Pts aprim.</div><div class="stat-value">${s.reserves.upgradePoints}</div></div></div>` : ''}
      <div class="player-actions"><button class="btn primary small" data-action="master-open-sheet" data-mode="play" data-sheet="${s.id}">Modo de jogo</button><button class="btn small" data-action="master-open-sheet" data-mode="edit" data-sheet="${s.id}">Editar ficha</button><button class="btn success small" data-action="give-points" data-sheet="${s.id}">Dar pontos</button><button class="btn small" data-action="master-hp" data-sheet="${s.id}">Ajustar PV</button></div></article>`;
    }).join('')}</div>`;
  }

  function renderRules(c) {
    const r = c.rules;
    return `<div class="card"><div class="eyebrow">Regras da mesa</div><h2 class="card-title">Contas e limites</h2><p class="card-copy">O mestre pode adaptar estes valores para a versão do sistema usada pelo grupo.</p>
      <div class="grid two mt20">
        ${ruleInput('attributeMultiplier','Atributo ×','Multiplicador usado no teste de atributo.',r.attributeMultiplier)}
        ${ruleInput('autoFailAbove','Falha automática acima de','Ex.: 95 faz 96–100 falharem sempre.',r.autoFailAbove)}
        ${ruleInput('criticalDivisor','Divisor do crítico','O índice crítico é o valor do teste dividido por este número.',r.criticalDivisor)}
        ${ruleInput('skillPointRate','Ponto de evolução vale','Quanto cada ponto aumenta uma perícia.',r.skillPointRate)}
        ${ruleInput('maxSkill','Limite de perícia','Maior valor permitido ao evoluir.',r.maxSkill)}
        <div class="field"><label class="label">Fórmula de PV</label><input class="input" value="${esc(r.hpFormula)}" data-rule="hpFormula"><div class="hint">Rótulo informativo para a mesa.</div></div>
      </div>
      <div class="flex gap8 mt20"><button class="btn primary" data-action="save-rules">Salvar regras</button><button class="btn ghost" data-action="reset-rules">Restaurar padrão</button></div>
    </div>`;
  }

  function ruleInput(key,label,hint,value) {
    return `<div class="field"><label class="label">${label}</label><input class="input" type="number" min="1" value="${value}" data-rule="${key}"><div class="hint">${hint}</div></div>`;
  }

  function renderHistory(c) {
    if (!c.logs.length) return `<div class="empty"><strong>Nenhuma rolagem registrada.</strong>Os testes feitos nas fichas aparecem aqui.</div>`;
    return `<div class="table-wrap"><table class="table"><thead><tr><th>Personagem</th><th>Teste</th><th>Rolagem</th><th>Alvo</th><th>Resultado</th><th>Hora</th></tr></thead><tbody>${c.logs.map(l => `<tr><td>${esc(l.character)}</td><td>${esc(l.label)}</td><td class="mono">${l.roll}</td><td class="mono">${l.target}%</td><td>${esc(l.result)}</td><td>${new Date(l.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function doRoll(label,target) {
    const c = campaign(); const s = sheet(); if (!c || !s) return;
    const roll = Math.floor(Math.random()*100)+1;
    const criticalIndex = Math.floor(target / Math.max(1,c.rules.criticalDivisor));
    let result = 'Sucesso'; let cls = 'success';
    if (roll > c.rules.autoFailAbove || roll > target) { result = 'Falha'; cls='fail'; }
    if (roll <= criticalIndex) { result = 'Crítico'; cls='critical'; }
    if (!c.logs) c.logs=[];
    c.logs.unshift({ id:uid('roll'), character:s.name, label, roll, target, result, at:Date.now() });
    c.logs = c.logs.slice(0,100);
    saveState();
    modalRoot.innerHTML = `<div class="roll-overlay" data-close-modal><div class="roll-card" onclick="event.stopPropagation()"><div class="eyebrow">1d100</div><h2 class="roll-title">${esc(label)}</h2><div class="d100">${roll}</div><div class="roll-result ${cls}">${result}</div><div class="roll-info">Alvo ${target}% · crítico até ${criticalIndex} · falha automática acima de ${c.rules.autoFailAbove}.</div><button class="btn primary w100" data-close-modal>Fechar</button></div></div>`;
  }

  function openJoinTable() {
    reloadState();
    modal({ title:'Entrar em uma mesa', copy:'Use o código enviado pelo mestre e crie sua ficha.', body:`<form class="form" id="join-form"><div class="field"><label class="label">Código da mesa</label><input class="input mono" name="code" maxlength="6" autocomplete="off" placeholder="ABC123" required></div><div class="field"><label class="label">Seu nome</label><input class="input" name="owner" placeholder="Ex.: João" required></div><div class="field"><label class="label">Nome do personagem</label><input class="input" name="character" placeholder="Ex.: Dante Ferraz" required></div><button class="btn primary" type="submit">Criar ficha e entrar</button><div class="hint">Se a mesa acabou de ser criada em outra aba deste navegador, ela agora é atualizada automaticamente.</div></form>` });
  }

  function openMasterCreateSheet() {
    const c = campaign(); if (!c) return;
    modal({ title:'Criar ficha na mesa', copy:'Cadastre um personagem manualmente para testar ou preparar a mesa antes dos jogadores entrarem.', body:`<form class="form" id="master-create-sheet-form"><div class="field"><label class="label">Nome do jogador</label><input class="input" name="owner" placeholder="Ex.: João" required></div><div class="field"><label class="label">Nome do personagem</label><input class="input" name="character" placeholder="Ex.: Dante Ferraz" required></div><button class="btn primary" type="submit">Criar e abrir ficha</button></form>` });
  }

  function openCreateTable() {
    modal({ title:'Criar uma mesa', copy:'Você recebe um código para compartilhar com os jogadores.', body:`<form class="form" id="create-table-form"><div class="field"><label class="label">Nome da mesa</label><input class="input" name="name" placeholder="Ex.: Ecos de Arkanun" required></div><div class="field"><label class="label">Seu nome</label><input class="input" name="master" placeholder="Ex.: Kauan" required></div><div class="field"><label class="label">PIN do mestre</label><input class="input mono" name="pin" type="password" inputmode="numeric" minlength="4" maxlength="10" placeholder="4 ou mais números" required><div class="hint">Usado para abrir o painel desta mesa neste protótipo.</div></div><button class="btn primary" type="submit">Criar mesa</button></form>` });
  }

  function openMasterLogin(campaignId) {
    reloadState();
    const c = state.campaigns[campaignId]; if (!c) return;
    modal({ title:`Abrir ${esc(c.name)}`, copy:'Digite o PIN definido quando a mesa foi criada.', body:`<form class="form" id="master-login-form" data-campaign="${c.id}"><div class="field"><label class="label">PIN do mestre</label><input class="input mono" name="pin" type="password" inputmode="numeric" required autofocus></div><button class="btn primary" type="submit">Abrir painel</button></form>` });
  }

  function promptSimple(title,label,placeholder,onSave,secondary='') {
    modal({title,body:`<form class="form" id="simple-form"><div class="field"><label class="label">${label}</label><input class="input" name="value" placeholder="${placeholder}" required autofocus></div>${secondary ? `<div class="field"><label class="label">Detalhe</label><input class="input" name="detail" placeholder="${secondary}"></div>`:''}<button class="btn primary" type="submit">Salvar</button></form>`});
    const form = document.querySelector('#simple-form');
    form.addEventListener('submit', e => { e.preventDefault(); const fd=new FormData(form); onSave(fd.get('value'), fd.get('detail')); closeModal(); renderSheet(); });
  }

  function spendSkillModal(s,c) {
    modal({title:'Evoluir perícia',copy:`Você tem ${s.reserves.skillPoints} ponto(s). Cada ponto aumenta ${c.rules.skillPointRate}.`,body:`<form class="form" id="spend-skill-form"><div class="field"><label class="label">Perícia</label><select class="select" name="skill">${s.skills.map(sk=>`<option value="${sk.id}">${esc(sk.name)} · ${sk.value}%</option>`).join('')}</select></div><div class="field"><label class="label">Pontos para gastar</label><input class="input" name="points" type="number" min="1" max="${s.reserves.skillPoints}" value="1" required></div><button class="btn primary" type="submit">Aplicar evolução</button></form>`});
  }

  function editAttributesModal(s) {
    modal({title:'Editar atributos',body:`<form class="form" id="attributes-form"><div class="grid two">${ATTRIBUTES.map(([k,n])=>`<div class="field"><label class="label">${n}</label><input class="input" name="${k}" type="number" min="1" max="100" value="${s.attributes[k]}"></div>`).join('')}</div><button class="btn primary" type="submit">Salvar atributos</button></form>`});
  }

  function rollAttributeModal(s,c) {
    modal({title:'Testar atributo',copy:`O alvo usa atributo × ${c.rules.attributeMultiplier}.`,body:`<div class="grid two">${ATTRIBUTES.map(([k,n])=>`<button class="btn" data-action="roll-attr-now" data-attr="${k}">${n} · ${s.attributes[k]*c.rules.attributeMultiplier}%</button>`).join('')}</div>`});
  }

  function editCombatModal(s) {
    modal({title:'Editar combate',body:`<form class="form" id="combat-form"><div class="grid two"><div class="field"><label class="label">PV máximo</label><input class="input" type="number" min="1" name="hpMax" value="${s.combat.hpMax}"></div><div class="field"><label class="label">Iniciativa</label><input class="input" type="number" name="initiative" value="${s.combat.initiative}"></div><div class="field"><label class="label">Defesa</label><input class="input" type="number" name="defense" value="${s.combat.defense}"></div><div class="field"><label class="label">Armadura</label><input class="input" type="number" name="armor" value="${s.combat.armor}"></div><div class="field"><label class="label">Bônus de dano</label><input class="input" type="number" name="damageBonus" value="${s.combat.damageBonus}"></div></div><button class="btn primary" type="submit">Salvar combate</button></form>`});
  }

  function givePointsModal(s) {
    modal({title:`Dar pontos a ${esc(s.name)}`,body:`<form class="form" id="give-points-form" data-sheet="${s.id}"><div class="field"><label class="label">Tipo</label><select class="select" name="type"><option value="skillPoints">Pontos de perícia</option><option value="upgradePoints">Pontos de aprimoramento</option><option value="heroPoints">Pontos heroicos</option><option value="magicPoints">Pontos de magia</option></select></div><div class="field"><label class="label">Quantidade</label><input class="input" name="amount" type="number" min="1" value="1" required></div><button class="btn primary" type="submit">Conceder pontos</button></form>`});
  }

  function adjustMasterHpModal(s) {
    modal({title:`PV de ${esc(s.name)}`,body:`<form class="form" id="master-hp-form" data-sheet="${s.id}"><div class="field"><label class="label">PV atual</label><input class="input" name="hp" type="number" min="0" value="${s.combat.hp}"></div><div class="field"><label class="label">PV máximo</label><input class="input" name="hpMax" type="number" min="1" value="${s.combat.hpMax}"></div><button class="btn primary" type="submit">Salvar PV</button></form>`});
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action], [data-close-modal]');
    if (!el) return;
    if (el.hasAttribute('data-close-modal')) { closeModal(); return; }
    const action = el.dataset.action;

    if (action === 'go-hub') return renderHub();
    if (action === 'choose-player') return renderPlayerLobby();
    if (action === 'choose-master') return renderMasterLobby();
    if (action === 'player-home') return renderPlayerLobby();
    if (action === 'master-home') return renderMasterLobby();
    if (action === 'join-table') return openJoinTable();
    if (action === 'create-table') return openCreateTable();
    if (action === 'master-create-sheet') return openMasterCreateSheet();
    if (action === 'copy-code') { navigator.clipboard?.writeText(el.dataset.code); toast(`Código ${el.dataset.code} copiado.`); return; }
    if (action === 'master-login') return openMasterLogin(el.dataset.campaign);
    if (action === 'open-sheet') { ui.campaignId=el.dataset.campaign; ui.sheetId=el.dataset.sheet; ui.role='player'; ui.sheetMode=el.dataset.mode || 'play'; return renderSheet(); }
    if (action === 'sheet-mode') { ui.sheetMode=el.dataset.mode === 'edit' ? 'edit' : 'play'; return renderSheet(); }
    if (action === 'toggle-section') { const k=el.dataset.section; ui.openSections.has(k)?ui.openSections.delete(k):ui.openSections.add(k); return renderSheet(); }
    if (action === 'roll-skill') { const s=sheet(); const sk=s.skills.find(x=>x.id===el.dataset.skill); if(sk) doRoll(sk.name,sk.value); return; }
    if (action === 'roll-attack') { const s=sheet(); const attack=s?.combat?.attacks?.[Number(el.dataset.index)]; const target=parsePercent(attack?.detail || ''); if(attack && target) doRoll(attack.name,target); return; }
    if (action === 'quick-roll') return doRoll('Teste livre',100);
    if (action === 'add-skill') return promptSimple('Nova perícia','Nome','Ex.: Arrombamento',(name)=>{ sheet().skills.push({id:uid('skill'),name,value:10}); saveState(); });
    if (action === 'spend-skill') return spendSkillModal(sheet(),campaign());
    if (action === 'edit-attributes') return editAttributesModal(sheet());
    if (action === 'roll-attribute') return rollAttributeModal(sheet(),campaign());
    if (action === 'roll-attr-now') { const k=el.dataset.attr; const s=sheet(),c=campaign(); closeModal(); return doRoll(ATTRIBUTES.find(x=>x[0]===k)?.[1]||k,s.attributes[k]*c.rules.attributeMultiplier); }
    if (action === 'edit-combat') return editCombatModal(sheet());
    if (action === 'add-attack') return promptSimple('Novo ataque','Nome','Ex.: Espada longa',(name,detail)=>{sheet().combat.attacks.push({name,detail});saveState();},'Ex.: 55% · 1d10+2');
    if (action === 'add-magic') return promptSimple('Nova magia','Nome','Ex.: Chama espectral',(name,detail)=>{sheet().magic.push({name,detail});saveState();},'Custo, círculo ou efeito');
    if (action === 'add-inventory') return promptSimple('Novo item','Item','Ex.: Lanterna',(name,detail)=>{sheet().inventory.push({name,detail});saveState();},'Quantidade ou observação');
    if (action === 'add-upgrade') return promptSimple('Novo aprimoramento','Nome','Ex.: Contatos',(name,detail)=>{sheet().upgrades.push({name,detail});saveState();},'Nível, custo ou efeito');
    if (action === 'add-power') return promptSimple('Novo poder','Nome','Ex.: Sentidos ampliados',(name,detail)=>{sheet().powers.push({name,detail});saveState();},'Efeito');
    if (action === 'add-weakness') return promptSimple('Nova fraqueza','Nome','Ex.: Vulnerável à prata',(name,detail)=>{sheet().weaknesses.push({name,detail});saveState();},'Efeito');
    if (action === 'hp-minus') { const s=sheet(); s.combat.hp=Math.max(0,s.combat.hp-1);s.updatedAt=Date.now();saveState();return renderSheet(); }
    if (action === 'hp-plus') { const s=sheet(); s.combat.hp=Math.min(s.combat.hpMax,s.combat.hp+1);s.updatedAt=Date.now();saveState();return renderSheet(); }
    if (action === 'resource-minus' || action === 'resource-plus') {
      const s=sheet(); const key=el.dataset.resource;
      if (!s?.reserves || !['heroPoints','magicPoints'].includes(key)) return;
      const delta=action === 'resource-plus' ? 1 : -1;
      s.reserves[key]=Math.max(0,(Number(s.reserves[key])||0)+delta);s.updatedAt=Date.now();saveState();return renderSheet();
    }

    const removeMap = { 'remove-attack':['combat','attacks'],'remove-magic':[null,'magic'],'remove-inventory':[null,'inventory'],'remove-upgrade':[null,'upgrades'],'remove-power':[null,'powers'],'remove-weakness':[null,'weaknesses'] };
    if (removeMap[action]) { const s=sheet(); const [parent,key]=removeMap[action]; const list=parent?s[parent][key]:s[key]; list.splice(Number(el.dataset.index),1);saveState();return renderSheet(); }

    if (action === 'master-tab') { ui.masterTab=el.dataset.tab; return renderMasterDashboard(); }
    if (action === 'master-open-sheet') { ui.sheetId=el.dataset.sheet; ui.role='master'; ui.sheetMode=el.dataset.mode || 'play'; return renderSheet(); }
    if (action === 'back-master-dashboard') { ui.sheetId=null; ui.role='master'; return renderMasterDashboard(); }
    if (action === 'give-points') return givePointsModal(campaign().sheets[el.dataset.sheet]);
    if (action === 'master-hp') return adjustMasterHpModal(campaign().sheets[el.dataset.sheet]);
    if (action === 'save-rules') {
      const c=campaign(); document.querySelectorAll('[data-rule]').forEach(inp=>{ const k=inp.dataset.rule; c.rules[k]=inp.type==='number'?Number(inp.value):inp.value; }); saveState(); toast('Regras salvas.'); return renderMasterDashboard();
    }
    if (action === 'reset-rules') { campaign().rules=defaultRules(); saveState(); toast('Regras restauradas.'); return renderMasterDashboard(); }
  });

  document.addEventListener('submit', e => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    e.preventDefault();
    const fd = new FormData(form);

    if (form.id === 'join-form') {
      reloadState();
      const code=String(fd.get('code')||'').trim().toUpperCase();
      const c=Object.values(state.campaigns).find(x=>String(x.code||'').toUpperCase()===code);
      if(!c){toast('Mesa não encontrada. Atualize a página do mestre e confirme o código.');return;}
      const s=newSheet(String(fd.get('owner')||''),String(fd.get('character')||''),c.id);
      c.sheets[s.id]=s; saveState(); closeModal(); ui.role='player';ui.campaignId=c.id;ui.sheetId=s.id;ui.sheetMode='edit';renderSheet();return;
    }
    if (form.id === 'master-create-sheet-form') {
      const c=campaign(); if(!c) return;
      const s=newSheet(String(fd.get('owner')||''),String(fd.get('character')||''),c.id);
      c.sheets[s.id]=s; saveState(); closeModal(); ui.role='master';ui.sheetId=s.id;ui.sheetMode='edit';renderSheet();return;
    }
    if (form.id === 'create-table-form') {
      reloadState();
      const c=newCampaign(String(fd.get('name')||''),String(fd.get('master')||''),String(fd.get('pin')||''));
      state.campaigns[c.id]=c;saveState();closeModal();ui.role='master';ui.campaignId=c.id;ui.masterTab='overview';renderMasterDashboard();return;
    }
    if (form.id === 'master-login-form') {
      const c=state.campaigns[form.dataset.campaign];
      if(String(fd.get('pin'))!==String(c.masterPin)){toast('PIN incorreto.');return;}
      closeModal();ui.role='master';ui.campaignId=c.id;ui.masterTab='overview';renderMasterDashboard();return;
    }
    if (form.id === 'spend-skill-form') {
      const s=sheet(),c=campaign();const points=Math.max(1,Number(fd.get('points'))||1);const sk=s.skills.find(x=>x.id===fd.get('skill'));
      if(!sk||points>s.reserves.skillPoints)return;
      sk.value=Math.min(c.rules.maxSkill, sk.value + points*c.rules.skillPointRate);s.reserves.skillPoints-=points;saveState();closeModal();renderSheet();return;
    }
    if (form.id === 'attributes-form') {
      const s=sheet();ATTRIBUTES.forEach(([k])=>s.attributes[k]=Math.max(1,Number(fd.get(k))||1));saveState();closeModal();renderSheet();return;
    }
    if (form.id === 'combat-form') {
      const s=sheet(); ['hpMax','initiative','defense','armor','damageBonus'].forEach(k=>s.combat[k]=Number(fd.get(k))||0);s.combat.hp=Math.min(s.combat.hp,s.combat.hpMax);saveState();closeModal();renderSheet();return;
    }
    if (form.id === 'give-points-form') {
      const c=campaign(); const s=c.sheets[form.dataset.sheet]; const type=fd.get('type'); const amount=Math.max(1,Number(fd.get('amount'))||1); s.reserves[type]=(s.reserves[type]||0)+amount;saveState();closeModal();toast(`${amount} ponto(s) concedido(s) a ${s.name}.`);renderMasterDashboard();return;
    }
    if (form.id === 'master-hp-form') {
      const s=campaign().sheets[form.dataset.sheet];s.combat.hpMax=Math.max(1,Number(fd.get('hpMax'))||1);s.combat.hp=Math.max(0,Math.min(s.combat.hpMax,Number(fd.get('hp'))||0));saveState();closeModal();renderMasterDashboard();return;
    }
  });

  document.addEventListener('input', e => {
    const target=e.target;
    const s=sheet(); if(!s) return;
    if(target.matches('[data-bind]')) { const key=target.dataset.bind;s[key]=target.value;s.updatedAt=Date.now();saveState(); }
    if(target.matches('[data-bind-combat]')) { const key=target.dataset.bindCombat;s.combat[key]=Math.max(0,Math.min(s.combat.hpMax,Number(target.value)||0));s.updatedAt=Date.now();saveState(); }
  });

  window.addEventListener('keydown', e => { if(e.key==='Escape') closeModal(); });

  window.addEventListener('storage', e => {
    if (e.key === STORAGE_KEY) renderCurrentViewAfterSync();
  });
  syncChannel?.addEventListener('message', e => {
    if (e.data?.type === 'state-updated') renderCurrentViewAfterSync();
  });
  window.addEventListener('focus', () => {
    if (ui.role) renderCurrentViewAfterSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ui.role) renderCurrentViewAfterSync();
  });

  renderHub();
})();
