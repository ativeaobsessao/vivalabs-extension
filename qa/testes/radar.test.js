// Radar: motor de histórico/tendência (puro), fila, agenda + rodada completa no background REAL, e merge no SQL REAL.
const fs = require("fs");
const vm = require("vm");
const { execFileSync } = require("child_process");
const DIR = "/home/claude/repo/vivalabs-extension/";
const read = f => fs.readFileSync(DIR + f, "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 86400000;

function makeEnv() {
  const store = {};
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const listeners = [];
  const windowsCreated = [];
  const tabsUpdated = [];
  const removedWindows = [];
  const tabs = new Set();
  const alarmsMap = {};
  const alarmHandlers = [];
  const startupHandlers = [];
  let nextTab = 100;
  const chrome = {
    storage: {
      local: {
        async get(keys) { const out = {}; (keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = clone(store[k]); }); return out; },
        async set(o) { Object.entries(o).forEach(([k, v]) => { store[k] = clone(v); }); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); },
      },
      onChanged: { addListener() {} },
    },
    windows: {
      async create(opts) { const id = nextTab++; tabs.add(id); const win = { id: 500 + id, tabs: [{ id }] }; windowsCreated.push({ opts, win, at: Date.now() }); return win; },
      async remove(id) { removedWindows.push(id); tabs.delete(id - 500); },
    },
    tabs: { async update(id, o) { if (!tabs.has(id)) throw new Error("No tab"); tabsUpdated.push({ id, url: o.url }); return { id }; }, async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return { id }; }, async remove(id) { tabs.delete(id); }, async create() { const id = nextTab++; tabs.add(id); return { id }; } },
    alarms: {
      async get(n) { return alarmsMap[n]; },
      create(n, info) { alarmsMap[n] = { name: n, ...info }; },
      async clear(n) { const had = n in alarmsMap; delete alarmsMap[n]; return had; },
      onAlarm: { addListener: l => alarmHandlers.push(l) },
    },
    runtime: { onMessage: { addListener: l => listeners.push(l) }, onInstalled: { addListener() {} }, onStartup: { addListener: l => startupHandlers.push(l) }, sendMessage: () => Promise.resolve(), getManifest: () => ({ version: JSON.parse(read("manifest.json")).version }) },
    declarativeNetRequest: { async updateSessionRules() {} },
    downloads: { download() {} },
  };
  const ctx = { console: { log() {}, info() {}, warn() {}, error: (...a) => console.log("[BG ERR]", ...a) }, chrome, setTimeout, clearTimeout, URL, URLSearchParams, Promise, Date, Math, JSON, crypto: require("crypto").webcrypto, fetch: async () => ({ ok: true, json: async () => ({}) }), AbortController, importScripts: () => {} };
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["intelligent_parser.js", "ranking_engine.js", "export_data.js", "intel_core.js", "team_sync.js", "notify.js", "auto_export.js", "intel_espaco.js", "intel_abas.js", "radar.js", "background.js"]) vm.runInContext(read(f), ctx);
  const send = (message, tabId) => new Promise(resolve => {
    let answered = false;
    const keep = listeners[0](message, tabId ? { tab: { id: tabId } } : {}, r => { answered = true; resolve(r); });
    if (!keep && !answered) resolve(undefined);
  });
  return { store, ctx, chrome, send, windowsCreated, tabsUpdated, removedWindows, alarmsMap, alarmHandlers, startupHandlers };
}

(async () => {
  // ───────── 1) motor puro: histórico e tendência ─────────
  const E = makeEnv();
  const run = code => vm.runInContext(code, E.ctx);
  const agora = Date.UTC(2026, 10, 22, 15, 0, 0);
  E.ctx.__agora = agora;
  const r1 = JSON.parse(run(`JSON.stringify((() => {
    let h = {};
    const mk = (pid, adv) => ({ pid, nome: "Loja " + pid, adv });
    h = histRegistrar(h, [mk("111111111", 10), mk("222222222", 40)], __agora - 3 * 86400000);
    h = histRegistrar(h, [mk("111111111", 12)], __agora - 3 * 86400000 + 3600e3);      // mesmo dia: fica o maior
    h = histRegistrar(h, [mk("111111111", 30), mk("222222222", 41)], __agora);          // hoje
    h = histRegistrar(h, [{ pid: "abc", adv: 5 }, { pid: "333333333", adv: 0 }], __agora); // inválidos
    const b1 = histBase(h, "111111111", __agora);
    const b2 = histBase(h, "222222222", __agora);
    const b3 = histBase(h, "333333333", __agora);
    const ac = [
      { id: "1".repeat(10), pid: "111111111", nome: "A", adv: 30, lastSeen: __agora, firstSeen: __agora },
      { id: "2".repeat(10), pid: "222222222", nome: "B", adv: 41, lastSeen: __agora, firstSeen: __agora },
    ];
    const ap = aplicarTendencias(ac, h, __agora);
    const t1 = tendenciaCriativo(ap.acervo[0], __agora);
    const t2 = tendenciaCriativo(ap.acervo[1], __agora);
    const ap2 = aplicarTendencias(ap.acervo, h, __agora);
    return { n: Object.keys(h).length, s1: h["111111111"].s.length, base1: b1 && b1.adv, base2: b2 && b2.adv, base3: b3, t1, t2, mudou: ap.mudou.length, mudou2: ap2.mudou.length };
  })())`));
  check("histórico ignora pid inválido e adv 0", r1.n === 2, JSON.stringify(r1));
  check("mesmo dia mantém só uma leitura (a maior)", r1.s1 === 2);
  check("base = leitura de dias atrás (maior do dia)", r1.base1 === 12 && r1.base2 === 40);
  check("sem base quando não há histórico", r1.base3 === null);
  check("biblioteca 12→30 está SUBINDO", r1.t1.sobe === true && r1.t1.delta === 18 && r1.t1.dias === 3, JSON.stringify(r1.t1));
  check("biblioteca 40→41 NÃO sobe (ruído)", r1.t2.sobe === false);
  check("aplicarTendencias marca só o que mudou e é idempotente", r1.mudou === 2 && r1.mudou2 === 0, JSON.stringify([r1.mudou, r1.mudou2]));

  const r2 = JSON.parse(run(`JSON.stringify((() => {
    // histórico antigo (>14 dias) é descartado; cap de páginas
    let h = histRegistrar({}, [{ pid: "111111111", nome: "A", adv: 9 }], __agora - 30 * 86400000);
    h = histRegistrar(h, [{ pid: "222222222", nome: "B", adv: 9 }], __agora);
    return { tem1: !!h["111111111"], tem2: !!h["222222222"] };
  })())`));
  check("leitura com +14 dias sai do histórico", r2.tem1 === false && r2.tem2 === true);

  // mesclarAcervo preserva advBase; mesclarRemotos escolhe a base mais recente
  const r3 = JSON.parse(run(`JSON.stringify((() => {
    const t = __agora;
    const base = [{ id: "1000000001", pid: "111111111", sig: "", nome: "A", copy: "x", dup: 3, adv: 30, advBase: 12, advBaseMs: t - 3 * 86400000, firstSeen: t - 5 * 86400000, lastSeen: t - 1000 }];
    const m = mesclarAcervo(base, [{ id: "1000000001", pid: "111111111", nome: "A", copy: "x", dup: 4, adv: 31 }], t);
    const a = m.acervo[0];
    const remoto = [{ rec: { id: "1000000001", pid: "111111111", nome: "A", copy: "x", dup: 4, adv: 31, advBase: 20, advBaseMs: t - 1 * 86400000, firstSeen: t - 5 * 86400000, lastSeen: t - 500 } }];
    const m2 = mesclarRemotos(m.acervo, remoto, t);
    const remotoAntigo = [{ rec: { id: "1000000001", pid: "111111111", nome: "A", copy: "x", dup: 4, adv: 31, advBase: 5, advBaseMs: t - 9 * 86400000, firstSeen: t - 5 * 86400000, lastSeen: t - 500 } }];
    const m3 = mesclarRemotos(m2.acervo, remotoAntigo, t);
    return { keep: [a.advBase, a.advBaseMs === t - 3 * 86400000], remoto: m2.acervo[0].advBase, antigo: m3.acervo[0].advBase };
  })())`));
  check("mesclarAcervo preserva advBase", r3.keep[0] === 12 && r3.keep[1] === true, JSON.stringify(r3));
  check("mesclarRemotos adota base mais recente", r3.remoto === 20, JSON.stringify(r3));
  check("mesclarRemotos ignora base mais antiga", r3.antigo === 20, JSON.stringify(r3));

  // gerarFilaRadar
  const r4 = JSON.parse(run(`JSON.stringify(gerarFilaRadar('nerve pain\\n"blood sugar"\\n\\nnerve pain\\nx\\njoint', { country: "ca", maximo: 3 }))`));
  check("fila radar: dedup, ignora vazia/curta, respeita máximo", r4.length === 3 && r4[0].q === "nerve pain" && r4[1].exata === true && r4[2].q === "joint", JSON.stringify(r4.map(i => i.q)));
  check("fila radar aceita 1 linha só", JSON.parse(run(`JSON.stringify(gerarFilaRadar("keto").length)`)) === 1);
  check("fila radar limita ao país", /country=CA/.test(r4[0].url) && /search_type=keyword_exact_phrase/.test(r4[1].url) && !/search_type=keyword_exact_phrase/.test(r4[0].url), r4[1].url);

  // ───────── 2) agenda e rodada completa no background real ─────────
  check("alarme do radar NÃO existe com radar desligado", !E.alarmsMap.viva_radar_tick);
  check("ganchos de reinício registrados", E.startupHandlers.length >= 1);

  // liga sem palavras-chave → erro claro
  E.store.viva_radar_config = { on: true, keywords: "", country: "US", everyH: 6 };
  let st = await E.send({ action: "RADAR_CONFIG_CHANGED" });
  check("ligar sem palavra-chave dá erro amigável", st.state.status === "error" && /palavra-chave/.test(st.state.lastError), JSON.stringify(st));

  // liga de verdade (2 palavras) — pausas curtas via radarDeps? usamos Rodar agora
  E.store.viva_radar_config = { on: true, keywords: "keto truque\nansiedade controle\n\"sono profundo\"", country: "US", everyH: 4, tempoPorBusca: 20 };
  st = await E.send({ action: "RADAR_CONFIG_CHANGED" });
  check("alarme criado ao ligar", !!E.alarmsMap.viva_radar_tick && E.alarmsMap.viva_radar_tick.periodInMinutes === 5);
  check("estado fica 'waiting' com próxima rodada", st.state.status === "waiting" && st.state.nextRunAt > Date.now());

  // pausa curta para o teste não esperar 8–25s
  const origIniciar = E.ctx.iniciarMineracaoInteligente;
  const comPausaCurta = (l, o, c) => origIniciar(l, { ...o, pausaMinMs: 1200, pausaMaxMs: 1500 }, c);
  E.ctx.radarInit({ iniciar: comPausaCurta });

  const fetchCalls = [];
  E.ctx.fetch = async (url, opts) => { fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => "" }; };
  E.store.viva_notify_config = { tipo: "discord", webhook: "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL" };
  const resp = await E.send({ action: "RADAR_RUN_NOW" });
  check("Rodar agora inicia a rodada", resp && resp.status === "started" && resp.total === 3, JSON.stringify(resp));
  await sleep(700);
  const estado = await E.send({ action: "GET_INTELIGENTE_STATE" });
  const ist = JSON.parse(JSON.stringify(E.store.viva_inteligente_state));
  check("rodada marcada como origem radar, 1 por vez", ist.origem === "radar" && ist.maxParallel === 1);
  check("1ª janela aberta, só uma", E.windowsCreated.length === 1, String(E.windowsCreated.length));
  check("busca do radar usa país US", /country=US/.test(E.windowsCreated[0].opts.url), E.windowsCreated[0].opts.url);
  let rs = JSON.parse(JSON.stringify(E.store.viva_radar_state));
  check("radar mostra 'running'", rs.status === "running");
  // Rodar agora de novo enquanto roda não duplica
  const resp2 = await E.send({ action: "RADAR_RUN_NOW" });
  check("não inicia segunda rodada em paralelo", resp2 && resp2.status === "running", JSON.stringify(resp2));

  // simula a aba terminando as 3 buscas e mandando criativos
  const finalizarJanela = async (idx) => {
    const tab = E.windowsCreated[0].win.tabs[0].id;     // sessão única: sempre a mesma aba
    const ctx = await E.send({ action: "GET_MINER_CONTEXT" }, tab);
    await E.send({
      action: "ACERVO_UPSERT",
      creatives: [1, 2, 3].map(i => ({ id: String(500000000000 + idx * 10 + i), pid: "99900000" + (idx % 2), nome: "Loja " + (idx % 2), copy: "copy " + idx + i, dup: 5 + i, adv: 20 + idx * 10, dias: 12, inicio: Date.now() - 12 * DAY, stage: "bruta", fonte: ctx && ctx.q })),
    });
    await E.send({ action: "MINER_DONE", runId: ctx.runId, planId: ctx.planId, motivo: "teste", cards: 3 }, tab);
  };
  await finalizarJanela(0);
  const t0 = Date.now();
  await sleep(900);
  check("pausa de ritmo humano: a 2ª busca não começa na hora", E.tabsUpdated.length === 0, String(E.tabsUpdated.length));
  let esperou = 0;
  while (E.tabsUpdated.length < 1 && esperou < 6000) { await sleep(200); esperou += 200; }
  check("2ª busca navega a MESMA janela depois da pausa", E.windowsCreated.length === 1 && E.tabsUpdated.length === 1, `${E.windowsCreated.length}/${E.tabsUpdated.length}`);
  await finalizarJanela(1);
  esperou = 0; while (E.tabsUpdated.length < 2 && esperou < 6000) { await sleep(200); esperou += 200; }
  check("3ª busca também na mesma janela", E.windowsCreated.length === 1 && E.tabsUpdated.length === 2, `${E.windowsCreated.length}/${E.tabsUpdated.length}`);
  check("3ª busca é frase exata, com aspas no q", /keyword_exact_phrase/.test(E.tabsUpdated[1].url) && new URL(E.tabsUpdated[1].url).searchParams.get("q") === '"sono profundo"', E.tabsUpdated[1].url);
  check("buscas do radar carregam idioma", /content_languages%5B0%5D=en/.test(E.windowsCreated[0].opts.url), E.windowsCreated[0].opts.url);
  await finalizarJanela(2);
  esperou = 0; while (esperou < 6000) { rs = JSON.parse(JSON.stringify(E.store.viva_radar_state)); if (rs.status !== "running") break; await sleep(200); esperou += 200; }
  check("rodada termina e radar volta a 'waiting'", rs.status === "waiting", JSON.stringify(rs));
  check("resumo da rodada gravado", rs.lastSummary && rs.lastSummary.criativos >= 9 && rs.lastSummary.emEscala >= 1 && rs.lastSummary.novos >= 9, JSON.stringify(rs.lastSummary));
  const diff = rs.nextRunAt - Date.now();
  check("próxima rodada em ~4h", diff > 3.9 * 3600e3 && diff < 4.1 * 3600e3, String(diff));
  await sleep(200);
  const avisos = fetchCalls.filter(c => /discord\.com/.test(c.url));
  check("fim da rodada avisa no Discord (criativos em escala novos)", avisos.length === 1 && /em escala/.test(avisos[0].body.content), JSON.stringify(avisos.map(a => a.body && a.body.content && a.body.content.slice(0, 80))));
  check("aviso do radar sem menções", avisos[0] && avisos[0].body.allowed_mentions.parse.length === 0);
  check("criativos avisados ficam registrados (não repete)", Array.isArray(E.store.viva_notified) && E.store.viva_notified.length >= 1);
  const hist = E.store.viva_hist;
  check("janela única fechada ao fim da rodada", E.removedWindows.length === 1 && E.removedWindows[0] === E.windowsCreated[0].win.id, JSON.stringify(E.removedWindows));
  check("histórico por biblioteca gravado", hist && hist["999000000"] && hist["999000001"], JSON.stringify(hist));

  // alarme: antes da hora = nada; depois da hora = nova rodada
  let abriu = 0;
  E.ctx.radarInit({ iniciar: async () => { abriu += 1; return { runId: "r", total: 3 }; } });   // não abre janelas de verdade
  E.store.viva_radar_state = { ...E.store.viva_radar_state, status: "waiting", nextRunAt: Date.now() + 3600e3 };
  abriu = 0;
  E.alarmHandlers.forEach(h => h({ name: "viva_radar_tick" })); await sleep(100);
  check("alarme antes da hora não abre rodada", abriu === 0);
  E.store.viva_radar_state = { ...E.store.viva_radar_state, status: "waiting", nextRunAt: Date.now() - 1000 };
  E.alarmHandlers.forEach(h => h({ name: "viva_radar_tick" })); await sleep(150);
  check("alarme depois da hora abre rodada", abriu === 1, String(abriu));
  E.alarmHandlers.forEach(h => h({ name: "viva_radar_tick" })); await sleep(100);
  check("alarme seguinte com rodada em andamento não duplica", abriu === 1, String(abriu));

  // travada >4h é liberada
  E.store.viva_radar_state = { ...E.store.viva_radar_state, status: "running", startedAt: Date.now() - 5 * 3600e3, nextRunAt: Date.now() - 1000 };
  abriu = 0; E.alarmHandlers.forEach(h => h({ name: "viva_radar_tick" })); await sleep(150);
  check("rodada travada há 5h é liberada", abriu === 1, String(abriu));

  // sinal de vida: com equipe configurada, o tick manda ping com o estado do radar
  E.store.viva_team_name = "Notebook"; E.store.viva_team_code = "CODIGO-DE-TESTE-1";
  fetchCalls.length = 0;
  E.store.viva_radar_state = { ...E.store.viva_radar_state, status: "waiting", nextRunAt: Date.now() + 3600e3, lastRunAt: Date.now() - 1800e3 };
  E.alarmHandlers.forEach(h => h({ name: "viva_radar_tick" })); await sleep(200);
  const pings = fetchCalls.filter(c => /rpc\/viva_ping/.test(c.url));
  check("cada tick do radar manda ping", pings.length === 1, String(pings.length));
  check("ping leva nome, ligado, intervalo e versão", pings[0] && pings[0].body.p_by === "Notebook" && pings[0].body.p_info.on === true && pings[0].body.p_info.everyH === 4 && /^\d+\.\d+\.\d+$/.test(String(pings[0].body.p_info.v)) && pings[0].body.p_info.n === 3, JSON.stringify(pings[0] && pings[0].body));
  check("ping não leva as palavras-chave (privacidade)", !/keto|ansiedade|sono/.test(JSON.stringify(pings[0].body)));

  // desligar remove o alarme
  E.store.viva_radar_config = { ...E.store.viva_radar_config, on: false };
  await E.send({ action: "RADAR_CONFIG_CHANGED" });
  check("desligar remove o alarme", !E.alarmsMap.viva_radar_tick);
  await sleep(150);
  const ultimo = fetchCalls.filter(c => /rpc\/viva_ping/.test(c.url)).pop();
  check("desligar avisa a equipe com on:false (sem alarme falso)", ultimo && ultimo.body.p_info.on === false, JSON.stringify(ultimo && ultimo.body));
  abriu = 0; E.alarmHandlers.forEach(h => h({ name: "viva_radar_tick" })); await sleep(100);
  check("desligado, o tick não faz nada", abriu === 0);

  // ───────── 3) SQL real: merge do advBase ─────────
  const CODE = fs.readFileSync("/home/claude/work/team_code.txt", "utf8").trim();
  const psql = sql => execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-At", "-q", "-c", "set role anon", "-c", sql, "postgres"], { encoding: "utf8" }).trim();
  const push = (rec, by) => psql(`select public.viva_push('${CODE}','${by}','${JSON.stringify([{ key: "id:7770001", rec }]).replace(/'/g, "''")}'::jsonb)`);
  execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-q", "-c", "delete from public.viva_creatives where key='id:7770001'", "postgres"]);
  const t = Date.now();
  push({ id: "7770001", pid: "111111111", nome: "A", adv: 30, dup: 2, advBase: 12, advBaseMs: t - 3 * DAY, firstSeen: t - 5 * DAY, lastSeen: t }, "Ana");
  push({ id: "7770001", pid: "111111111", nome: "A", adv: 28, dup: 3, advBase: 5, advBaseMs: t - 9 * DAY, firstSeen: t - 5 * DAY, lastSeen: t }, "Radar");
  const lerRec = () => JSON.parse(execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-At", "-q", "-c", "select rec from public.viva_creatives where key='id:7770001'", "postgres"], { encoding: "utf8" }).trim());
  let rec = lerRec();
  check("SQL: base mais recente vence a mais antiga", Number(rec.advBase) === 12 && Number(rec.advBaseMs) === t - 3 * DAY, JSON.stringify(rec));
  check("SQL: adv e dup continuam no maior", Number(rec.adv) === 30 && Number(rec.dup) === 3, JSON.stringify(rec));
  push({ id: "7770001", pid: "111111111", nome: "A", adv: 35, dup: 3, advBase: 25, advBaseMs: t - 1 * DAY, firstSeen: t - 5 * DAY, lastSeen: t }, "Radar");
  rec = lerRec();
  check("SQL: base mais nova substitui a antiga", Number(rec.advBase) === 25, JSON.stringify(rec));

  console.log(fails ? `\n${fails} FALHA(S)` : "\nTODOS OS TESTES DO RADAR PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERRO NO TESTE", e); process.exit(1); });
