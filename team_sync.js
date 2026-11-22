// Viva Spy - Cofre compartilhado da equipe (Supabase, plano gratuito).
//
// Como funciona (local-first): cada minerador continua gravando tudo no próprio navegador; este
// módulo, em segundo plano, ENVIA o que é novo e BAIXA o que os outros acharam. Se a internet ou o
// Supabase falharem, nada quebra: o que ficou pendente segue na fila e sai no próximo ciclo.
// Só quem tem o "código da equipe" lê e grava (verificado dentro do banco, ver SUPABASE_SETUP.sql).
//
// Carregado no service worker por importScripts (depois de ranking_engine.js).

const VIVA_TEAM_URL = "https://zkgohmayzleupmswaeqh.supabase.co";
// Chave "publishable" do Supabase: foi feita para ficar em aplicativos públicos. A proteção dos
// dados é o código da equipe, checado dentro das funções do banco — nunca a chave.
const VIVA_TEAM_KEY = "sb_publishable_x1JPcK7Ilvb82tow2-ZgUg_RR6qhnrC";

const TEAM_STORE = {
  code: "viva_team_code",
  name: "viva_team_name",
  meta: "viva_team_meta",           // { [chave]: { by, status, statusBy, statusMs } }
  dirty: "viva_sync_dirty",         // chaves de criativos a enviar
  dirtyStatus: "viva_sync_dirty_status", // chaves cujo status mudou localmente
  state: "viva_sync_state",         // { ok, at, pushed, pulled, error, off }
  cursor: "viva_sync_cursor",       // última posição lida do cofre
  seeded: "viva_sync_seeded",       // já marcou o acervo antigo para envio?
  radar: "viva_team_radar",         // { at, now, items:[{by,ms,info}] } — sinal de vida dos radares da equipe
};
const TEAM_STATUSES = ["nova", "analise", "minerada", "descartada"];
const TEAM_PUSH_BATCH = 150;
const TEAM_PULL_PAGE = 500;
const TEAM_MIN_GAP_MS = 45 * 1000;
const TEAM_ALARM_PERIODIC = "viva_team_sync";
const TEAM_ALARM_SOON = "viva_team_sync_soon";
const TEAM_DIRTY_CAP = 4000;

let _teamSerial = fn => Promise.resolve().then(fn);
let _teamSyncRunning = null;

// `serial` = fila de escrita do acervo (a mesma do background) — impede que dois leitores/escritores
// sobrescrevam um ao outro.
function teamSyncInit(options) {
  if (options && typeof options.serial === "function") _teamSerial = options.serial;
}

async function teamConfig() {
  const data = await chrome.storage.local.get([TEAM_STORE.code, TEAM_STORE.name]);
  const code = String(data[TEAM_STORE.code] || "").trim();
  if (code.length < 8) return null;
  const name = String(data[TEAM_STORE.name] || "").trim().slice(0, 40) || "Minerador";
  return { code, name };
}

function teamFriendlyError(error) {
  const msg = String((error && error.message) || error || "");
  if (/codigo_invalido/i.test(msg)) return "Código da equipe inválido";
  if (/could not find the function|PGRST202|relation .* does not exist|schema cache/i.test(msg)) {
    return "Banco ainda não configurado (rode o SUPABASE_SETUP.sql)";
  }
  if (/abort/i.test(msg)) return "Tempo esgotado ao falar com o Supabase";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Sem conexão com o Supabase";
  return msg.slice(0, 140) || "Erro desconhecido";
}

async function teamRpc(fn, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${VIVA_TEAM_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: VIVA_TEAM_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = JSON.parse(text).message || text; } catch (_) { /* texto puro */ }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

// ATENÇÃO: só chamar de dentro da fila serializada (_teamSerial / acervoWriteChain).
async function teamMarkDirtyRaw(keys) {
  const lista = (Array.isArray(keys) ? keys : []).filter(Boolean);
  if (!lista.length) return;
  const data = await chrome.storage.local.get(TEAM_STORE.dirty);
  const set = new Set(Array.isArray(data[TEAM_STORE.dirty]) ? data[TEAM_STORE.dirty] : []);
  lista.forEach(k => set.add(k));
  let arr = Array.from(set);
  if (arr.length > TEAM_DIRTY_CAP) arr = arr.slice(arr.length - TEAM_DIRTY_CAP);
  await chrome.storage.local.set({ [TEAM_STORE.dirty]: arr });
}

async function teamAgendarSync() {
  try {
    if (!chrome.alarms) return;
    chrome.alarms.create(TEAM_ALARM_SOON, { when: Date.now() + 10 * 1000 });
  } catch (_) { /* alarmes indisponíveis: o ciclo periódico cobre */ }
}

async function teamEnsureAlarms() {
  try {
    if (!chrome.alarms) return;
    const existente = await chrome.alarms.get(TEAM_ALARM_PERIODIC);
    if (!existente) chrome.alarms.create(TEAM_ALARM_PERIODIC, { delayInMinutes: 1, periodInMinutes: 3 });
  } catch (_) { /* ignora */ }
}

function teamHandleAlarm(alarm) {
  if (!alarm) return;
  if (alarm.name === TEAM_ALARM_PERIODIC || alarm.name === TEAM_ALARM_SOON) {
    teamSyncNow({ force: true }).catch(() => {});
  }
}

async function teamSetState(state) {
  await chrome.storage.local.set({ [TEAM_STORE.state]: state });
}

async function teamPushCreatives(cfg, stats) {
  for (let guard = 0; guard < 30; guard += 1) {
    const batch = await _teamSerial(async () => {
      const data = await chrome.storage.local.get([TEAM_STORE.dirty, VIVA_ACERVO_KEY]);
      const dirty = Array.isArray(data[TEAM_STORE.dirty]) ? data[TEAM_STORE.dirty] : [];
      if (!dirty.length) return null;
      const mapa = new Map((Array.isArray(data[VIVA_ACERVO_KEY]) ? data[VIVA_ACERVO_KEY] : []).map(c => [acervoKey(c), c]));
      const keys = dirty.slice(0, TEAM_PUSH_BATCH);
      const items = [];
      keys.forEach(key => { const rec = mapa.get(key); if (rec) items.push({ key, rec }); });
      return { keys, items };
    });
    if (!batch) return;
    if (batch.items.length) {
      await teamRpc("viva_push", { p_token: cfg.code, p_by: cfg.name, p_items: batch.items });
      stats.pushed += batch.items.length;
    }
    await _teamSerial(async () => {
      const data = await chrome.storage.local.get(TEAM_STORE.dirty);
      const enviados = new Set(batch.keys);
      const resto = (Array.isArray(data[TEAM_STORE.dirty]) ? data[TEAM_STORE.dirty] : []).filter(k => !enviados.has(k));
      await chrome.storage.local.set({ [TEAM_STORE.dirty]: resto });
    });
  }
}

async function teamPushStatuses(cfg) {
  const data = await chrome.storage.local.get([TEAM_STORE.dirtyStatus, TEAM_STORE.meta]);
  const pendentes = (Array.isArray(data[TEAM_STORE.dirtyStatus]) ? data[TEAM_STORE.dirtyStatus] : []).slice(0, 60);
  const meta = data[TEAM_STORE.meta] || {};
  for (const key of pendentes) {
    const entry = meta[key];
    if (entry && TEAM_STATUSES.includes(entry.status)) {
      await teamRpc("viva_set_status", {
        p_token: cfg.code,
        p_key: key,
        p_status: entry.status,
        p_by: entry.statusBy || cfg.name,
        p_ms: Number(entry.statusMs) || Date.now(),
      });
    }
    await _teamSerial(async () => {
      const atual = await chrome.storage.local.get(TEAM_STORE.dirtyStatus);
      const resto = (Array.isArray(atual[TEAM_STORE.dirtyStatus]) ? atual[TEAM_STORE.dirtyStatus] : []).filter(k => k !== key);
      await chrome.storage.local.set({ [TEAM_STORE.dirtyStatus]: resto });
    });
  }
}

async function teamPull(cfg, stats) {
  const base = await chrome.storage.local.get(TEAM_STORE.cursor);
  let cursor = Number(base[TEAM_STORE.cursor]) || 0;
  for (let page = 0; page < 20; page += 1) {
    const rows = await teamRpc("viva_pull", { p_token: cfg.code, p_since: cursor, p_limit: TEAM_PULL_PAGE });
    if (!Array.isArray(rows) || !rows.length) break;
    await _teamSerial(async () => {
      const data = await chrome.storage.local.get([VIVA_ACERVO_KEY, TEAM_STORE.meta, VIVA_LIXEIRA_KEY]);
      const resultado = mesclarRemotos(data[VIVA_ACERVO_KEY], rows, Date.now(), undefined, lixeiraNormalizar(data[VIVA_LIXEIRA_KEY]));
      const meta = data[TEAM_STORE.meta] && typeof data[TEAM_STORE.meta] === "object" ? data[TEAM_STORE.meta] : {};
      for (const row of rows) {
        if (!row || !row.key) continue;
        const atual = meta[row.key];
        const remoto = {
          by: String(row.by || "").slice(0, 40),
          status: TEAM_STATUSES.includes(row.status) ? row.status : "nova",
          statusBy: String(row.statusBy || "").slice(0, 40),
          statusMs: Number(row.statusMs) || 0,
        };
        // Se o minerador mudou o status localmente depois do que o servidor tem, vale o local.
        meta[row.key] = atual && (Number(atual.statusMs) || 0) > remoto.statusMs
          ? { ...atual, by: remoto.by || atual.by || "" }
          : remoto;
      }
      const vivos = new Set(resultado.acervo.map(acervoKey));
      Object.keys(meta).forEach(k => { if (!vivos.has(k)) delete meta[k]; });
      await chrome.storage.local.set({ [VIVA_ACERVO_KEY]: resultado.acervo, [TEAM_STORE.meta]: meta });
    });
    stats.pulled += rows.length;
    cursor = rows.reduce((max, row) => Math.max(max, Number(row.seq) || 0), cursor);
    await chrome.storage.local.set({ [TEAM_STORE.cursor]: cursor });
    if (rows.length < TEAM_PULL_PAGE) break;
  }
}

// Radar: avisa o cofre "estou viva" (nunca derruba nada se falhar — SQL antigo, sem internet etc.).
async function teamPing(info) {
  try {
    const cfg = await teamConfig();
    if (!cfg) return false;
    await teamRpc("viva_ping", { p_token: cfg.code, p_by: cfg.name, p_info: info && typeof info === "object" ? info : {} });
    return true;
  } catch (error) {
    console.warn(`[VIVA][TEAM] ping do radar falhou: ${teamFriendlyError(error)}`);
    return false;
  }
}

// Lê o sinal de vida de todos os radares da equipe e guarda para o Centro mostrar.
async function teamPullRadar(cfg) {
  try {
    const r = await teamRpc("viva_status", { p_token: cfg.code });
    const items = r && Array.isArray(r.items) ? r.items : [];
    await chrome.storage.local.set({ [TEAM_STORE.radar]: { at: Date.now(), now: Number(r && r.now) || Date.now(), items } });
  } catch (error) {
    // banco ainda sem as funções novas (SQL não rodou de novo): o resto da sincronização segue normal
    await chrome.storage.local.set({ [TEAM_STORE.radar]: { at: Date.now(), now: Date.now(), items: [], error: teamFriendlyError(error) } });
  }
}

async function _teamSyncInner() {
  const cfg = await teamConfig();
  if (!cfg) {
    const state = { ok: false, off: true, at: Date.now(), pushed: 0, pulled: 0, error: "" };
    await teamSetState(state);
    return state;
  }
  const stats = { ok: false, off: false, at: Date.now(), pushed: 0, pulled: 0, error: "" };
  try {
    // 1ª vez: tudo que já existe no acervo local vai para a equipe.
    await _teamSerial(async () => {
      const data = await chrome.storage.local.get([TEAM_STORE.seeded, VIVA_ACERVO_KEY]);
      if (data[TEAM_STORE.seeded]) return;
      const keys = (Array.isArray(data[VIVA_ACERVO_KEY]) ? data[VIVA_ACERVO_KEY] : []).map(acervoKey).filter(Boolean);
      await teamMarkDirtyRaw(keys);
      await chrome.storage.local.set({ [TEAM_STORE.seeded]: true });
    });
    await teamPushCreatives(cfg, stats);
    await teamPushStatuses(cfg);
    await teamPull(cfg, stats);
    await teamPullRadar(cfg);
    stats.ok = true;
  } catch (error) {
    stats.error = teamFriendlyError(error);
    console.warn(`[VIVA][TEAM] sincronização falhou: ${stats.error}`);
  }
  stats.at = Date.now();
  await teamSetState(stats);
  return stats;
}

// `force` ignora o intervalo mínimo entre ciclos (usado pelo botão "Sincronizar agora" e alarmes).
function teamSyncNow(options) {
  if (_teamSyncRunning) return _teamSyncRunning;
  const force = Boolean(options && options.force);
  _teamSyncRunning = (async () => {
    try {
      if (!force) {
        const data = await chrome.storage.local.get(TEAM_STORE.state);
        const last = data[TEAM_STORE.state];
        if (last && last.ok && Date.now() - (Number(last.at) || 0) < TEAM_MIN_GAP_MS) return last;
      }
      return await _teamSyncInner();
    } finally {
      _teamSyncRunning = null;
    }
  })();
  return _teamSyncRunning;
}

// Mudou código/nome: recomeça do zero (re-envia o acervo local e relê o cofre inteiro).
async function teamConfigChanged() {
  await chrome.storage.local.remove([TEAM_STORE.cursor, TEAM_STORE.seeded, TEAM_STORE.dirty, TEAM_STORE.dirtyStatus, TEAM_STORE.radar]);
  await teamEnsureAlarms();
  return teamSyncNow({ force: true });
}

function teamSetStatus(key, status) {
  if (!key || !TEAM_STATUSES.includes(status)) return Promise.resolve({ status: "error", error: "status inválido" });
  return _teamSerial(async () => {
    const cfg = await teamConfig();
    const data = await chrome.storage.local.get([TEAM_STORE.meta, TEAM_STORE.dirtyStatus]);
    const meta = data[TEAM_STORE.meta] && typeof data[TEAM_STORE.meta] === "object" ? data[TEAM_STORE.meta] : {};
    meta[key] = { ...(meta[key] || {}), status, statusBy: cfg ? cfg.name : "", statusMs: Date.now() };
    const sujos = new Set(Array.isArray(data[TEAM_STORE.dirtyStatus]) ? data[TEAM_STORE.dirtyStatus] : []);
    sujos.add(key);
    await chrome.storage.local.set({ [TEAM_STORE.meta]: meta, [TEAM_STORE.dirtyStatus]: Array.from(sujos) });
    if (cfg) teamAgendarSync();
    return { status: "ok" };
  });
}

// Mesmo que teamSetStatus, mas para várias chaves de uma vez (descartar em lote no Centro).
function teamSetStatusLote(keys, status) {
  const lista = Array.isArray(keys) ? Array.from(new Set(keys.filter(Boolean))) : [];
  if (!lista.length || !TEAM_STATUSES.includes(status)) return Promise.resolve({ status: "error", error: "lote ou status inválido" });
  return _teamSerial(async () => {
    const cfg = await teamConfig();
    const data = await chrome.storage.local.get([TEAM_STORE.meta, TEAM_STORE.dirtyStatus]);
    const meta = data[TEAM_STORE.meta] && typeof data[TEAM_STORE.meta] === "object" ? data[TEAM_STORE.meta] : {};
    const agora = Date.now();
    const sujos = new Set(Array.isArray(data[TEAM_STORE.dirtyStatus]) ? data[TEAM_STORE.dirtyStatus] : []);
    lista.forEach(key => {
      meta[key] = { ...(meta[key] || {}), status, statusBy: cfg ? cfg.name : "", statusMs: agora };
      sujos.add(key);
    });
    await chrome.storage.local.set({ [TEAM_STORE.meta]: meta, [TEAM_STORE.dirtyStatus]: Array.from(sujos) });
    if (cfg) teamAgendarSync();
    return { status: "ok", alterados: lista.length };
  });
}
