(() => {
  'use strict';

  const STORAGE_KEY = 'fichas-daemon-state-v2';
  const DEVICE_KEY = 'fichas-daemon-device-v1';
  const app = document.querySelector('#app');
  const modalRoot = document.querySelector('#modal-root');
  const toastRoot = document.querySelector('#toast-root');
  const syncChannel = 'BroadcastChannel' in window ? new BroadcastChannel('fichas-daemon-sync-v1') : null;


  // =========================================================
  // SUPABASE / MODO ONLINE
  // =========================================================
  const SUPABASE_CONFIG = window.DAEMON_SUPABASE_CONFIG || {};
  const online = {
    enabled: Boolean(SUPABASE_CONFIG.url && SUPABASE_CONFIG.publishableKey && window.supabase?.createClient),
    client: null,
    user: null,
    ready: false,
    error: null,
    saveTimer: null,
    refreshTimer: null,
    pendingRefresh: false,
    channel: null
  };

  function currentOwnerId() {
    return online.user?.id || deviceId();
  }

  function onlineStatusLabel() {
    if (online.ready) return '● Online · Supabase · v9';
    if (online.enabled && online.error) return `● Supabase indisponível: ${online.error}`;
    if (online.enabled) return '● Conectando ao Supabase…';
    return '● Modo local';
  }

  function requireOnline() {
    if (!online.enabled) return true;
    if (online.ready) return true;
    toast(online.error ? `Supabase: ${online.error}` : 'Ainda conectando ao Supabase. Tente novamente em alguns segundos.');
    return false;
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  function toServerSheetData(s) {
    const data = cloneJson(s || {});
    // Estes campos são reconstruídos a partir das colunas protegidas do banco.
    delete data.id;
    delete data.campaignId;
    delete data.ownerDeviceId;
    delete data.isLocked;
    return data;
  }

  function sheetRow(s, roomId) {
    normalizeSheet(s);
    return {
      room_id: roomId,
      owner_id: s.ownerDeviceId === null ? null : (s.ownerDeviceId || currentOwnerId()),
      name: s.name || 'Novo personagem',
      level: Math.max(1, Number(String(s.level || '').match(/\d+/)?.[0] || 1)),
      hp_current: Math.max(0, Number(s.combat?.hp) || 0),
      hp_max: Math.max(0, Number(s.combat?.hpMax) || 0),
      hero_points: Math.max(0, Number(s.reserves?.heroPoints) || 0),
      magic_points: Math.max(0, Number(s.reserves?.magicPoints) || 0),
      skill_points: Math.max(0, Number(s.reserves?.skillPoints) || 0),
      upgrade_points: Math.max(0, Number(s.reserves?.upgradePoints) || 0),
      sheet_data: toServerSheetData(s),
      locked: Boolean(s.isLocked)
    };
  }

  async function persistSheetOnline(s, roomId = ui.campaignId) {
    if (!online.ready || !s || !roomId || !isUuid(s.id)) return;
    const row = sheetRow(s, roomId);
    const { error } = await online.client.from('characters').update(row).eq('id', s.id);
    if (error) console.error('Falha ao sincronizar ficha:', error);
  }

  async function persistRoomOnline(c) {
    if (!online.ready || !c?.id || !c.isMaster) return;
    const { error } = await online.client.from('rooms').update({ rules: c.rules || {} }).eq('id', c.id);
    if (error) console.error('Falha ao sincronizar regras:', error);
  }

  function scheduleOnlinePersist() {
    if (!online.ready) return;
    clearTimeout(online.saveTimer);
    online.saveTimer = setTimeout(async () => {
      const c = campaign();
      const s = sheet();
      try {
        if (c?.isMaster) await persistRoomOnline(c);
        if (s) await persistSheetOnline(s, c?.id);
      } catch (err) {
        console.error(err);
      }
    }, 300);
  }

  async function saveOnlineRoll(log, s) {
    if (!online.ready || !log || !s || !ui.campaignId || !isUuid(s.id)) return;
    const { error } = await online.client.from('rolls').insert({
      room_id: ui.campaignId,
      character_id: s.id,
      user_id: online.user.id,
      label: log.label,
      target: Number(log.target) || 0,
      result: Number(log.roll) || 0,
      outcome: log.result || ''
    });
    if (error) console.error('Falha ao salvar rolagem:', error);
  }

  async function createOnlineCharacter(roomId, ownerName, characterName, ownerId = online.user?.id, allowUnassigned = false) {
    if (!online.ready || !roomId) throw new Error('Supabase não conectado.');
    if (!ownerId && !allowUnassigned) throw new Error('Jogador não identificado.');
    const draft = newSheet(ownerName || (ownerId ? 'Jogador' : 'Aguardando jogador'), characterName, roomId);
    draft.ownerDeviceId = ownerId || null;
    const row = sheetRow(draft, roomId);
    const { data, error } = await online.client
      .from('characters')
      .insert(row)
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  async function hydrateOnlineState() {
    if (!online.ready) return state;

    const { data: rooms, error: roomError } = await online.client
      .from('rooms')
      .select('*')
      .order('created_at', { ascending: false });
    if (roomError) throw roomError;

    const ids = (rooms || []).map(r => r.id);
    let members = [], chars = [], rolls = [];
    if (ids.length) {
      const [m, ch, ro] = await Promise.all([
        online.client.from('room_members').select('*').in('room_id', ids),
        online.client.from('characters').select('*').in('room_id', ids).order('updated_at', { ascending: false }),
        online.client.from('rolls').select('*').in('room_id', ids).order('created_at', { ascending: false }).limit(200)
      ]);
      if (m.error) throw m.error;
      if (ch.error) throw ch.error;
      if (ro.error) throw ro.error;
      members = m.data || [];
      chars = ch.data || [];
      rolls = ro.data || [];
    }

    const next = freshState();
    const memberMap = new Map();
    members.forEach(m => memberMap.set(`${m.room_id}:${m.user_id}`, m));

    (rooms || []).forEach(r => {
      const masterMember = members.find(m => m.room_id === r.id && m.role === 'master');
      next.campaigns[r.id] = {
        id: r.id,
        name: r.name,
        code: r.invite_code,
        masterName: masterMember?.display_name || 'Mestre',
        masterPin: '',
        masterId: r.master_id,
        isMaster: r.master_id === online.user.id,
        rules: { ...defaultRules(), ...(r.rules || {}) },
        members: members.filter(m => m.room_id === r.id),
        sheets: {},
        logs: [],
        createdAt: Date.parse(r.created_at || '') || Date.now()
      };
    });

    chars.forEach(row => {
      const c = next.campaigns[row.room_id];
      if (!c) return;
      const member = memberMap.get(`${row.room_id}:${row.owner_id}`);
      const d = row.sheet_data && typeof row.sheet_data === 'object' ? cloneJson(row.sheet_data) : {};
      const s = normalizeSheet({
        ...d,
        id: row.id,
        campaignId: row.room_id,
        ownerDeviceId: row.owner_id ?? null,
        ownerName: member?.display_name || d.ownerName || (row.owner_id ? 'Jogador' : 'Aguardando jogador'),
        name: row.name || d.name || 'Personagem',
        level: d.level || String(row.level || 1),
        isLocked: Boolean(row.locked),
        createdAt: Date.parse(row.created_at || '') || Date.now(),
        updatedAt: Date.parse(row.updated_at || '') || Date.now()
      });
      s.combat.hp = Number(row.hp_current ?? s.combat.hp ?? 0);
      s.combat.hpMax = Number(row.hp_max ?? s.combat.hpMax ?? 0);
      s.reserves.heroPoints = Number(row.hero_points ?? s.reserves.heroPoints ?? 0);
      s.reserves.magicPoints = Number(row.magic_points ?? s.reserves.magicPoints ?? 0);
      s.reserves.skillPoints = Number(row.skill_points ?? s.reserves.skillPoints ?? 0);
      s.reserves.upgradePoints = Number(row.upgrade_points ?? s.reserves.upgradePoints ?? 0);
      c.sheets[s.id] = s;
    });

    rolls.forEach(row => {
      const c = next.campaigns[row.room_id];
      if (!c) return;
      const s = c.sheets[row.character_id];
      c.logs.push({
        id: String(row.id),
        character: s?.name || 'Personagem',
        label: row.label,
        roll: row.result,
        target: row.target,
        result: row.outcome || '',
        at: Date.parse(row.created_at || '') || Date.now()
      });
    });

    state = normalizeStateShape(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  function scheduleOnlineRefresh() {
    if (!online.ready) return;
    const active = document.activeElement;
    if (active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName)) {
      online.pendingRefresh = true;
      return;
    }
    clearTimeout(online.refreshTimer);
    online.refreshTimer = setTimeout(async () => {
      try {
        await hydrateOnlineState();
        renderCurrentViewAfterSync();
      } catch (err) {
        console.error('Falha ao atualizar dados online:', err);
      }
    }, 180);
  }

  function subscribeOnline() {
    if (!online.ready || online.channel) return;
    online.channel = online.client
      .channel(`fichas-daemon-${online.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'characters' }, scheduleOnlineRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members' }, scheduleOnlineRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, scheduleOnlineRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rolls' }, scheduleOnlineRefresh)
      .subscribe();
  }

  async function bootOnline() {
    app.innerHTML = `<main class="hub"><div class="hub-panel"><div class="brand-mark big">D</div><h1 class="hub-title">Fichas Daemon</h1><p class="hub-copy">Conectando a mesa online…</p></div></main>`;
    if (!online.enabled) {
      renderHub();
      return;
    }
    try {
      online.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      let { data: { session }, error } = await online.client.auth.getSession();
      if (error) throw error;
      if (!session) {
        const signed = await online.client.auth.signInAnonymously();
        if (signed.error) throw signed.error;
        session = signed.data.session;
      }
      online.user = session?.user || null;
      if (!online.user) throw new Error('Não foi possível criar a sessão anônima.');
      online.ready = true;
      await hydrateOnlineState();
      subscribeOnline();
      setInterval(() => { if (online.ready) scheduleOnlineRefresh(); }, 7000);
      renderHub();
    } catch (err) {
      online.error = err?.message || String(err);
      online.ready = false;
      console.error('Supabase:', err);
      renderHub();
      setTimeout(() => toast(`Supabase: ${online.error}. Confira se Anonymous Sign-Ins está ativado.`), 250);
    }
  }

  const ATTRIBUTES = [
    ['con', 'Constituição'], ['fr', 'Força'], ['dex', 'Destreza'], ['agi', 'Agilidade'],
    ['int', 'Inteligência'], ['will', 'Força de Vontade'], ['per', 'Percepção'], ['car', 'Carisma']
  ];

  const DEFAULT_SKILLS = [];

  const SKILL_CATALOG = [{"id":"idiomas-nativo","category":"Idiomas","name":"Nativo","base":30,"combat":false},{"id":"animais-tratamento-de-animais","category":"Animais","name":"Tratamento de Animais","base":"int","combat":false},{"id":"animais-treinamento-de-animais","category":"Animais","name":"Treinamento de Animais","base":0,"combat":false},{"id":"animais-doma","category":"Animais","name":"Doma","base":0,"combat":false},{"id":"animais-veterinria","category":"Animais","name":"Veterinária","base":0,"combat":false},{"id":"geral-armadilhas","category":"Geral","name":"Armadilhas","base":"per","combat":false},{"id":"armas-brancas-adagas","category":"Armas Brancas","name":"Adagas","base":"dex","combat":true},{"id":"armas-brancas-espadas","category":"Armas Brancas","name":"Espadas","base":"dex","combat":true},{"id":"armas-brancas-machados","category":"Armas Brancas","name":"Machados","base":"dex","combat":true},{"id":"armas-brancas-chicotes","category":"Armas Brancas","name":"Chicotes","base":"dex","combat":true},{"id":"armas-brancas-manguais","category":"Armas Brancas","name":"Manguais","base":"dex","combat":true},{"id":"armas-brancas-maas","category":"Armas Brancas","name":"Maças","base":"dex","combat":true},{"id":"armas-brancas-martelos","category":"Armas Brancas","name":"Martelos","base":"dex","combat":true},{"id":"armas-brancas-arcos","category":"Armas Brancas","name":"Arcos","base":"dex","combat":true},{"id":"armas-brancas-bestas","category":"Armas Brancas","name":"Bestas","base":"dex","combat":true},{"id":"armas-brancas-lanas","category":"Armas Brancas","name":"Lanças","base":"dex","combat":true},{"id":"armas-brancas-armas-exticas","category":"Armas Brancas","name":"Armas Exóticas","base":"dex","combat":true},{"id":"armas-de-fogo-revlveres","category":"Armas de Fogo","name":"Revólveres","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-pistolas","category":"Armas de Fogo","name":"Pistolas","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-armas-antigas","category":"Armas de Fogo","name":"Armas Antigas","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-submetralhadoras","category":"Armas de Fogo","name":"Submetralhadoras","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-escopetas","category":"Armas de Fogo","name":"Escopetas","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-espingardas-rifles-de-caa","category":"Armas de Fogo","name":"Espingardas / Rifles de Caça","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-rifles-militares","category":"Armas de Fogo","name":"Rifles Militares","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-metralhadoras","category":"Armas de Fogo","name":"Metralhadoras","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-armas-pesadas","category":"Armas de Fogo","name":"Armas Pesadas","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-granadas-lana-granadas","category":"Armas de Fogo","name":"Granadas / Lança-Granadas","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"armas-de-fogo-armas-experimentais","category":"Armas de Fogo","name":"Armas Experimentais","base":"dex","combat":true,"requirement":"Aprimoramento Armas de Fogo"},{"id":"artes-arquitetura","category":"Artes","name":"Arquitetura","base":0,"combat":false},{"id":"artes-atuao","category":"Artes","name":"Atuação","base":"car","combat":false},{"id":"artes-canto","category":"Artes","name":"Canto","base":"car","combat":false},{"id":"artes-crtica-de-arte","category":"Artes","name":"Crítica de Arte","base":"per","combat":false},{"id":"artes-culinria","category":"Artes","name":"Culinária","base":"per","combat":false},{"id":"artes-dana","category":"Artes","name":"Dança","base":"agi","combat":false},{"id":"artes-desenho-e-pintura","category":"Artes","name":"Desenho e Pintura","base":"dex","combat":false},{"id":"artes-escapismo","category":"Artes","name":"Escapismo","base":"agi","combat":false},{"id":"artes-escultura","category":"Artes","name":"Escultura","base":"dex","combat":false},{"id":"artes-fotografia","category":"Artes","name":"Fotografia","base":"per","combat":false},{"id":"artes-ilusionismo","category":"Artes","name":"Ilusionismo","base":"dex","combat":false},{"id":"artes-instrumentos-musicais","category":"Artes","name":"Instrumentos Musicais","base":"dex","combat":false},{"id":"artes-joalheria","category":"Artes","name":"Joalheria","base":"dex","combat":false},{"id":"artes-prestidigitao","category":"Artes","name":"Prestidigitação","base":"dex","combat":false},{"id":"artes-redao","category":"Artes","name":"Redação","base":"int","combat":false},{"id":"artfice-carpintaria","category":"Artífice","name":"Carpintaria","base":"dex","combat":false},{"id":"artfice-costura","category":"Artífice","name":"Costura","base":"dex","combat":false},{"id":"artfice-marcenaria","category":"Artífice","name":"Marcenaria","base":"dex","combat":false},{"id":"artfice-metalurgia","category":"Artífice","name":"Metalurgia","base":"dex","combat":false},{"id":"artfice-cermica","category":"Artífice","name":"Cerâmica","base":"dex","combat":false},{"id":"avaliao-de-objetos-antiguidades","category":"Avaliação de Objetos","name":"Antiguidades","base":"per","combat":false},{"id":"avaliao-de-objetos-gemas","category":"Avaliação de Objetos","name":"Gemas","base":"per","combat":false},{"id":"avaliao-de-objetos-metais-valiosos","category":"Avaliação de Objetos","name":"Metais Valiosos","base":"per","combat":false},{"id":"avaliao-de-objetos-obras-de-arte","category":"Avaliação de Objetos","name":"Obras de Arte","base":"per","combat":false},{"id":"geral-camuflagem","category":"Geral","name":"Camuflagem","base":"per","combat":false},{"id":"cincias-agricultura","category":"Ciências","name":"Agricultura","base":"int","combat":false},{"id":"cincias-anatomia","category":"Ciências","name":"Anatomia","base":"int","combat":false},{"id":"cincias-antropologia","category":"Ciências","name":"Antropologia","base":"int","combat":false},{"id":"cincias-arqueologia","category":"Ciências","name":"Arqueologia","base":"int","combat":false},{"id":"cincias-astronomia","category":"Ciências","name":"Astronomia","base":"int","combat":false},{"id":"cincias-botnica","category":"Ciências","name":"Botânica","base":"int","combat":false},{"id":"cincias-direito-jurisprudncia","category":"Ciências","name":"Direito / Jurisprudência","base":"int","combat":false},{"id":"cincias-ecologia","category":"Ciências","name":"Ecologia","base":"int","combat":false},{"id":"cincias-filosofia","category":"Ciências","name":"Filosofia","base":"int","combat":false},{"id":"cincias-fsica","category":"Ciências","name":"Física","base":"int","combat":false},{"id":"cincias-gentica","category":"Ciências","name":"Genética","base":"int","combat":false},{"id":"cincias-geografia","category":"Ciências","name":"Geografia","base":"int","combat":false},{"id":"cincias-geologia","category":"Ciências","name":"Geologia","base":"int","combat":false},{"id":"cincias-herldica","category":"Ciências","name":"Heráldica","base":"int","combat":false},{"id":"cincias-herbalismo","category":"Ciências","name":"Herbalismo","base":"int","combat":false},{"id":"cincias-histria","category":"Ciências","name":"História","base":"int","combat":false},{"id":"cincias-literatura","category":"Ciências","name":"Literatura","base":"int","combat":false},{"id":"cincias-matemtica","category":"Ciências","name":"Matemática","base":"int","combat":false},{"id":"cincias-meteorologia","category":"Ciências","name":"Meteorologia","base":"int","combat":false},{"id":"cincias-pedagogia","category":"Ciências","name":"Pedagogia","base":"int","combat":false},{"id":"cincias-psicologia","category":"Ciências","name":"Psicologia","base":"int","combat":false},{"id":"cincias-qumica","category":"Ciências","name":"Química","base":"int","combat":false},{"id":"cincias-sociologia","category":"Ciências","name":"Sociologia","base":"int","combat":false},{"id":"cincias-teologia-religio","category":"Ciências","name":"Teologia / Religião","base":"int","combat":false},{"id":"cincias-ufologia","category":"Ciências","name":"Ufologia","base":"int","combat":false},{"id":"cincias-zoologia","category":"Ciências","name":"Zoologia","base":"int","combat":false},{"id":"cincias-proibidas-alquimia","category":"Ciências Proibidas","name":"Alquimia","base":0,"combat":false},{"id":"cincias-proibidas-anjos","category":"Ciências Proibidas","name":"Anjos","base":0,"combat":false},{"id":"cincias-proibidas-astrologia","category":"Ciências Proibidas","name":"Astrologia","base":0,"combat":false},{"id":"cincias-proibidas-bzios","category":"Ciências Proibidas","name":"Búzios","base":0,"combat":false},{"id":"cincias-proibidas-demnios","category":"Ciências Proibidas","name":"Demônios","base":0,"combat":false},{"id":"cincias-proibidas-oculto","category":"Ciências Proibidas","name":"Oculto","base":0,"combat":false},{"id":"cincias-proibidas-psionicismo","category":"Ciências Proibidas","name":"Psionicismo","base":0,"combat":false},{"id":"cincias-proibidas-rituais","category":"Ciências Proibidas","name":"Rituais","base":0,"combat":false},{"id":"cincias-proibidas-tarot","category":"Ciências Proibidas","name":"Tarot","base":0,"combat":false},{"id":"cincias-proibidas-teoria-da-magia","category":"Ciências Proibidas","name":"Teoria da Magia","base":0,"combat":false},{"id":"cincias-proibidas-vampiros","category":"Ciências Proibidas","name":"Vampiros","base":0,"combat":false},{"id":"cincias-proibidas-viagem-astral","category":"Ciências Proibidas","name":"Viagem Astral","base":0,"combat":false},{"id":"conduo-pilotagem-automvel","category":"Condução / Pilotagem","name":"Automóvel","base":"agi","combat":false},{"id":"conduo-pilotagem-nibus","category":"Condução / Pilotagem","name":"Ônibus","base":"agi","combat":false},{"id":"conduo-pilotagem-caminho","category":"Condução / Pilotagem","name":"Caminhão","base":"agi","combat":false},{"id":"conduo-pilotagem-empilhadeira","category":"Condução / Pilotagem","name":"Empilhadeira","base":"agi","combat":false},{"id":"conduo-pilotagem-guindaste","category":"Condução / Pilotagem","name":"Guindaste","base":"agi","combat":false},{"id":"conduo-pilotagem-carruagem","category":"Condução / Pilotagem","name":"Carruagem","base":"agi","combat":false},{"id":"conduo-pilotagem-motocicleta","category":"Condução / Pilotagem","name":"Motocicleta","base":"agi","combat":false},{"id":"conduo-pilotagem-carro-de-corrida","category":"Condução / Pilotagem","name":"Carro de Corrida","base":"agi","combat":false},{"id":"conduo-pilotagem-motocicleta-de-corrida","category":"Condução / Pilotagem","name":"Motocicleta de Corrida","base":"agi","combat":false},{"id":"conduo-pilotagem-helicptero","category":"Condução / Pilotagem","name":"Helicóptero","base":"agi","combat":false},{"id":"conduo-pilotagem-avio-comercial","category":"Condução / Pilotagem","name":"Avião Comercial","base":"agi","combat":false},{"id":"conduo-pilotagem-avio-militar","category":"Condução / Pilotagem","name":"Avião Militar","base":"agi","combat":false},{"id":"conduo-pilotagem-nibus-espacial","category":"Condução / Pilotagem","name":"Ônibus Espacial","base":"agi","combat":false},{"id":"conduo-pilotagem-lancha","category":"Condução / Pilotagem","name":"Lancha","base":"agi","combat":false},{"id":"conduo-pilotagem-iate","category":"Condução / Pilotagem","name":"Iate","base":"agi","combat":false},{"id":"conduo-pilotagem-veleiro","category":"Condução / Pilotagem","name":"Veleiro","base":"agi","combat":false},{"id":"conduo-pilotagem-navio-cargueiro","category":"Condução / Pilotagem","name":"Navio Cargueiro","base":"agi","combat":false},{"id":"conduo-pilotagem-ultraleve","category":"Condução / Pilotagem","name":"Ultraleve","base":"agi","combat":false},{"id":"conduo-pilotagem-asa-delta","category":"Condução / Pilotagem","name":"Asa Delta","base":"agi","combat":false},{"id":"geral-disfarce","category":"Geral","name":"Disfarce","base":"int","combat":false},{"id":"geral-eletrnica","category":"Geral","name":"Eletrônica","base":0,"combat":false},{"id":"engenharia-aeronutica","category":"Engenharia","name":"Aeronáutica","base":0,"combat":false},{"id":"engenharia-alimentos","category":"Engenharia","name":"Alimentos","base":0,"combat":false},{"id":"engenharia-civil","category":"Engenharia","name":"Civil","base":0,"combat":false},{"id":"engenharia-computao","category":"Engenharia","name":"Computação","base":0,"combat":false},{"id":"engenharia-demolies","category":"Engenharia","name":"Demolições","base":0,"combat":false},{"id":"engenharia-eltrica","category":"Engenharia","name":"Elétrica","base":0,"combat":false},{"id":"engenharia-eletrnica","category":"Engenharia","name":"Eletrônica","base":0,"combat":false},{"id":"engenharia-materiais","category":"Engenharia","name":"Materiais","base":0,"combat":false},{"id":"engenharia-mecnica","category":"Engenharia","name":"Mecânica","base":0,"combat":false},{"id":"engenharia-mecatrnica","category":"Engenharia","name":"Mecatrônica","base":0,"combat":false},{"id":"engenharia-naval","category":"Engenharia","name":"Naval","base":0,"combat":false},{"id":"engenharia-qumica","category":"Engenharia","name":"Química","base":0,"combat":false},{"id":"geral-escutar","category":"Geral","name":"Escutar","base":"per","combat":false},{"id":"combate-esquiva","category":"Combate","name":"Esquiva","base":"agi","combat":true},{"id":"esportes-acrobacia","category":"Esportes","name":"Acrobacia","base":"agi","combat":false},{"id":"esportes-alpinismo","category":"Esportes","name":"Alpinismo","base":"agi","combat":false},{"id":"esportes-arremesso","category":"Esportes","name":"Arremesso","base":"dex","combat":false},{"id":"esportes-basquete","category":"Esportes","name":"Basquete","base":"dex","combat":false},{"id":"esportes-boxe","category":"Esportes","name":"Boxe","base":"agi","combat":true},{"id":"esportes-caa","category":"Esportes","name":"Caça","base":"per","combat":false},{"id":"esportes-canoagem","category":"Esportes","name":"Canoagem","base":"con","combat":false},{"id":"esportes-corrida","category":"Esportes","name":"Corrida","base":"con","combat":false},{"id":"esportes-esqui","category":"Esportes","name":"Esqui","base":"agi","combat":false},{"id":"esportes-futebol","category":"Esportes","name":"Futebol","base":"agi","combat":false},{"id":"esportes-mergulho","category":"Esportes","name":"Mergulho","base":"con","combat":false},{"id":"esportes-natao","category":"Esportes","name":"Natação","base":"agi","combat":false},{"id":"esportes-paraquedismo","category":"Esportes","name":"Paraquedismo","base":"agi","combat":false},{"id":"esportes-pesca","category":"Esportes","name":"Pesca","base":"per","combat":false},{"id":"esportes-salto-ornamental","category":"Esportes","name":"Salto Ornamental","base":"agi","combat":false},{"id":"esportes-tnis","category":"Esportes","name":"Tênis","base":"dex","combat":false},{"id":"esportes-voleibol","category":"Esportes","name":"Voleibol","base":"dex","combat":false},{"id":"etiqueta-clero","category":"Etiqueta","name":"Clero","base":"car","combat":false},{"id":"etiqueta-comercial","category":"Etiqueta","name":"Comercial","base":"car","combat":false},{"id":"etiqueta-diplomacia","category":"Etiqueta","name":"Diplomacia","base":"car","combat":false},{"id":"etiqueta-mercado-negro","category":"Etiqueta","name":"Mercado Negro","base":"car","combat":false},{"id":"etiqueta-nobreza","category":"Etiqueta","name":"Nobreza","base":"car","combat":false},{"id":"etiqueta-submundo","category":"Etiqueta","name":"Submundo","base":"car","combat":false},{"id":"geral-explosivos","category":"Geral","name":"Explosivos","base":0,"combat":false},{"id":"falsificao-documentos","category":"Falsificação","name":"Documentos","base":"int","combat":false},{"id":"falsificao-escultura","category":"Falsificação","name":"Escultura","base":"int","combat":false},{"id":"falsificao-fotografia","category":"Falsificação","name":"Fotografia","base":"int","combat":false},{"id":"falsificao-joalheria","category":"Falsificação","name":"Joalheria","base":"int","combat":false},{"id":"falsificao-pinturas","category":"Falsificação","name":"Pinturas","base":"int","combat":false},{"id":"geral-furtar","category":"Geral","name":"Furtar","base":"dex","combat":false},{"id":"geral-furtividade","category":"Geral","name":"Furtividade","base":"agi","combat":false},{"id":"idiomas-e-cdigos-braile","category":"Idiomas e Códigos","name":"Braile","base":0,"combat":false},{"id":"idiomas-e-cdigos-cdigo-morse","category":"Idiomas e Códigos","name":"Código Morse","base":0,"combat":false},{"id":"idiomas-e-cdigos-criptografia","category":"Idiomas e Códigos","name":"Criptografia","base":0,"combat":false},{"id":"idiomas-e-cdigos-linguagem-de-sinais","category":"Idiomas e Códigos","name":"Linguagem de Sinais","base":0,"combat":false},{"id":"idiomas-e-cdigos-leitura-labial","category":"Idiomas e Códigos","name":"Leitura Labial","base":0,"combat":false},{"id":"informtica-computao","category":"Informática","name":"Computação","base":0,"combat":false},{"id":"informtica-internet","category":"Informática","name":"Internet","base":0,"combat":false},{"id":"informtica-hacker","category":"Informática","name":"Hacker","base":0,"combat":false},{"id":"informtica-manuteno","category":"Informática","name":"Manutenção","base":0,"combat":false},{"id":"informtica-programao","category":"Informática","name":"Programação","base":0,"combat":false},{"id":"jogos-cartas","category":"Jogos","name":"Cartas","base":"per","combat":false},{"id":"jogos-dados","category":"Jogos","name":"Dados","base":"dex","combat":false},{"id":"jogos-tabuleiro","category":"Jogos","name":"Tabuleiro","base":"int","combat":false},{"id":"jogos-videogame","category":"Jogos","name":"Videogame","base":"dex","combat":false},{"id":"jogos-rpg","category":"Jogos","name":"RPG","base":"int","combat":false},{"id":"manipulao-empatia","category":"Manipulação","name":"Empatia","base":"car","combat":false},{"id":"manipulao-hipnose","category":"Manipulação","name":"Hipnose","base":0,"combat":false},{"id":"manipulao-impressionar","category":"Manipulação","name":"Impressionar","base":"car","combat":false},{"id":"manipulao-interrogatrio","category":"Manipulação","name":"Interrogatório","base":"int","combat":false},{"id":"manipulao-intimidao","category":"Manipulação","name":"Intimidação","base":"will","combat":false},{"id":"manipulao-lbia","category":"Manipulação","name":"Lábia","base":"car","combat":false},{"id":"manipulao-liderana","category":"Manipulação","name":"Liderança","base":"car","combat":false},{"id":"manipulao-manha","category":"Manipulação","name":"Manha","base":"car","combat":false},{"id":"manipulao-seduo","category":"Manipulação","name":"Sedução","base":"car","combat":false},{"id":"manipulao-tortura","category":"Manipulação","name":"Tortura","base":"int","combat":false},{"id":"geral-manuseio-de-fechaduras","category":"Geral","name":"Manuseio de Fechaduras","base":0,"combat":false},{"id":"geral-mecnica","category":"Geral","name":"Mecânica","base":"dex","combat":false},{"id":"medicina-cirurgia","category":"Medicina","name":"Cirurgia","base":"dex","combat":false},{"id":"medicina-primeiros-socorros","category":"Medicina","name":"Primeiros Socorros","base":"int","combat":false},{"id":"medicina-oftalmologia","category":"Medicina","name":"Oftalmologia","base":"int","combat":false},{"id":"medicina-dermatologia","category":"Medicina","name":"Dermatologia","base":"int","combat":false},{"id":"medicina-psiquiatria","category":"Medicina","name":"Psiquiatria","base":"int","combat":false},{"id":"medicina-cardiologia","category":"Medicina","name":"Cardiologia","base":"int","combat":false},{"id":"medicina-neurologia","category":"Medicina","name":"Neurologia","base":"int","combat":false},{"id":"medicina-urologia","category":"Medicina","name":"Urologia","base":"int","combat":false},{"id":"medicina-ortopedia","category":"Medicina","name":"Ortopedia","base":"int","combat":false},{"id":"medicina-oncologia","category":"Medicina","name":"Oncologia","base":"int","combat":false},{"id":"medicina-gastroenterologia","category":"Medicina","name":"Gastroenterologia","base":"int","combat":false},{"id":"medicina-otorrinolaringologia","category":"Medicina","name":"Otorrinolaringologia","base":"int","combat":false},{"id":"minerao-cristais","category":"Mineração","name":"Cristais","base":0,"combat":false},{"id":"minerao-gemas","category":"Mineração","name":"Gemas","base":0,"combat":false},{"id":"minerao-metais","category":"Mineração","name":"Metais","base":0,"combat":false},{"id":"negociao-barganha","category":"Negociação","name":"Barganha","base":"car","combat":false},{"id":"negociao-burocracia","category":"Negociação","name":"Burocracia","base":"int","combat":false},{"id":"negociao-contabilidade","category":"Negociação","name":"Contabilidade","base":"int","combat":false},{"id":"negociao-marketing","category":"Negociação","name":"Marketing","base":"int","combat":false},{"id":"geral-pesquisa-investigao","category":"Geral","name":"Pesquisa / Investigação","base":"per","combat":false},{"id":"geral-procura","category":"Geral","name":"Procura","base":"per","combat":false},{"id":"rastreio-deserto","category":"Rastreio","name":"Deserto","base":"per","combat":false},{"id":"rastreio-floresta","category":"Rastreio","name":"Floresta","base":"per","combat":false},{"id":"rastreio-gelo","category":"Rastreio","name":"Gelo","base":"per","combat":false},{"id":"rastreio-montanha","category":"Rastreio","name":"Montanha","base":"per","combat":false},{"id":"rastreio-plancie","category":"Rastreio","name":"Planície","base":"per","combat":false},{"id":"rastreio-selva","category":"Rastreio","name":"Selva","base":"per","combat":false},{"id":"sobrevivncia-deserto","category":"Sobrevivência","name":"Deserto","base":"per","combat":false},{"id":"sobrevivncia-floresta","category":"Sobrevivência","name":"Floresta","base":"per","combat":false},{"id":"sobrevivncia-gelo","category":"Sobrevivência","name":"Gelo","base":"per","combat":false},{"id":"sobrevivncia-montanha","category":"Sobrevivência","name":"Montanha","base":"per","combat":false},{"id":"sobrevivncia-plancie","category":"Sobrevivência","name":"Planície","base":"per","combat":false},{"id":"sobrevivncia-selva","category":"Sobrevivência","name":"Selva","base":"per","combat":false},{"id":"combate-briga","category":"Combate","name":"Briga","base":"dex","combat":true},{"id":"artes-marciais-capoeira","category":"Artes Marciais","name":"Capoeira","base":"agi","combat":true},{"id":"artes-marciais-carate","category":"Artes Marciais","name":"Caratê","base":"agi","combat":true},{"id":"artes-marciais-judo","category":"Artes Marciais","name":"Judô","base":"dex","combat":true},{"id":"artes-marciais-jiu-jitsu","category":"Artes Marciais","name":"Jiu-Jitsu","base":"dex","combat":true},{"id":"artes-marciais-aikido","category":"Artes Marciais","name":"Aikido","base":"dex","combat":true},{"id":"artes-marciais-kung-fu","category":"Artes Marciais","name":"Kung Fu","base":"agi","combat":true},{"id":"artes-marciais-muay-thai","category":"Artes Marciais","name":"Muay Thai","base":"agi","combat":true},{"id":"artes-marciais-taekwondo","category":"Artes Marciais","name":"Taekwondo","base":"agi","combat":true}];

  const SECTIONS = [
    ['skills', 'Perícias'], ['attributes', 'Atributos'], ['reserves', 'Reservas'], ['combat', 'Combate'],
    ['magic', 'Magia'], ['inventory', 'Inventário'], ['upgrades', 'Aprimoramentos'], ['powers', 'Poderes e Fraquezas'],
    ['identity', 'Identidade'], ['notes', 'Anotações']
  ];

  const BASE_UPGRADES = [{"id":"afinidade-fadas","name":"Afinidade com Fadas","kind":"positive","variants":[{"cost":3,"label":"3 pontos","detail":"Sua presença não assusta fadas e outros seres de Arcádia; eles tendem a tratá-lo com mais naturalidade."},{"cost":4,"label":"4 pontos","detail":"Como acima, além de possuir um ou dois amigos entre os povos de Arcádia."},{"cost":5,"label":"5 pontos","detail":"Como acima, com vínculos mais fortes em Arcádia e um lugar seguro ou aliados recorrentes no reino feérico."}]},{"id":"afinidade-magia","name":"Afinidade com Magia","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Apenas para não-magos. O personagem possui afinidade com um Caminho de Magia escolhido e alguma proteção contra seus efeitos."}]},{"id":"alma-pura","name":"Alma Pura","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Para personagens de alma excepcionalmente pura. Entidades e magias demoníacas têm mais dificuldade para afetá-lo."}]},{"id":"ambidestria","name":"Ambidestria","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"O personagem usa as duas mãos com a mesma eficiência e evita as penalidades comuns por usar a mão secundária."}]},{"id":"amigo-fantasma","name":"Amigo Fantasma","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"Um antigo amigo morto permanece como espírito companheiro. É controlado pelo Mestre e pode ajudar ocasionalmente."}]},{"id":"anjo-guarda","name":"Anjo da Guarda","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"Um espírito guia acompanha o personagem e pode se comunicar com ele em sonhos."},{"cost":3,"label":"3 pontos","detail":"Além de orientar, o espírito também observa e protege o personagem de forma mais ativa quando necessário."}]},{"id":"armas-fogo","name":"Armas de Fogo","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O personagem possui revólveres e pistolas e acesso comum a esse tipo de arma."},{"cost":2,"label":"2 pontos","detail":"O acesso inclui submetralhadoras, carabinas, espingardas e armas automáticas ou restritas."},{"cost":3,"label":"3 pontos","detail":"O personagem tem acesso a metralhadoras pesadas, armamento militar e outras armas pesadas."}]},{"id":"arma-amuleto-magico","name":"Arma ou Amuleto Mágico","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O personagem possui um objeto mágico simples, com um efeito ou bônus pequeno e bem definido."},{"cost":2,"label":"2 pontos","detail":"O objeto é mais poderoso e concede um efeito ou bônus mágico relevante, definido com o Mestre."},{"cost":3,"label":"3 pontos","detail":"O personagem conhece o ritual para criar itens mágicos e pode produzir os próprios objetos, com aprovação do Mestre."}]},{"id":"biblioteca","name":"Biblioteca","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Biblioteca com conhecimento em 2 subgrupos de perícias."},{"cost":2,"label":"2 pontos","detail":"Biblioteca com conhecimento em 6 subgrupos de perícias."},{"cost":3,"label":"3 pontos","detail":"Biblioteca com conhecimento em 10 subgrupos de perícias."},{"cost":4,"label":"4 pontos","detail":"Biblioteca com conhecimento em 14 subgrupos de perícias."},{"cost":5,"label":"5 pontos","detail":"Biblioteca com conhecimento em 20 subgrupos de perícias."}]},{"id":"bom-senso","name":"Bom Senso","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O Mestre pode alertar o jogador quando uma decisão for obviamente ruim ou suicida, especialmente útil para iniciantes."}]},{"id":"canalizador","name":"Canalizador","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"Para magos. Pode trocar 6 PV por 1 Ponto de Magia quando precisar."},{"cost":4,"label":"4 pontos","detail":"Para magos. Pode trocar 4 PV por 1 Ponto de Magia quando precisar."}]},{"id":"enxergar-auras","name":"Capaz de Enxergar Auras","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Com concentração e um teste de Percepção, o personagem percebe a aura de outras pessoas e indícios do estado espiritual delas."}]},{"id":"comunicacao-sonhos","name":"Comunicação com Sonhos","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"O personagem consegue se comunicar com outras pessoas enquanto elas dormem, por meio de sonhos."},{"cost":4,"label":"4 pontos","detail":"Além da comunicação onírica, possui contatos ou aliados no reino dos Sonhos, definidos com o Mestre."}]},{"id":"conhecimentos-arcanos","name":"Conhecimentos Arcanos","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"O personagem conhece métodos de prevenção e defesa contra magia e sabe interpretar sinais místicos ligados a cartas, runas, I Ching, Feng Shui, Tarot e afins."}]},{"id":"corpo-fechado","name":"Corpo Fechado","kind":"positive","variants":[{"cost":4,"label":"4 pontos","detail":"O personagem é especialmente resistente a efeitos sobrenaturais e tentativas místicas de afetar seu corpo, conforme definido com o Mestre."}]},{"id":"contatos-aliados","name":"Contatos e Aliados","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Um aliado importante que pode prestar ajuda dentro de sua área de influência."},{"cost":2,"label":"2 pontos","detail":"Dois aliados importantes."},{"cost":3,"label":"3 pontos","detail":"Quatro aliados importantes."},{"cost":4,"label":"4 pontos","detail":"Oito aliados importantes."}]},{"id":"deteccao-magia","name":"Detecção de Magia","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"Com um teste de Percepção, detecta presença de energia mágica ou mística em pessoa, objeto, criatura ou local."},{"cost":3,"label":"3 pontos","detail":"Além de detectar a magia, consegue estimar intensidade, distância e direção."}]},{"id":"familiares","name":"Familiares","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Um animal relativamente simples e comum acompanha o personagem."},{"cost":2,"label":"2 pontos","detail":"Um animal comum, mas maior, mais útil ou menos trivial de manter."},{"cost":3,"label":"3 pontos","detail":"Um animal raro, difícil de encontrar ou de grande porte."},{"cost":4,"label":"4 pontos","detail":"Uma criatura mística ou sobrenatural serve como familiar, com aprovação do Mestre."}]},{"id":"gremlins","name":"Gremlins","kind":"positive","variants":[{"cost":3,"label":"3 pontos","detail":"Um pequeno grupo de gremlins acompanha o personagem e pode sabotar equipamentos ou causar efeitos incomuns sob controle do Mestre."}]},{"id":"guardiao-artefato","name":"Guardião de Artefato","kind":"positive","variants":[{"cost":3,"label":"3 pontos","detail":"O personagem é guardião de um item de grande valor e poder. A escolha do artefato exige aprovação do Mestre."}]},{"id":"homunculo","name":"Homúnculo","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"O personagem possui um pequeno homúnculo obediente que pode cumprir tarefas simples, carregar objetos e auxiliá-lo."}]},{"id":"imunidade-venenos","name":"Imunidade a Venenos","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"Imune a venenos naturais e recebe proteção adicional contra venenos mágicos ou artificiais."},{"cost":3,"label":"3 pontos","detail":"Imune a venenos naturais e artificiais, além de receber proteção maior contra venenos mágicos."}]},{"id":"inocencia","name":"Inocência","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"A aparência ou comportamento inocente faz com que os outros tenham dificuldade em acreditar que o personagem cometeria certas ações."},{"cost":2,"label":"2 pontos","detail":"A inocência é ainda mais convincente; tentativas de acusá-lo ou tratá-lo como suspeito sofrem dificuldade maior."}]},{"id":"pactos","name":"Pactos","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O personagem possui um pacto com uma entidade poderosa. Benefícios e obrigações devem ser definidos em conjunto com o Mestre."}]},{"id":"poderes-angelicais","name":"Poderes Angelicais","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Acesso a 1 Poder Angelical, escolhido conforme as regras da campanha."},{"cost":2,"label":"2 pontos","detail":"Acesso a 3 Poderes Angelicais."},{"cost":3,"label":"3 pontos","detail":"Acesso a 5 Poderes Angelicais."},{"cost":4,"label":"4 pontos","detail":"Acesso a 7 Poderes Angelicais."}]},{"id":"poderes-demoniacos","name":"Poderes Demoníacos","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Acesso a 1 Poder Demoníaco, escolhido conforme as regras da campanha."},{"cost":2,"label":"2 pontos","detail":"Acesso a 3 Poderes Demoníacos."},{"cost":3,"label":"3 pontos","detail":"Acesso a 5 Poderes Demoníacos."},{"cost":4,"label":"4 pontos","detail":"Acesso a 7 Poderes Demoníacos."}]},{"id":"poderes-magicos","name":"Poderes Mágicos","kind":"positive","variants":[{"cost":1,"label":"1 ponto · Aprendiz","detail":"Obrigatório para magos. Possui 2 Pontos de Focus para distribuir entre Caminhos e começa com 1 Ponto de Magia."},{"cost":2,"label":"2 pontos · Mago","detail":"Pratica as artes arcanas há algum tempo. Começa com 3 Pontos de Focus e 2 Pontos de Magia."},{"cost":3,"label":"3 pontos · Mago desenvolvido","detail":"Possui 5 Pontos de Focus para distribuir entre Caminhos e Formas, 3 Pontos de Magia e um inimigo mortal definido com o Mestre."}]},{"id":"poderes-vampiricos","name":"Poderes Vampíricos","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Acesso a 1 Poder Vampírico da raça escolhida."},{"cost":2,"label":"2 pontos","detail":"Acesso a 3 Poderes Vampíricos da raça escolhida."},{"cost":3,"label":"3 pontos","detail":"Acesso a 5 Poderes Vampíricos da raça escolhida."}]},{"id":"pontos-heroicos","name":"Pontos Heroicos","kind":"positive","variants":[{"cost":1,"label":"1 ponto · Corajoso","detail":"Recebe 1 Ponto Heroico por nível."},{"cost":2,"label":"2 pontos · Valoroso","detail":"Recebe 2 Pontos Heroicos por nível."},{"cost":3,"label":"3 pontos · Intrépido","detail":"Recebe 3 Pontos Heroicos por nível."},{"cost":4,"label":"4 pontos · Herói","detail":"Recebe 4 Pontos Heroicos por nível."}]},{"id":"pontos-fe","name":"Pontos de Fé","kind":"positive","variants":[{"cost":1,"label":"1 ponto · Seguidor","detail":"Para clérigos ou paladinos. Começa com 1 Ponto de Fé e ganha +1 a cada 2 níveis."},{"cost":2,"label":"2 pontos · Fiel","detail":"Começa com 2 Pontos de Fé e ganha +1 a cada 2 níveis."},{"cost":3,"label":"3 pontos · Entusiasta","detail":"Começa com 3 Pontos de Fé e ganha +1 por nível."},{"cost":4,"label":"4 pontos · Fanático","detail":"Começa com 5 Pontos de Fé e ganha +1 por nível."}]},{"id":"recursos-dinheiro","name":"Recursos e Dinheiro","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Renda de referência de até US$ 2.000 mensais, ajustável à época e ao local da campanha."},{"cost":2,"label":"2 pontos","detail":"Renda de referência de até US$ 4.000 mensais."},{"cost":3,"label":"3 pontos","detail":"Renda de referência de até US$ 8.000 mensais."},{"cost":4,"label":"4 pontos","detail":"Renda de referência de até US$ 16.000 mensais."}]},{"id":"resistencia-magia","name":"Resistência à Magia","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Não pode ser comprado por personagens que usam Magia. Magias contra o personagem recebem redutor de 1D."},{"cost":3,"label":"3 pontos","detail":"Como acima, mas as magias contra o personagem recebem redutor de 2D."}]},{"id":"sabio","name":"Sábio","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Escolha uma perícia não-combate que o personagem domina profundamente. O Mestre pode ajudá-lo com informações e procedimentos ligados a essa área."}]},{"id":"saude-ferro","name":"Saúde de Ferro","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O personagem se recupera mais rápido de ferimentos e resiste melhor a doenças e períodos de recuperação."}]},{"id":"sedutor","name":"Sedutor","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Recebe bônus em situações de sedução e charme quando isso fizer sentido na cena."}]},{"id":"sensitivo","name":"Sensitivo","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Sensibilidade extra ao sobrenatural: pressentimentos, arrepios e sinais sutis da presença de forças estranhas."},{"cost":2,"label":"2 pontos","detail":"Além da sensibilidade geral, possui uma especialização extra-sensorial definida com o Mestre."}]},{"id":"senso-direcao","name":"Senso de Direção","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O personagem sabe se orientar mesmo sem referências visuais claras, usando noção de posição e direção."},{"cost":2,"label":"2 pontos","detail":"A orientação funciona mesmo em condições anormais ou sobrenaturais, com limites definidos pelo Mestre."}]},{"id":"senso-numerico","name":"Senso Numérico","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O personagem estima quantidades e faz cálculos mentais simples com rapidez impressionante."}]},{"id":"sentidos-agucados","name":"Sentidos Aguçados","kind":"positive","variants":[{"cost":1,"label":"1 ponto por sentido","detail":"Escolha um sentido para ser excepcionalmente aguçado. Pode ser comprado novamente para sentidos diferentes."}]},{"id":"sono-leve","name":"Sono Leve","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"O personagem acorda com facilidade diante de barulho, movimento ou outros sinais de perigo próximo."}]},{"id":"sortudo","name":"Sortudo","kind":"positive","variants":[{"cost":2,"label":"2 pontos","detail":"Uma vez por sessão, o jogador pode repetir uma rolagem relevante. O segundo resultado é o que vale."}]},{"id":"status","name":"Status","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Figura reconhecida em um bairro ou círculo local."},{"cost":2,"label":"2 pontos","detail":"Algum prestígio em uma pequena cidade ou comunidade."},{"cost":3,"label":"3 pontos","detail":"Reconhecimento em várias pequenas cidades ou numa região."},{"cost":4,"label":"4 pontos","detail":"Status de alcance estadual ou equivalente, com posição de grande influência."}]},{"id":"talento","name":"Talento","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Escolha uma Arte ou perícia apropriada. Testes Normais ligados a esse talento podem ser tratados como Fáceis, a critério do Mestre."}]},{"id":"tutor","name":"Tutor","kind":"positive","variants":[{"cost":1,"label":"1 ponto","detail":"Um tutor humano vivo e acessível ensina e orienta o personagem."},{"cost":2,"label":"2 pontos","detail":"Um tutor humano difícil de encontrar, escondido ou distante."},{"cost":3,"label":"3 pontos","detail":"Um tutor humano extremamente difícil de alcançar, preso, isolado ou em situação semelhante."},{"cost":4,"label":"4 pontos","detail":"Um tutor muito poderoso, sobrenatural ou perigosíssimo de encontrar, sujeito à aprovação do Mestre."}]},{"id":"alcoolatra","name":"Alcoólatra","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Dependência de álcool. Em abstinência ou sob efeito, o Mestre pode aplicar dificuldades e consequências apropriadas."}]},{"id":"alma-vendida","name":"Alma Vendida","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"A alma do personagem foi prometida ou vendida a uma entidade. A cobrança dessa dívida faz parte da campanha."}]},{"id":"alucinado","name":"Alucinado","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"O personagem sofre alucinações recorrentes que podem confundir percepção, memória e interpretação da realidade."}]},{"id":"analfabeto","name":"Analfabeto","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"O personagem não aprendeu a ler e escrever; conhecimentos que dependem de leitura ficam limitados."}]},{"id":"assassino-serial","name":"Assassino Serial","kind":"negative","variants":[{"cost":-2,"label":"-2 pontos","detail":"O personagem possui um padrão homicida recorrente e uma marca ou comportamento que pode atrair investigação."},{"cost":-3,"label":"-3 pontos","detail":"Como acima, mas com histórico muito mais grave e perseguição ativa de autoridades ou inimigos."}]},{"id":"assombrado","name":"Assombrado","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Pessoas comuns e animais percebem algo perturbador ou sobrenatural no personagem e podem reagir mal à presença dele."}]},{"id":"azarado","name":"Azarado","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"O acaso tende a se virar contra o personagem. O Mestre pode introduzir complicações pequenas e inconvenientes."}]},{"id":"canibal","name":"Canibal","kind":"negative","variants":[{"cost":-3,"label":"-3 pontos","detail":"O personagem possui um impulso canibal grave, com consequências sociais, legais e psicológicas severas."}]},{"id":"cleptomaniaco","name":"Cleptomaníaco","kind":"negative","variants":[{"cost":-2,"label":"-2 pontos","detail":"O personagem sente compulsão por roubar objetos, mesmo quando o valor ou a necessidade não justificam o risco."}]},{"id":"codigo-honra","name":"Código de Honra","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"O personagem segue um código moral ou juramento rígido que limita suas escolhas e pode colocá-lo em conflito com a situação."}]},{"id":"defeito-fisico","name":"Defeito Físico","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Uma limitação física relevante, como perda parcial de visão, audição ou mobilidade, definida com o Mestre."},{"cost":-2,"label":"-2 pontos","detail":"Uma limitação física severa ou permanente que afeta várias situações de jogo."}]},{"id":"drogado","name":"Drogado","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Dependência de uma droga. Abstinência e uso podem impor dificuldades, riscos e consequências em cena."}]},{"id":"dupla-personalidade","name":"Dupla Personalidade","kind":"negative","variants":[{"cost":-3,"label":"-3 pontos","detail":"O personagem possui identidades ou comportamentos muito distintos, e mudanças podem ocorrer em momentos críticos definidos com o Mestre."}]},{"id":"esquizofrenico","name":"Esquizofrênico","kind":"negative","variants":[{"cost":-2,"label":"-2 pontos","detail":"O personagem convive com perturbações severas de percepção e interpretação da realidade, tratadas como elemento ficcional da campanha."}]},{"id":"ferro-frio","name":"Ferro Frio","kind":"negative","variants":[{"cost":-2,"label":"-2 pontos","detail":"Contato com ferro frio causa dor, ferimentos ou enfraquecimento sobrenatural ao personagem."}]},{"id":"fobia-grave","name":"Fobia Grave","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Medo intenso de um gatilho específico. Quando exposto, o personagem pode sofrer penalidades ou perder o controle."}]},{"id":"gremlinit","name":"Gremlinit","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Pequenos gremlins sabotam ou prejudicam os equipamentos do personagem, fazendo objetos falharem ou se quebrarem em momentos ruins."}]},{"id":"inimigos","name":"Inimigos","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto · 1 inimigo","detail":"Um inimigo importante e recorrente, definido com o Mestre."},{"cost":-2,"label":"-2 pontos · 2 inimigos","detail":"Dois inimigos importantes e recorrentes."},{"cost":-3,"label":"-3 pontos · 3 inimigos","detail":"Três inimigos importantes e recorrentes."}]},{"id":"mania-perseguicao","name":"Mania de Perseguição","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"O personagem acredita estar sendo perseguido ou observado e tende a interpretar coincidências como sinais de conspiração."}]},{"id":"maniaco-depressivo","name":"Maníaco-Depressivo","kind":"negative","variants":[{"cost":-2,"label":"-2 pontos","detail":"Mudanças intensas de humor e energia afetam comportamento, decisões e estabilidade do personagem durante a campanha."}]},{"id":"mentiroso-compulsivo","name":"Mentiroso Compulsivo","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"O personagem mente por impulso, inclusive quando dizer a verdade seria mais simples ou seguro."}]},{"id":"obsessao","name":"Obsessão","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Fixação intensa por uma pessoa, objeto, ideia ou objetivo, capaz de interferir em decisões e prioridades."}]},{"id":"perda-terrivel","name":"Perda Terrível","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Um trauma ligado à perda de pessoas ou algo muito importante ainda afeta fortemente o personagem."}]},{"id":"perversao-sexual","name":"Perversão Sexual","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Compulsão ou comportamento sexual que cria problemas recorrentes para o personagem; intensidade e limites devem ser combinados com a mesa."},{"cost":-2,"label":"-2 pontos","detail":"Versão mais severa, com consequências sociais, emocionais ou legais maiores; use apenas se a mesa estiver confortável com o tema."},{"cost":-3,"label":"-3 pontos","detail":"Versão extrema e altamente problemática. Requer consentimento explícito da mesa e definição cuidadosa com o Mestre."}]},{"id":"poltergeist","name":"Poltergeist","kind":"negative","variants":[{"cost":-2,"label":"-2 pontos","detail":"Fenômenos de poltergeist se manifestam ao redor do personagem, causando ruídos, movimentos de objetos ou acidentes inexplicáveis."}]},{"id":"sangramento","name":"Sangramento","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Ferimentos do personagem sangram de forma anormal e podem piorar ou exigir cuidados adicionais."}]},{"id":"toque-letal","name":"Toque Letal","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"O toque do personagem causa efeitos nocivos em criaturas pequenas, plantas ou outros seres frágeis."},{"cost":-2,"label":"-2 pontos","detail":"Versão mais intensa: o contato pode ferir seriamente seres vivos, exigindo extremo cuidado."}]},{"id":"traumatizado","name":"Traumatizado","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Um acontecimento traumático deixa gatilhos claros. Quando confrontado com algo relacionado, o personagem pode sofrer penalidades ou perder ações."}]},{"id":"viciado-jogos","name":"Viciado em Jogos","kind":"negative","variants":[{"cost":-1,"label":"-1 ponto","detail":"Compulsão por jogos e apostas leva o personagem a perder dinheiro, assumir riscos ou aceitar desafios inadequados."}]}];

  const ui = {
    role: null,
    campaignId: null,
    sheetId: null,
    masterTab: 'overview',
    sheetMode: 'play',
    openSections: new Set(['skills', 'attributes']),
    playerMode: 'list',
    upgradeCatalogTab: 'positive'
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
    s.skills.forEach(sk => {
      if (sk.spent == null) sk.spent = 0;
      if (sk.combat == null) sk.combat = false;
    });
    s.creation ||= { skillBudgetGenerated: false, skillBudgetTotal: 0 };
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
      c.members ||= [];
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
    scheduleOnlinePersist();
  }

  function reloadState() {
    if (online.ready) return state;
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
      ownerDeviceId: currentOwnerId(),
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
      skills: [{ id: uid('skill'), catalogId: 'idiomas-nativo', category: 'Idiomas', name: 'Nativo', baseValue: 30, spent: 0, value: 30, combat: false }],
      creation: { skillBudgetGenerated: false, skillBudgetTotal: 0 },
      reserves: { skillPoints: 0, upgradePoints: 5, heroPoints: 0, magicPoints: 0 },
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
      members: [],
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

  const JSON_SCHEMA = 'fichas-daemon-character';
  const JSON_VERSION = 1;

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function portableCharacter(s) {
    normalizeSheet(s);
    return {
      name: s.name || '',
      ownerName: s.ownerName || '',
      title: s.title || '',
      race: s.race || '',
      sect: s.sect || '',
      kit: s.kit || '',
      level: s.level || '',
      fatalism: s.fatalism || '',
      epicScale: s.epicScale || '',
      concept: s.concept || '',
      age: s.age || '',
      profession: s.profession || '',
      attributes: cloneJson(s.attributes || {}),
      skills: cloneJson(s.skills || []).map(sk => ({
        catalogId: sk.catalogId || '',
        category: sk.category || '',
        name: sk.name || 'Perícia',
        baseValue: Number(sk.baseValue) || 0,
        spent: Number(sk.spent) || 0,
        value: Number(sk.value) || 0,
        combat: !!sk.combat
      })),
      creation: cloneJson(s.creation || {}),
      reserves: cloneJson(s.reserves || {}),
      combat: cloneJson(s.combat || {}),
      magic: cloneJson(s.magic || []),
      inventory: cloneJson(s.inventory || []),
      upgrades: cloneJson(s.upgrades || []),
      powers: cloneJson(s.powers || []),
      weaknesses: cloneJson(s.weaknesses || []),
      notes: s.notes || ''
    };
  }

  function exportPayload(s) {
    return {
      schema: JSON_SCHEMA,
      version: JSON_VERSION,
      exportedAt: new Date().toISOString(),
      character: portableCharacter(s)
    };
  }

  function slugFile(value = 'personagem') {
    return String(value || 'personagem')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'personagem';
  }

  function downloadText(filename, text, type = 'application/json;charset=utf-8') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSheetJson() {
    const s = sheet();
    if (!s) return;
    const payload = exportPayload(s);
    downloadText(`ficha-${slugFile(s.name)}.json`, JSON.stringify(payload, null, 2));
    toast('JSON da ficha criado.');
  }

  function normalizeKey(value = '') {
    return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const IMPORT_ATTRIBUTE_KEYS = {
    con:'con', constituicao:'con', constituio:'con',
    fr:'fr', forca:'fr',
    dex:'dex', destreza:'dex',
    agi:'agi', agilidade:'agi',
    int:'int', inteligencia:'int',
    will:'will', vontade:'will', forcadevontade:'will',
    per:'per', percepcao:'per',
    car:'car', carisma:'car'
  };

  function catalogMatchByName(name = '', category = '') {
    const target = normalizeKey(name);
    const cat = normalizeKey(category);
    return SKILL_CATALOG.find(item => normalizeKey(item.name) === target && (!cat || normalizeKey(item.category) === cat))
      || SKILL_CATALOG.find(item => normalizeKey(item.name) === target)
      || null;
  }

  function listFromImport(value) {
    if (!value) return [];
    if (Array.isArray(value)) return cloneJson(value);
    if (typeof value === 'string') return value.split(/\n|;/).map(v => v.trim()).filter(Boolean).map(name => ({ name, detail:'' }));
    if (typeof value === 'object') return Object.entries(value).map(([name, detail]) => ({ name, detail: String(detail ?? '') }));
    return [];
  }

  function skillsFromImport(value, currentSheet) {
    if (!value) return [];
    const rows = Array.isArray(value)
      ? value
      : typeof value === 'object'
        ? Object.entries(value).map(([name, v]) => typeof v === 'object' ? { name, ...v } : { name, value:v })
        : [];
    return rows.map(raw => {
      const sk = typeof raw === 'string' ? { name:raw, value:0 } : raw || {};
      const catalog = sk.catalogId ? skillCatalogEntry(sk.catalogId) : catalogMatchByName(sk.name, sk.category);
      const base = sk.baseValue != null ? Number(sk.baseValue) || 0 : (catalog ? skillBaseValue(catalog, currentSheet) : 0);
      const valueNum = Math.max(0, Number(sk.value ?? sk.total ?? base) || 0);
      const spent = Math.max(0, Number(sk.spent) || Math.max(0, valueNum - base));
      return {
        id: uid('skill'),
        catalogId: sk.catalogId || catalog?.id || '',
        category: sk.category || catalog?.category || '',
        name: String(sk.name || catalog?.name || 'Perícia'),
        baseValue: base,
        spent,
        value: valueNum,
        combat: sk.combat != null ? !!sk.combat : !!catalog?.combat
      };
    }).filter(sk => sk.name.trim());
  }

  function readImportedCharacter(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('O JSON precisa ser um objeto.');
    if (parsed.schema && parsed.schema !== JSON_SCHEMA) throw new Error('Este JSON não parece ser uma ficha do Fichas Daemon.');
    const data = parsed.character && typeof parsed.character === 'object' ? parsed.character : parsed;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Não encontrei os dados do personagem.');
    return data;
  }

  function applyImportedCharacter(data, { importOwner = false } = {}) {
    const s = sheet();
    if (!s) throw new Error('Nenhuma ficha aberta.');

    const identityKeys = ['name','title','race','sect','kit','level','fatalism','epicScale','concept','age','profession','notes'];
    identityKeys.forEach(key => { if (data[key] != null) s[key] = String(data[key]); });
    if (importOwner && data.ownerName != null) s.ownerName = String(data.ownerName);

    if (data.attributes && typeof data.attributes === 'object') {
      Object.entries(data.attributes).forEach(([key, value]) => {
        const internal = IMPORT_ATTRIBUTE_KEYS[normalizeKey(key)];
        if (internal) s.attributes[internal] = Math.max(1, Number(value) || 1);
      });
    }

    if (data.skills != null) s.skills = skillsFromImport(data.skills, s);
    if (data.creation && typeof data.creation === 'object') s.creation = { ...s.creation, ...cloneJson(data.creation) };
    if (data.reserves && typeof data.reserves === 'object') {
      ['skillPoints','upgradePoints','heroPoints','magicPoints'].forEach(key => {
        if (data.reserves[key] != null) s.reserves[key] = Math.max(0, Number(data.reserves[key]) || 0);
      });
    }
    if (data.combat && typeof data.combat === 'object') {
      ['hp','hpMax','initiative','defense','armor','damageBonus'].forEach(key => {
        if (data.combat[key] != null) s.combat[key] = Number(data.combat[key]) || 0;
      });
      if (data.combat.attacks != null) s.combat.attacks = listFromImport(data.combat.attacks);
      s.combat.hpMax = Math.max(1, Number(s.combat.hpMax) || 1);
      s.combat.hp = Math.max(0, Math.min(s.combat.hpMax, Number(s.combat.hp) || 0));
    }

    ['magic','inventory','upgrades','powers','weaknesses'].forEach(key => {
      if (data[key] != null) s[key] = listFromImport(data[key]);
    });

    normalizeSheet(s);
    s.updatedAt = Date.now();
    saveState();
  }

  function openJsonImport() {
    modal({
      title:'Importar ficha por JSON',
      copy:'Escolha um arquivo .json ou cole o conteúdo. A ficha aberta será atualizada, mas continuará pertencendo à mesa e ao usuário atuais.',
      body:`<form class="form" id="json-import-form">
        <div class="field"><label class="label">Arquivo JSON</label><input class="input" id="json-file-input" type="file" accept=".json,application/json"></div>
        <div class="json-drop-note">O arquivo é lido no seu navegador. Depois da importação, os dados da ficha são sincronizados com a mesa online.</div>
        <div class="field"><label class="label">Ou cole o JSON</label><textarea class="textarea json-textarea" id="json-import-text" name="json" placeholder='{"schema":"fichas-daemon-character", ...}'></textarea></div>
        <label class="json-check"><input type="checkbox" name="importOwner" value="1"> Também importar o nome do jogador</label>
        <div class="json-warning"><strong>Atenção:</strong> campos presentes no JSON substituem os dados equivalentes da ficha atual.</div>
        <button class="btn primary" type="submit">Ler JSON e atualizar ficha</button>
      </form>`
    });
  }

  function openJsonPreview() {
    const s = sheet(); if (!s) return;
    const json = JSON.stringify(exportPayload(s), null, 2);
    modal({
      title:'JSON da ficha',
      copy:'Esse é o formato portátil da ficha. Pode copiar, salvar ou mandar para outro jogador importar.',
      body:`<textarea class="textarea json-textarea json-preview" id="json-preview" readonly>${esc(json)}</textarea>
        <div class="flex gap8 mt12 wrap"><button class="btn primary" data-action="download-json">Baixar .json</button><button class="btn" data-action="copy-json">Copiar JSON</button></div>`
    });
  }


  function skillCatalogEntry(id) {
    return SKILL_CATALOG.find(item => item.id === id) || null;
  }

  function attributeShort(key) {
    const map = { con:'CON', fr:'FR', dex:'DEX', agi:'AGI', int:'INT', will:'WILL', per:'PER', car:'CAR' };
    return map[key] || String(key || '0').toUpperCase();
  }

  function skillBaseValue(entry, s) {
    if (!entry) return 0;
    if (typeof entry.base === 'number') return entry.base;
    if (/^\d+$/.test(String(entry.base))) return Number(entry.base);
    return Number(s?.attributes?.[entry.base]) || 0;
  }

  function skillBaseLabel(entry) {
    if (!entry) return '0';
    if (typeof entry.base === 'number' || /^\d+$/.test(String(entry.base))) return `${entry.base}%`;
    return attributeShort(entry.base);
  }

  function hasCatalogSkill(s, catalogId) {
    return (s?.skills || []).some(sk => sk.catalogId === catalogId);
  }

  function generateInitialSkillBudget() {
    const s = sheet();
    if (!s) return;
    if (s.creation?.skillBudgetGenerated) {
      toast(`Os ${s.creation.skillBudgetTotal} pontos iniciais já foram gerados para esta ficha.`);
      return;
    }
    const age = Number(String(s.age || '').match(/\d+/)?.[0] || 0);
    const intelligence = Number(s.attributes?.int || 0);
    if (!age) {
      toast('Preencha a Idade na seção Identidade antes de calcular os pontos.');
      return;
    }
    const total = Math.min(500, Math.max(0, intelligence * 5 + age * 10));
    s.reserves.skillPoints += total;
    s.creation = { skillBudgetGenerated: true, skillBudgetTotal: total };
    s.updatedAt = Date.now();
    saveState();
    toast(`${total} pontos de Perícia adicionados.`);
    renderSheet();
  }

  function openSkillCatalog() {
    const s = sheet();
    if (!s) return;
    const categories = [...new Set(SKILL_CATALOG.map(item => item.category))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
    modal({
      title: 'Catálogo de Perícias',
      copy: 'Escolha as perícias do livro. Subgrupos aparecem separados para você adicionar só o que o personagem realmente conhece.',
      body: `
        <div class="catalog-budget skill-budget-bar">
          <div><span>Pontos disponíveis</span><strong>${s.reserves.skillPoints}</strong></div>
          <div><span>Perícias escolhidas</span><strong>${s.skills.length}</strong></div>
          <div><span>Pontos iniciais</span><strong>${s.creation?.skillBudgetGenerated ? s.creation.skillBudgetTotal : '—'}</strong></div>
        </div>
        <div class="catalog-note">Ao escolher uma perícia nova, invista pelo menos <b>10 pontos</b>. O valor-base vem do atributo indicado; perícias técnicas começam em 0%.</div>
        <div class="skill-catalog-toolbar">
          <input class="input" id="skill-catalog-search" type="search" placeholder="Buscar perícia ou grupo..." autocomplete="off">
          <select class="select" id="skill-catalog-category">
            <option value="">Todos os grupos</option>
            ${categories.map(cat => `<option value="${esc(cat.toLocaleLowerCase('pt-BR'))}">${esc(cat)}</option>`).join('')}
          </select>
        </div>
        <div class="skill-catalog-grid">
          ${SKILL_CATALOG.map(item => renderSkillCatalogCard(item,s)).join('')}
        </div>
        <div class="catalog-footer"><span>Perícias de grupo foram separadas em subgrupos para facilitar a criação.</span><button class="btn primary" data-close-modal>Continuar na ficha</button></div>`
    });
  }

  function renderSkillCatalogCard(item,s) {
    const selected = hasCatalogSkill(s,item.id);
    const base = skillBaseValue(item,s);
    const search = `${item.category} ${item.name}`.toLocaleLowerCase('pt-BR');
    return `<article class="skill-catalog-card ${selected ? 'selected' : ''}" data-skill-catalog-card data-search="${esc(search)}" data-category="${esc(item.category.toLocaleLowerCase('pt-BR'))}">
      <div class="skill-catalog-copy">
        <span class="skill-catalog-group">${esc(item.category)}</span>
        <h3>${esc(item.name)}</h3>
        <div class="skill-catalog-meta"><span>Base ${skillBaseLabel(item)}</span><span>Agora ${base}%</span>${item.combat ? '<span>Combate</span>' : ''}</div>
        ${item.requirement ? `<p class="skill-requirement">Requer: ${esc(item.requirement)}</p>` : ''}
      </div>
      <button class="btn small ${selected ? 'ghost' : 'primary'}" data-action="skill-catalog-select" data-id="${item.id}" ${selected ? 'disabled' : ''}>${selected ? 'Na ficha' : 'Selecionar'}</button>
    </article>`;
  }

  function openSkillPurchase(catalogId) {
    const s = sheet(); const entry = skillCatalogEntry(catalogId);
    if (!s || !entry) return;
    if (hasCatalogSkill(s,catalogId)) { toast('Essa perícia já está na ficha.'); return; }
    const base = skillBaseValue(entry,s);
    const maxSpend = Math.min(50, Math.max(0,Number(s.reserves.skillPoints)||0));
    if (maxSpend < 10) {
      toast('Você precisa de pelo menos 10 pontos de Perícia para aprender uma nova perícia.');
      return;
    }
    modal({
      title: `${esc(entry.category)} · ${esc(entry.name)}`,
      copy: `Valor-base ${base}% (${skillBaseLabel(entry)}). Escolha quantos pontos serão investidos agora.`,
      body: `<form class="form" id="skill-catalog-purchase-form" data-catalog="${entry.id}">
        <div class="skill-purchase-preview"><span>Base</span><strong>${base}%</strong><span>+</span><strong id="skill-invest-preview">10</strong><span>=</span><strong id="skill-total-preview">${base+10}%</strong></div>
        <div class="field"><label class="label">Pontos para investir</label><input class="input" id="skill-invest-input" name="points" type="number" min="10" max="${maxSpend}" value="10" required><div class="hint">Na criação, uma perícia nova exige pelo menos 10 pontos; o investimento inicial é limitado a 50 pontos acima da base.</div></div>
        ${entry.requirement ? `<div class="catalog-note">Atenção: ${esc(entry.requirement)}. O sistema não bloqueia a escolha, mas o Mestre deve validar.</div>` : ''}
        <button class="btn primary" type="submit">Adicionar à ficha</button>
      </form>`
    });
  }

  function addSkillFromCatalog(catalogId, points) {
    const s=sheet(); const entry=skillCatalogEntry(catalogId);
    if(!s || !entry || hasCatalogSkill(s,catalogId)) return false;
    const spend=Math.max(10,Math.min(50,Number(points)||10));
    if(spend>s.reserves.skillPoints){toast('Pontos de Perícia insuficientes.');return false;}
    const base=skillBaseValue(entry,s);
    s.reserves.skillPoints-=spend;
    s.skills.push({id:uid('skill'),catalogId:entry.id,category:entry.category,name:`${entry.category === 'Geral' || entry.category === 'Combate' ? '' : entry.category + ' · '}${entry.name}`,shortName:entry.name,baseValue:base,spent:spend,value:base+spend,combat:!!entry.combat});
    s.updatedAt=Date.now(); saveState(); return true;
  }

  function openCustomSkillModal() {
    const s=sheet(); if(!s) return;
    const maxSpend=Math.min(50,Math.max(0,Number(s.reserves.skillPoints)||0));
    modal({title:'Perícia personalizada',copy:'Use apenas para uma perícia ou subgrupo que o Mestre aprovou e que não aparece no catálogo.',body:`<form class="form" id="custom-skill-form">
      <div class="field"><label class="label">Nome</label><input class="input" name="name" placeholder="Ex.: Idiomas · Japonês" required></div>
      <div class="field"><label class="label">Valor-base</label><input class="input" name="base" type="number" min="0" max="100" value="0"></div>
      <div class="field"><label class="label">Pontos para investir</label><input class="input" name="points" type="number" min="10" max="${maxSpend}" value="10" required></div>
      <button class="btn primary" type="submit" ${maxSpend<10?'disabled':''}>Adicionar perícia</button>
      ${maxSpend<10?'<div class="hint">Você precisa de pelo menos 10 pontos disponíveis.</div>':''}
    </form>`});
  }

  function removeSkill(index) {
    const s=sheet(); if(!s) return;
    const item=s.skills[Number(index)]; if(!item) return;
    if(item.catalogId==='idiomas-nativo'){toast('O idioma nativo faz parte da base da ficha.');return;}
    const refund=Math.max(0,Number(item.spent)||0);
    s.reserves.skillPoints+=refund;
    s.skills.splice(Number(index),1); s.updatedAt=Date.now(); saveState(); renderSheet();
    if(refund) toast(`${refund} ponto(s) devolvido(s).`);
  }

  function negativeUpgradePoints(s) {
    return (s?.weaknesses || []).reduce((total, item) => {
      const cost = Number(item?.cost || 0);
      return total + (item?.catalogId && cost < 0 ? Math.abs(cost) : 0);
    }, 0);
  }

  function hasCatalogUpgrade(s, catalogId) {
    return [...(s?.upgrades || []), ...(s?.weaknesses || [])].some(item => item?.catalogId === catalogId);
  }

  function catalogCostLabel(cost) {
    const abs = Math.abs(Number(cost) || 0);
    return `${cost < 0 ? '−' : ''}${abs} ${abs === 1 ? 'ponto' : 'pontos'}`;
  }

  function openUpgradeCatalog(isCreation = false) {
    const s = sheet();
    if (!s) return;
    const kind = ui.upgradeCatalogTab === 'negative' ? 'negative' : 'positive';
    const negativeUsed = negativeUpgradePoints(s);
    const items = BASE_UPGRADES.filter(item => item.kind === kind);
    const intro = isCreation
      ? 'Escolha os aprimoramentos iniciais do personagem. Você pode fechar esta janela e voltar ao catálogo depois.'
      : 'Catálogo do livro básico. Escolha uma opção e o sistema calcula os pontos automaticamente.';

    modal({
      title: 'Catálogo de Aprimoramentos',
      copy: intro,
      body: `
        <div class="catalog-budget">
          <div><span>Pontos disponíveis</span><strong>${s.reserves.upgradePoints}</strong></div>
          <div><span>Pontos negativos</span><strong>${negativeUsed}/3</strong></div>
          <div><span>Selecionados</span><strong>${s.upgrades.length + s.weaknesses.filter(x => x?.catalogId).length}</strong></div>
        </div>
        <div class="catalog-note">Personagens novos começam com <b>5 pontos</b>. Aprimoramentos negativos podem fornecer até <b>3 pontos extras</b>.</div>
        <div class="catalog-toolbar">
          <div class="catalog-tabs">
            <button class="btn small ${kind === 'positive' ? 'active' : ''}" data-action="catalog-tab" data-tab="positive">Positivos · 44</button>
            <button class="btn small ${kind === 'negative' ? 'active danger-soft' : ''}" data-action="catalog-tab" data-tab="negative">Negativos · 29</button>
          </div>
          <input class="input catalog-search" id="upgrade-catalog-search" type="search" placeholder="Buscar aprimoramento..." autocomplete="off">
        </div>
        <div class="catalog-grid">
          ${items.map(item => renderUpgradeCatalogCard(item, s)).join('')}
        </div>
        <div class="catalog-footer">
          <span>Base extraída das páginas enviadas do livro principal.</span>
          <button class="btn primary" data-close-modal>Continuar na ficha</button>
        </div>`
    });
  }

  function renderUpgradeCatalogCard(item, s) {
    const selected = hasCatalogUpgrade(s, item.id);
    const searchable = `${item.name} ${item.variants.map(v => v.detail).join(' ')}`.toLocaleLowerCase('pt-BR');
    return `
      <article class="catalog-card ${selected ? 'selected' : ''}" data-catalog-card data-search="${esc(searchable)}">
        <div class="catalog-card-head">
          <div>
            <span class="catalog-kind ${item.kind}">${item.kind === 'positive' ? 'Aprimoramento' : 'Negativo'}</span>
            <h3>${esc(item.name)}</h3>
          </div>
          ${selected ? '<span class="pill green">Selecionado</span>' : ''}
        </div>
        <div class="catalog-variants">
          ${item.variants.map((variant, index) => `
            <div class="catalog-variant">
              <div class="catalog-variant-copy">
                <strong>${esc(variant.label)}</strong>
                <p>${esc(variant.detail)}</p>
              </div>
              <button class="btn small ${item.kind === 'negative' ? 'danger' : 'primary'}"
                data-action="catalog-add" data-id="${item.id}" data-variant="${index}" ${selected ? 'disabled' : ''}>
                ${selected ? 'Adicionado' : item.kind === 'negative' ? `Aceitar ${catalogCostLabel(variant.cost)}` : `Comprar ${catalogCostLabel(variant.cost)}`}
              </button>
            </div>`).join('')}
        </div>
      </article>`;
  }

  function addCatalogUpgrade(catalogId, variantIndex) {
    const s = sheet();
    const entry = BASE_UPGRADES.find(item => item.id === catalogId);
    const variant = entry?.variants?.[Number(variantIndex)];
    if (!s || !entry || !variant) return;
    if (hasCatalogUpgrade(s, entry.id)) {
      toast('Esse aprimoramento já foi selecionado.');
      return;
    }

    const cost = Number(variant.cost) || 0;
    if (entry.kind === 'positive') {
      if (s.reserves.upgradePoints < cost) {
        toast(`Faltam ${cost - s.reserves.upgradePoints} ponto(s) de Aprimoramento.`);
        return;
      }
      s.reserves.upgradePoints -= cost;
      s.upgrades.push({
        catalogId: entry.id,
        catalogSource: 'base-book',
        kind: 'positive',
        cost,
        name: entry.name,
        variantLabel: variant.label,
        detail: variant.detail
      });
    } else {
      const used = negativeUpgradePoints(s);
      const grants = Math.abs(cost);
      if (used + grants > 3) {
        toast(`O limite é 3 pontos negativos. Você já usou ${used}.`);
        return;
      }
      s.reserves.upgradePoints += grants;
      s.weaknesses.push({
        catalogId: entry.id,
        catalogSource: 'base-book',
        kind: 'negative',
        cost,
        name: entry.name,
        variantLabel: variant.label,
        detail: variant.detail
      });
    }

    s.updatedAt = Date.now();
    saveState();
    openUpgradeCatalog(false);
  }

  function removeSheetListItem(action, index) {
    const s = sheet();
    if (!s) return false;
    const removeMap = {
      'remove-attack':['combat','attacks'],
      'remove-magic':[null,'magic'],
      'remove-inventory':[null,'inventory'],
      'remove-upgrade':[null,'upgrades'],
      'remove-power':[null,'powers'],
      'remove-weakness':[null,'weaknesses']
    };
    const path = removeMap[action];
    if (!path) return false;
    const [parent,key] = path;
    const list = parent ? s[parent][key] : s[key];
    const item = list[Number(index)];
    if (!item) return true;

    if (action === 'remove-upgrade' && item.catalogId && Number(item.cost) > 0) {
      s.reserves.upgradePoints += Number(item.cost);
    }
    if (action === 'remove-weakness' && item.catalogId && Number(item.cost) < 0) {
      const refundToRemove = Math.abs(Number(item.cost));
      if (s.reserves.upgradePoints < refundToRemove) {
        toast(`Para remover esse negativo, devolva ${refundToRemove} ponto(s) de Aprimoramento primeiro.`);
        return true;
      }
      s.reserves.upgradePoints -= refundToRemove;
    }

    list.splice(Number(index), 1);
    s.updatedAt = Date.now();
    saveState();
    renderSheet();
    return true;
  }


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
          <div class="hub-foot">${esc(onlineStatusLabel())}</div>
        </div>
      </main>`;
  }

  function mySheets() {
    const result = [];
    Object.values(state.campaigns).forEach(c => {
      Object.values(c.sheets || {}).forEach(s => {
        if (s.ownerDeviceId === currentOwnerId()) result.push({ campaign: c, sheet: s });
      });
    });
    return result.sort((a,b) => b.sheet.updatedAt - a.sheet.updatedAt);
  }

  function myWaitingRooms() {
    if (!online.ready) return [];
    const ownedRoomIds = new Set(mySheets().map(x => x.campaign.id));
    return Object.values(state.campaigns).filter(c => {
      if (c.isMaster || ownedRoomIds.has(c.id)) return false;
      return (c.members || []).some(m => m.user_id === currentOwnerId() && m.role === 'player');
    });
  }

  function renderPlayerLobby() {
    reloadState();
    ui.role = 'player';
    const sheets = mySheets();
    const waitingRooms = myWaitingRooms();
    app.innerHTML = `
      <div class="shell">
        ${topbar('Área do jogador')}
        <main class="content">
          <div class="page-head">
            <div><div class="eyebrow">Área do jogador</div><h1 class="page-title">Suas fichas</h1><p class="page-copy">Entre na mesa pelo código. O mestre pode deixar sua ficha pronta e vinculá-la a você.</p></div>
            <button class="btn primary" data-action="join-table">+ Entrar em mesa</button>
          </div>
          ${waitingRooms.length ? `<div class="grid two mb16">${waitingRooms.map(c => `
            <article class="card gold-edge">
              <div class="flex between center gap12"><div><div class="eyebrow">Aguardando ficha</div><h2 class="card-title">${esc(c.name)}</h2><p class="card-copy">Você já entrou na mesa. O mestre só precisa vincular seu personagem.</p></div><span class="pill gold">Aguardando</span></div>
              <div class="sep"></div>
              <div class="flex between center gap8 wrap"><span class="small-text muted">Código ${esc(c.code)}</span><button class="btn small" data-action="refresh-online">Atualizar</button></div>
            </article>`).join('')}</div>` : ''}
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
            </article>`).join('')}</div>` : (!waitingRooms.length ? `
            <div class="empty"><strong>Você ainda não entrou em nenhuma mesa.</strong>Use o código do mestre. Depois ele pode vincular uma ficha já pronta ao seu usuário.<div class="mt16"><button class="btn primary" data-action="join-table">Entrar em mesa</button></div></div>` : '')}
        </main>
      </div>`;
  }

  function renderMasterLobby() {
    reloadState();
    ui.role = 'master';
    const campaigns = Object.values(state.campaigns).filter(c => !online.ready || c.isMaster).sort((a,b) => b.createdAt - a.createdAt);
    app.innerHTML = `
      <div class="shell">
        ${topbar('Área do mestre')}
        <main class="content">
          <div class="page-head">
            <div><div class="eyebrow">Área do mestre</div><h1 class="page-title">Suas mesas</h1><p class="page-copy">Abra uma mesa online existente ou crie uma nova campanha.</p></div>
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
            <div class="flex gap8 wrap json-toolbar">
              <button class="btn" data-action="import-json">Importar JSON</button>
              <button class="btn" data-action="preview-json">Exportar JSON</button>
              <button class="btn" data-action="quick-roll">Rolar d100</button>
            </div>
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
    if (skill?.combat) return true;
    return /(arma|armas|combate|briga|luta|esquiva|tiro|arco|lança|espada|machado)/i.test(skill?.name || '');
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
        <div class="skill-creation-head">
          <div class="upgrade-summary">
            <div><span>Pontos disponíveis</span><strong>${s.reserves.skillPoints}</strong></div>
            <div><span>Pontos iniciais</span><strong>${s.creation?.skillBudgetGenerated ? s.creation.skillBudgetTotal : 'não calculado'}</strong></div>
          </div>
          ${!s.creation?.skillBudgetGenerated ? `<button class="btn small" data-action="generate-skill-budget">Calcular pontos iniciais</button>` : ''}
        </div>
        <div class="hint mt8">Cálculo inicial: INT × 5 + Idade × 10, com limite padrão de 500. Preencha Idade e Inteligência antes de gerar.</div>
        <div class="skill-list mt12">${s.skills.length ? [...s.skills].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')).map((sk) => {
          const originalIndex=s.skills.indexOf(sk);
          return `<div class="skill-row skill-row-edit"><span class="skill-name"><b>${esc(sk.name)}</b>${sk.catalogId ? `<small>${sk.spent ? `${sk.spent} pts investidos` : 'base da ficha'}</small>` : '<small>personalizada</small>'}</span><span class="skill-value">${sk.value}%</span><button class="roll-btn" title="Rolar 1d100" data-action="roll-skill" data-skill="${sk.id}">◆</button><button class="skill-remove" title="Remover perícia" data-action="remove-skill" data-index="${originalIndex}">×</button></div>`;
        }).join('') : '<div class="empty" style="padding:18px">Nenhuma perícia escolhida.</div>'}</div>
        <div class="flex gap8 mt12 wrap"><button class="btn primary small" data-action="open-skill-catalog">Escolher do livro</button><button class="btn small" data-action="add-skill">+ Personalizada</button>${s.reserves.skillPoints > 0 && s.skills.length ? `<button class="btn success small" data-action="spend-skill">Evoluir perícia (${s.reserves.skillPoints})</button>` : ''}</div>`;
      case 'attributes': return `<div class="stat-grid">${ATTRIBUTES.map(([k,n]) => `<div class="stat"><div class="stat-label">${n}</div><div class="stat-value">${s.attributes[k]}</div><div class="stat-test">teste ${s.attributes[k]*c.rules.attributeMultiplier}%</div></div>`).join('')}</div><div class="flex gap8 mt12"><button class="btn small" data-action="edit-attributes">Editar atributos</button><button class="btn small" data-action="roll-attribute">Testar atributo</button></div>`;
      case 'reserves': return `<div class="stat-grid"><div class="stat"><div class="stat-label">Perícia</div><div class="stat-value">${s.reserves.skillPoints}</div></div><div class="stat"><div class="stat-label">Aprimoramento</div><div class="stat-value">${s.reserves.upgradePoints}</div></div><div class="stat"><div class="stat-label">Negativos</div><div class="stat-value">${negativeUpgradePoints(s)}/3</div></div><div class="stat"><div class="stat-label">Heroicos</div><div class="stat-value">${s.reserves.heroPoints}</div></div><div class="stat"><div class="stat-label">Magia</div><div class="stat-value">${s.reserves.magicPoints}</div></div></div>`;
      case 'combat': return `
        <div class="stat-grid"><div class="stat"><div class="stat-label">PV</div><div class="stat-value">${s.combat.hp}/${s.combat.hpMax}</div></div><div class="stat"><div class="stat-label">Iniciativa</div><div class="stat-value">${s.combat.initiative}</div></div><div class="stat"><div class="stat-label">Defesa</div><div class="stat-value">${s.combat.defense}</div></div><div class="stat"><div class="stat-label">Armadura</div><div class="stat-value">${s.combat.armor}</div></div></div>
        <div class="mt12">${renderGenericList(s.combat.attacks,'Nenhum ataque salvo.','remove-attack')}</div>
        <div class="flex gap8 mt12"><button class="btn small" data-action="edit-combat">Editar combate</button><button class="btn small" data-action="add-attack">+ Ataque</button></div>`;
      case 'magic': return `${renderGenericList(s.magic,'Nenhuma magia anotada.','remove-magic')}<button class="btn small mt12" data-action="add-magic">+ Magia</button>`;
      case 'inventory': return `${renderGenericList(s.inventory,'Inventário vazio.','remove-inventory')}<button class="btn small mt12" data-action="add-inventory">+ Item</button>`;
      case 'upgrades': return `
        <div class="upgrade-summary">
          <div><span>Pontos disponíveis</span><strong>${s.reserves.upgradePoints}</strong></div>
          <div><span>Negativos usados</span><strong>${negativeUpgradePoints(s)}/3</strong></div>
        </div>
        ${renderGenericList(s.upgrades,'Nenhum aprimoramento.','remove-upgrade')}
        <div class="flex gap8 mt12 wrap">
          <button class="btn primary small" data-action="open-upgrade-catalog">Escolher do livro</button>
          <button class="btn small" data-action="add-upgrade">+ Personalizado</button>
          ${s.reserves.upgradePoints > 0 ? `<span class="pill green">${s.reserves.upgradePoints} ponto(s) disponível(is)</span>` : ''}
        </div>`;
      case 'powers': return `<div class="grid two"><div><div class="label">Poderes</div><div class="mt8">${renderGenericList(s.powers,'Nenhum poder.','remove-power')}</div><button class="btn small mt12" data-action="add-power">+ Poder</button></div><div><div class="label">Fraquezas / Aprimoramentos negativos</div><div class="mt8">${renderGenericList(s.weaknesses,'Nenhuma fraqueza ou aprimoramento negativo.','remove-weakness')}</div><div class="flex gap8 mt12 wrap"><button class="btn small" data-action="add-weakness">+ Fraqueza</button><button class="btn small danger" data-action="open-negative-catalog">Catálogo negativo</button></div></div></div>`;
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
            <div class="flex gap8 wrap"><button class="btn ghost" data-action="master-home">Minhas mesas</button><button class="btn" data-action="master-create-sheet">+ Criar ficha</button><button class="btn" data-action="master-import-sheet">Importar JSON pronta</button><button class="btn primary" data-action="copy-code" data-code="${esc(c.code)}">Convite ${esc(c.code)}</button></div>
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
      const joinedPlayers = (c.members || []).filter(m => m.role === 'player').length;
      return `<div class="kpi-grid"><div class="kpi"><div class="kpi-label">Jogadores na sala</div><div class="kpi-value">${joinedPlayers}</div></div><div class="kpi"><div class="kpi-label">Fichas</div><div class="kpi-value">${sheets.length}</div></div><div class="kpi"><div class="kpi-label">PV atual</div><div class="kpi-value">${totalHp}</div></div><div class="kpi"><div class="kpi-label">Rolagens</div><div class="kpi-value">${c.logs.length}</div></div></div>
      <div class="card gold-edge"><div class="flex between center gap12 wrap"><div><div class="eyebrow">Convite da mesa</div><h2 class="card-title">Código ${esc(c.code)}</h2><p class="card-copy">Passe o código para os jogadores entrarem. Depois vincule cada um à ficha que você já preparou.</p></div><button class="btn primary" data-action="copy-code" data-code="${esc(c.code)}">Copiar código</button></div></div>
      <div class="mt16">${renderPlayers(c,sheets)}</div>`;
    }
    if (ui.masterTab === 'players') return renderPlayers(c,sheets,true);
    if (ui.masterTab === 'rules') return renderRules(c);
    if (ui.masterTab === 'history') return renderHistory(c);
  }

  function renderPlayers(c,sheets,full=false) {
    const playerMembers = (c.members || []).filter(m => m.role === 'player');
    const assignedIds = new Set(sheets.map(s => s.ownerDeviceId).filter(Boolean));
    const waiting = playerMembers.filter(m => !assignedIds.has(m.user_id));
    const waitingBlock = waiting.length ? `<div class="card mb16"><div class="eyebrow">Jogadores aguardando ficha</div><h2 class="card-title">${waiting.length} esperando vínculo</h2><div class="list mt12">${waiting.map(m => `<div class="list-item"><div class="list-main"><div class="list-title">${esc(m.display_name || 'Jogador')}</div><div class="list-sub">Entrou na mesa e ainda não possui personagem.</div></div><span class="pill gold">Aguardando</span></div>`).join('')}</div></div>` : '';
    if (!sheets.length) return `${waitingBlock}<div class="empty"><strong>Nenhuma ficha preparada ainda.</strong>Crie uma ficha vazia ou importe um dos JSONs prontos. Depois vincule ao jogador que entrar com o código <span class="mono gold">${esc(c.code)}</span>.<div class="mt16 flex gap8 wrap"><button class="btn primary" data-action="master-import-sheet">Importar JSON pronta</button><button class="btn" data-action="master-create-sheet">+ Criar ficha vazia</button></div></div>`;
    return `${waitingBlock}<div class="player-grid">${sheets.map(s => {
      const pct = Math.max(0,Math.min(100,(s.combat.hp/Math.max(1,s.combat.hpMax))*100));
      const member = playerMembers.find(m => m.user_id === s.ownerDeviceId);
      const assigned = Boolean(s.ownerDeviceId);
      return `<article class="player-card"><div class="player-card-head"><div><div class="player-name">${esc(s.name)}</div><div class="player-owner">${assigned ? `Jogador: ${esc(member?.display_name || s.ownerName || 'Vinculado')}` : 'Sem jogador vinculado'}</div></div><span class="pill ${assigned ? 'green' : 'gold'}">${assigned ? 'Vinculada' : 'Aguardando jogador'}</span></div>
      <div class="mini-hp"><div class="mini-hp-line"><span>Vida</span><span>${s.combat.hp}/${s.combat.hpMax} PV</span></div><div class="mini-track"><div class="mini-fill" style="width:${pct}%"></div></div></div>
      ${full ? `<div class="stat-grid mt12" style="grid-template-columns:1fr 1fr"><div class="stat"><div class="stat-label">Pts perícia</div><div class="stat-value">${s.reserves.skillPoints}</div></div><div class="stat"><div class="stat-label">Pts aprim.</div><div class="stat-value">${s.reserves.upgradePoints}</div></div></div>` : ''}
      <div class="player-actions"><button class="btn primary small" data-action="master-open-sheet" data-mode="play" data-sheet="${s.id}">Modo de jogo</button><button class="btn small" data-action="master-open-sheet" data-mode="edit" data-sheet="${s.id}">Editar ficha</button>${online.ready ? (assigned ? `<button class="btn small" data-action="bind-player" data-sheet="${s.id}">Trocar jogador</button><button class="btn danger small" data-action="unbind-player" data-sheet="${s.id}">Desvincular</button>` : `<button class="btn success small" data-action="bind-player" data-sheet="${s.id}">Vincular jogador</button>`) : ''}<button class="btn success small" data-action="give-points" data-sheet="${s.id}">Dar pontos</button><button class="btn small" data-action="master-hp" data-sheet="${s.id}">Ajustar PV</button></div></article>`;
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
    const log = { id:uid('roll'), character:s.name, label, roll, target, result, at:Date.now() };
    c.logs.unshift(log);
    c.logs = c.logs.slice(0,100);
    saveState();
    saveOnlineRoll(log, s);
    modalRoot.innerHTML = `<div class="roll-overlay" data-close-modal><div class="roll-card" onclick="event.stopPropagation()"><div class="eyebrow">1d100</div><h2 class="roll-title">${esc(label)}</h2><div class="d100">${roll}</div><div class="roll-result ${cls}">${result}</div><div class="roll-info">Alvo ${target}% · crítico até ${criticalIndex} · falha automática acima de ${c.rules.autoFailAbove}.</div><button class="btn primary w100" data-close-modal>Fechar</button></div></div>`;
  }

  function openJoinTable() {
    reloadState();
    modal({ title:'Entrar em uma mesa', copy:'Use o código enviado pelo mestre. Você entra primeiro na sala; depois o mestre vincula sua ficha pronta.', body:`<form class="form" id="join-form"><div class="field"><label class="label">Código da mesa</label><input class="input mono" name="code" maxlength="6" autocomplete="off" placeholder="ABC123" required></div><div class="field"><label class="label">Seu nome</label><input class="input" name="owner" placeholder="Ex.: Kauan" required></div><button class="btn primary" type="submit">Entrar na mesa</button><div class="hint">Depois do vínculo, somente você e o mestre recebem sua ficha pelo Supabase.</div></form>` });
  }

  function openMasterCreateSheet() {
    const c = campaign(); if (!c) return;
    modal({ title:'Criar ficha sem jogador', copy:'A ficha fica pronta na mesa e invisível para os jogadores até você vinculá-la.', body:`<form class="form" id="master-create-sheet-form"><div class="field"><label class="label">Nome do personagem</label><input class="input" name="character" placeholder="Ex.: Jin" required></div><button class="btn primary" type="submit">Criar ficha e editar</button></form>` });
  }

  function openMasterImportSheet() {
    const c = campaign(); if (!c) return;
    modal({ title:'Importar ficha pronta', copy:'Importe um JSON antes do jogador entrar. A ficha ficará sem dono até você vinculá-la.', body:`<form class="form" id="master-import-sheet-form"><div class="field"><label class="label">Arquivo JSON</label><input class="input" id="master-json-file-input" type="file" accept=".json,application/json"></div><div class="field"><label class="label">Ou cole o JSON</label><textarea class="textarea json-textarea" id="master-json-import-text" name="json" placeholder='{"schema":"fichas-daemon-character", ...}' required></textarea></div><button class="btn primary" type="submit">Criar ficha com este JSON</button></form>` });
  }

  function bindPlayerModal(sheetId) {
    const c = campaign(); const s = c?.sheets?.[sheetId]; if (!c || !s) return;
    const assignedIds = new Set(Object.values(c.sheets || {}).filter(x => x.id !== s.id).map(x => x.ownerDeviceId).filter(Boolean));
    const players = (c.members || []).filter(m => m.role === 'player' && !assignedIds.has(m.user_id));
    if (!players.length) { toast('Nenhum jogador disponível. Peça para ele entrar na mesa pelo código primeiro.'); return; }
    modal({ title:`Vincular ${esc(s.name)}`, copy:'Escolha qual jogador desta sala receberá a ficha. A mudança aparece no celular dele.', body:`<form class="form" id="bind-player-form" data-sheet="${s.id}"><div class="field"><label class="label">Jogador</label><select class="select" name="userId" required>${players.map(m => `<option value="${esc(m.user_id)}" ${m.user_id===s.ownerDeviceId?'selected':''}>${esc(m.display_name || 'Jogador')}</option>`).join('')}</select></div><button class="btn primary" type="submit">Vincular ficha</button></form>` });
  }

  function openCreateTable() {
    if (online.enabled && !requireOnline()) return;
    if (online.ready) {
      modal({ title:'Criar uma mesa', copy:'A mesa será criada no Supabase e receberá um código único para compartilhar.', body:`<form class="form" id="create-table-form"><div class="field"><label class="label">Nome da mesa</label><input class="input" name="name" placeholder="Ex.: Ecos de Arkanun" required></div><div class="field"><label class="label">Seu nome</label><input class="input" name="master" placeholder="Ex.: João" required></div><button class="btn primary" type="submit">Criar mesa online</button></form>` });
      return;
    }
    modal({ title:'Criar uma mesa', copy:'Modo local de compatibilidade.', body:`<form class="form" id="create-table-form"><div class="field"><label class="label">Nome da mesa</label><input class="input" name="name" required></div><div class="field"><label class="label">Seu nome</label><input class="input" name="master" required></div><div class="field"><label class="label">PIN do mestre</label><input class="input mono" name="pin" type="password" value="1234" required></div><button class="btn primary" type="submit">Criar mesa</button></form>` });
  }

  function openMasterLogin(campaignId) {
    reloadState();
    const c = state.campaigns[campaignId]; if (!c) return;
    if (online.ready) {
      if (!c.isMaster) { toast('Esta mesa não pertence a esta sessão de mestre.'); return; }
      ui.role='master'; ui.campaignId=c.id; ui.masterTab='overview'; renderMasterDashboard();
      return;
    }
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
    if (action === 'master-import-sheet') return openMasterImportSheet();
    if (action === 'bind-player') return bindPlayerModal(el.dataset.sheet);
    if (action === 'unbind-player') {
      const c=campaign(); const s=c?.sheets?.[el.dataset.sheet]; if(!c||!s||!online.ready) return;
      online.client.from('characters').update({ owner_id:null }).eq('id',s.id).then(async ({error})=>{ if(error){toast(`Não consegui desvincular: ${error.message}`);return;} await hydrateOnlineState(); toast(`${s.name} ficou sem jogador.`); renderMasterDashboard(); }); return;
    }
    if (action === 'refresh-online') { if(!online.ready)return; hydrateOnlineState().then(()=>renderCurrentViewAfterSync()).catch(err=>toast(err.message)); return; }
    if (action === 'copy-code') { navigator.clipboard?.writeText(el.dataset.code); toast(`Código ${el.dataset.code} copiado.`); return; }
    if (action === 'master-login') return openMasterLogin(el.dataset.campaign);
    if (action === 'open-sheet') { ui.campaignId=el.dataset.campaign; ui.sheetId=el.dataset.sheet; ui.role='player'; ui.sheetMode=el.dataset.mode || 'play'; return renderSheet(); }
    if (action === 'sheet-mode') { ui.sheetMode=el.dataset.mode === 'edit' ? 'edit' : 'play'; return renderSheet(); }
    if (action === 'toggle-section') { const k=el.dataset.section; ui.openSections.has(k)?ui.openSections.delete(k):ui.openSections.add(k); return renderSheet(); }
    if (action === 'roll-skill') { const s=sheet(); const sk=s.skills.find(x=>x.id===el.dataset.skill); if(sk) doRoll(sk.name,sk.value); return; }
    if (action === 'roll-attack') { const s=sheet(); const attack=s?.combat?.attacks?.[Number(el.dataset.index)]; const target=parsePercent(attack?.detail || ''); if(attack && target) doRoll(attack.name,target); return; }
    if (action === 'quick-roll') return doRoll('Teste livre',100);
    if (action === 'import-json') return openJsonImport();
    if (action === 'preview-json') return openJsonPreview();
    if (action === 'download-json') { closeModal(); return exportSheetJson(); }
    if (action === 'copy-json') { const text=JSON.stringify(exportPayload(sheet()),null,2); navigator.clipboard?.writeText(text); toast('JSON copiado.'); return; }
    if (action === 'generate-skill-budget') return generateInitialSkillBudget();
    if (action === 'open-skill-catalog') return openSkillCatalog();
    if (action === 'skill-catalog-select') return openSkillPurchase(el.dataset.id);
    if (action === 'remove-skill') return removeSkill(el.dataset.index);
    if (action === 'open-upgrade-catalog') { ui.upgradeCatalogTab='positive'; return openUpgradeCatalog(false); }
    if (action === 'open-negative-catalog') { ui.upgradeCatalogTab='negative'; return openUpgradeCatalog(false); }
    if (action === 'catalog-tab') { ui.upgradeCatalogTab=el.dataset.tab==='negative'?'negative':'positive'; return openUpgradeCatalog(false); }
    if (action === 'catalog-add') return addCatalogUpgrade(el.dataset.id,el.dataset.variant);
    if (action === 'add-skill') return openCustomSkillModal();
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

    if (removeSheetListItem(action, el.dataset.index)) return;

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

  document.addEventListener('submit', async e => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    e.preventDefault();
    const fd = new FormData(form);

    if (form.id === 'json-import-form') {
      try {
        const text=String(fd.get('json')||'').trim();
        if(!text){toast('Escolha um arquivo JSON ou cole o conteúdo.');return;}
        const parsed=JSON.parse(text);
        const data=readImportedCharacter(parsed);
        applyImportedCharacter(data,{importOwner:fd.get('importOwner')==='1'});
        closeModal(); renderSheet(); toast('Ficha atualizada pelo JSON.');
      } catch (err) { toast(`Não consegui importar: ${err?.message || 'JSON inválido.'}`); }
      return;
    }

    if (form.id === 'join-form') {
      const code=String(fd.get('code')||'').trim().toUpperCase();
      const owner=String(fd.get('owner')||'').trim();
      if (online.ready) {
        try {
          const { data, error } = await online.client.rpc('join_room_by_code', { _invite_code: code, _display_name: owner });
          if (error) throw error;
          const joined = Array.isArray(data) ? data[0] : data;
          if (!joined?.room_id) throw new Error('Mesa não encontrada.');
          await hydrateOnlineState();
          closeModal(); ui.role='player';ui.campaignId=null;ui.sheetId=null;ui.sheetMode='play';renderPlayerLobby();
          toast('Você entrou na mesa. Agora o mestre pode vincular sua ficha.');
        } catch (err) { toast(`Não consegui entrar: ${err?.message || err}`); }
        return;
      }
      if (online.enabled && !requireOnline()) return;
      reloadState();
      const c=Object.values(state.campaigns).find(x=>String(x.code||'').toUpperCase()===code);
      if(!c){toast('Mesa não encontrada.');return;}
      const s=newSheet(owner,'Novo personagem',c.id);
      c.sheets[s.id]=s; saveState(); closeModal(); ui.role='player';ui.campaignId=c.id;ui.sheetId=s.id;ui.sheetMode='edit';renderSheet();return;
    }
    if (form.id === 'master-create-sheet-form') {
      const c=campaign(); if(!c) return;
      const character=String(fd.get('character')||'');
      if (online.ready) {
        try {
          const characterId = await createOnlineCharacter(c.id, 'Aguardando jogador', character, null, true);
          await hydrateOnlineState();
          closeModal(); ui.role='master';ui.sheetId=characterId;ui.sheetMode='edit';renderSheet();
        } catch (err) { toast(`Não consegui criar a ficha: ${err?.message || err}`); }
        return;
      }
      const owner='Aguardando jogador'; const s=newSheet(owner,character,c.id); s.ownerDeviceId=null;
      c.sheets[s.id]=s; saveState(); closeModal(); ui.role='master';ui.sheetId=s.id;ui.sheetMode='edit';renderSheet();return;
    }
    if (form.id === 'master-import-sheet-form') {
      const c=campaign(); if(!c || !online.ready) return;
      try {
        const text=String(fd.get('json')||'').trim();
        if(!text) throw new Error('Escolha um JSON ou cole o conteúdo.');
        const data=readImportedCharacter(JSON.parse(text));
        const characterId=await createOnlineCharacter(c.id,'Aguardando jogador',String(data.name||'Novo personagem'),null,true);
        await hydrateOnlineState();
        ui.role='master'; ui.campaignId=c.id; ui.sheetId=characterId; ui.sheetMode='edit';
        applyImportedCharacter(data,{importOwner:false});
        const imported=sheet(); imported.ownerDeviceId=null; imported.ownerName='Aguardando jogador'; saveState();
        await persistSheetOnline(imported,c.id);
        await hydrateOnlineState();
        closeModal(); toast(`${data.name || 'Ficha'} importada e aguardando jogador.`); renderMasterDashboard();
      } catch(err) { toast(`Não consegui importar: ${err?.message || err}`); }
      return;
    }
    if (form.id === 'bind-player-form') {
      const c=campaign(); const s=c?.sheets?.[form.dataset.sheet]; const userId=String(fd.get('userId')||'');
      if(!c||!s||!userId||!online.ready) return;
      try {
        const {error}=await online.client.from('characters').update({owner_id:userId}).eq('id',s.id);
        if(error) throw error;
        await hydrateOnlineState(); closeModal(); toast(`${s.name} vinculada ao jogador.`); renderMasterDashboard();
      } catch(err) { toast(`Não consegui vincular: ${err?.message || err}`); }
      return;
    }

    if (form.id === 'create-table-form') {
      const name=String(fd.get('name')||'').trim(); const master=String(fd.get('master')||'').trim();
      if (online.ready) {
        try {
          const { data, error } = await online.client.rpc('create_room', { _name: name, _display_name: master });
          if (error) throw error;
          const created = Array.isArray(data) ? data[0] : data;
          if (!created?.room_id) throw new Error('A mesa não retornou um ID.');
          await hydrateOnlineState();
          closeModal(); ui.role='master';ui.campaignId=created.room_id;ui.masterTab='overview';renderMasterDashboard();
        } catch (err) { toast(`Não consegui criar a mesa: ${err?.message || err}`); }
        return;
      }
      if (online.enabled && !requireOnline()) return;
      reloadState();
      const c=newCampaign(name,master,String(fd.get('pin')||''));
      state.campaigns[c.id]=c;saveState();closeModal();ui.role='master';ui.campaignId=c.id;ui.masterTab='overview';renderMasterDashboard();return;
    }
    if (form.id === 'master-login-form') {
      const c=state.campaigns[form.dataset.campaign];
      if(String(fd.get('pin'))!==String(c.masterPin)){toast('PIN incorreto.');return;}
      closeModal();ui.role='master';ui.campaignId=c.id;ui.masterTab='overview';renderMasterDashboard();return;
    }
    if (form.id === 'skill-catalog-purchase-form') {
      const ok=addSkillFromCatalog(form.dataset.catalog,Number(fd.get('points'))||10);
      if(ok){closeModal();renderSheet();toast('Perícia adicionada à ficha.');}
      return;
    }
    if (form.id === 'custom-skill-form') {
      const s=sheet(); const spend=Math.max(10,Math.min(50,Number(fd.get('points'))||10));
      if(!s || spend>s.reserves.skillPoints){toast('Pontos de Perícia insuficientes.');return;}
      const base=Math.max(0,Number(fd.get('base'))||0); const name=String(fd.get('name')||'').trim(); if(!name)return;
      s.reserves.skillPoints-=spend;s.skills.push({id:uid('skill'),name,baseValue:base,spent:spend,value:base+spend,combat:false});s.updatedAt=Date.now();saveState();closeModal();renderSheet();return;
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
      const c=campaign(); const s=c.sheets[form.dataset.sheet]; const type=fd.get('type'); const amount=Math.max(1,Number(fd.get('amount'))||1); s.reserves[type]=(s.reserves[type]||0)+amount;saveState(); if(online.ready) await persistSheetOnline(s,c.id); closeModal();toast(`${amount} ponto(s) concedido(s) a ${s.name}.`);renderMasterDashboard();return;
    }
    if (form.id === 'master-hp-form') {
      const c=campaign(); const s=c.sheets[form.dataset.sheet];s.combat.hpMax=Math.max(1,Number(fd.get('hpMax'))||1);s.combat.hp=Math.max(0,Math.min(s.combat.hpMax,Number(fd.get('hp'))||0));saveState(); if(online.ready) await persistSheetOnline(s,c.id); closeModal();renderMasterDashboard();return;
    }
  });

  document.addEventListener('change', e => {
    const target=e.target;
    if (!['json-file-input','master-json-file-input'].includes(target?.id)) return;
    const file=target.files?.[0];
    if(!file) return;
    if(file.size > 2 * 1024 * 1024){toast('Esse JSON é grande demais. Limite: 2 MB.');target.value='';return;}
    const reader=new FileReader();
    reader.onload=()=>{const area=document.querySelector(target.id==='master-json-file-input'?'#master-json-import-text':'#json-import-text');if(area)area.value=String(reader.result||'');};
    reader.onerror=()=>toast('Não consegui ler esse arquivo.');
    reader.readAsText(file,'utf-8');
  });

  document.addEventListener('input', e => {
    const target=e.target;
    const s=sheet(); if(!s) return;
    if (target.id === 'skill-catalog-search' || target.id === 'skill-catalog-category') {
      const q=String(document.querySelector('#skill-catalog-search')?.value||'').trim().toLocaleLowerCase('pt-BR');
      const cat=String(document.querySelector('#skill-catalog-category')?.value||'');
      document.querySelectorAll('[data-skill-catalog-card]').forEach(card=>{
        const matchText=!q || String(card.dataset.search||'').includes(q);
        const matchCat=!cat || card.dataset.category===cat;
        card.hidden=!(matchText&&matchCat);
      });
      return;
    }
    if (target.id === 'upgrade-catalog-search') {
      const q=String(target.value||'').trim().toLocaleLowerCase('pt-BR');
      document.querySelectorAll('[data-catalog-card]').forEach(card=>{card.hidden=!!q && !String(card.dataset.search||'').includes(q);});
      return;
    }
    if (target.id === 'skill-invest-input') {
      const val=Math.max(10,Number(target.value)||10); const form=target.closest('form'); const entry=skillCatalogEntry(form?.dataset?.catalog); const base=skillBaseValue(entry,s);
      const a=document.querySelector('#skill-invest-preview'), b=document.querySelector('#skill-total-preview'); if(a)a.textContent=val; if(b)b.textContent=`${base+val}%`;
    }
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
    if (!ui.role) return;
    if (online.ready) scheduleOnlineRefresh(); else renderCurrentViewAfterSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ui.role) { if (online.ready) scheduleOnlineRefresh(); else renderCurrentViewAfterSync(); }
  });

  document.addEventListener('focusout', () => {
    if (online.pendingRefresh) {
      online.pendingRefresh = false;
      setTimeout(scheduleOnlineRefresh, 80);
    }
  });

  bootOnline();
})();
