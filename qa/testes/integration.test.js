// Integração: background.js + content.js REAIS, com chrome falso e DOM simulado (jsdom).
const fs = require("fs");
const vm = require("vm");
const { JSDOM } = require("jsdom");
const DIR = "/home/claude/repo/vivalabs-extension/";
const read = f => fs.readFileSync(DIR + f, "utf8");

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── chrome falso compartilhado (um storage, vários "contextos") ──
function makeChrome() {
  const store = {};
  const storageListeners = [];
  const bgMessageListeners = [];
  const windowsCreated = [];
  const tabsUpdated = [];
  const removedWindows = [];
  const tabsAlive = new Set();
  let nextTab = 100;
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const fireChange = (changes) => storageListeners.forEach(l => { try { l(changes, "local"); } catch (e) { console.log("listener err", e.message); } });
  const chromeBase = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          list.forEach(k => { if (k in store) out[k] = clone(store[k]); });
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(store[k]), newValue: clone(v) }; store[k] = clone(v); }
          fireChange(changes);
        },
        async remove(keys) {
          const changes = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) { changes[k] = { oldValue: clone(store[k]) }; delete store[k]; } });
          if (Object.keys(changes).length) fireChange(changes);
        },
      },
      onChanged: { addListener: l => storageListeners.push(l), removeListener: l => { const i = storageListeners.indexOf(l); if (i >= 0) storageListeners.splice(i, 1); } },
    },
    windows: {
      async create(opts) { const tabId = nextTab++; tabsAlive.add(tabId); const win = { id: 500 + tabId, tabs: [{ id: tabId }] }; windowsCreated.push({ opts, win }); return win; },
      async remove(id) { removedWindows.push(id); const t = id - 500; tabsAlive.delete(t); },
    },
    tabs: {
      async get(id) { if (!tabsAlive.has(id)) throw new Error("No tab"); return { id }; },
      async update(id, o) { if (!tabsAlive.has(id)) throw new Error("No tab"); tabsUpdated.push({ id, url: o.url }); return { id }; },
      async remove(id) { tabsAlive.delete(id); },
      async create(o) { const id = nextTab++; tabsAlive.add(id); return { id }; },
      async query() { return []; },
    },
    declarativeNetRequest: { async updateSessionRules() {} },
    downloads: { download() {} },
  };
  return { store, storageListeners, bgMessageListeners, windowsCreated, tabsUpdated, removedWindows, tabsAlive, chromeBase, fireChange };
}

(async () => {
  const env = makeChrome();

  // ── BACKGROUND ──
  const bgChrome = {
    ...env.chromeBase,
    runtime: {
      onMessage: { addListener: l => env.bgMessageListeners.push(l) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: () => Promise.resolve(),
      getManifest: () => ({ version: "0.0.0" }),
      getURL: arquivo => `chrome-extension://teste/${arquivo}`,
    },
  };
  const bgCtx = { console: { log() {}, info() {}, warn() {}, error: (...a) => console.log("[BG ERR]", ...a) }, chrome: bgChrome, setTimeout, clearTimeout, URL, URLSearchParams, Promise, Date, Math, JSON, crypto: require("crypto").webcrypto, fetch: async () => ({ ok: true, json: async () => ({}) }), AbortController, importScripts: () => {} };
  bgCtx.self = bgCtx;
  vm.createContext(bgCtx);
  vm.runInContext(read("intelligent_parser.js"), bgCtx);
  vm.runInContext(read("ranking_engine.js"), bgCtx);
  vm.runInContext(read("export_data.js"), bgCtx);
  vm.runInContext(read("intel_core.js"), bgCtx);
  vm.runInContext(read("team_sync.js"), bgCtx);
  vm.runInContext(read("notify.js"), bgCtx);
  vm.runInContext(read("auto_export.js"), bgCtx);
  vm.runInContext(read("intel_espaco.js"), bgCtx);
  vm.runInContext(read("intel_abas.js"), bgCtx);
  vm.runInContext(read("radar.js"), bgCtx);
  vm.runInContext(read("background.js"), bgCtx);
  check("background carregou e registrou listener", env.bgMessageListeners.length === 1);

  const sendToBg = (message, tabId) => new Promise(resolve => {
    let answered = false;
    const sender = tabId ? { tab: { id: tabId } } : {};
    const keep = env.bgMessageListeners[0](message, sender, r => { answered = true; resolve(r); });
    if (!keep && !answered) resolve(undefined);
  });

  // ── CONTENT (aba do operador) ──
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div role="main"><div id="feed">feed</div></div></body></html>`, { url: "https://www.facebook.com/ads/library/?active_status=active&country=BR&q=teste&search_type=keyword_unordered", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  const toasts = [];
  win.chrome = {
    ...env.chromeBase,
    runtime: { sendMessage: (m) => sendToBg(m, 7), onMessage: { addListener() {} }, id: "x" },
  };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.requestAnimationFrame = cb => setTimeout(cb, 0);
  win.scrollTo = () => {};
  win.fetch = async () => ({ ok: true, json: async () => ({}) });
  const silent = { log() {}, info() {}, debug() {}, warn: (...a) => console.log("[CS WARN]", ...a), error: (...a) => console.log("[CS ERR]", ...a) };
  win.console = silent;
  const vmCtx = dom.getInternalVMContext();
  for (const f of ["intelligent_parser.js", "ranking_engine.js", "export_data.js", "monitor_url.js", "content.js"]) new vm.Script(read(f), { filename: f }).runInContext(vmCtx);
  await sleep(300);

  // ── 1) Busca Normal navega por URL (mantendo país) ──
  let navegou = null;
  new vm.Script("vivaNavigate = function(u){ window.__nav = u; }").runInContext(vmCtx);
  await sleep(50);
  new vm.Script("injectTopBar()").runInContext(vmCtx);
  const input = win.document.querySelector("#viva-mass-keywords");
  const btn = win.document.querySelector("#viva-btn-minerar");
  check("topbar e painel de busca injetados", !!input && !!btn);
  input.value = "emagrecimento keto";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  btn.click();
  await sleep(100);
  const nav = win.__nav ? new URL(win.__nav) : null;
  check("normal: navegou para a URL de busca", !!nav && nav.searchParams.get("q") === "emagrecimento keto", String(win.__nav));
  check("normal: país/idioma vêm do painel (padrão US/en), não da URL antiga", nav && nav.searchParams.get("country") === "US" && nav.searchParams.get("content_languages[0]") === "en", String(win.__nav));
  check("normal: tipo de anúncio sempre 'all' (não herda políticas)", nav && nav.searchParams.get("ad_type") === "all");
  check("normal: host da própria aba", nav && nav.host === "www.facebook.com");
  win.__nav = null;
  input.value = '"keto truque"';
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  btn.click(); await sleep(100);
  check("normal: frase exata usa keyword_exact_phrase", win.__nav && new URL(win.__nav).searchParams.get("search_type") === "keyword_exact_phrase", String(win.__nav));
  check("normal: frase exata vai entre aspas no q", win.__nav && new URL(win.__nav).searchParams.get("q") === '"keto truque"', String(win.__nav));

  // ── 1b) Busca COMBINADA (padrão com várias linhas): uma pesquisa só, na mesma aba, sem janelas ──
  win.document.querySelector("#viva-busca-dropdown").hidden = false;
  win.__nav = null;
  input.value = 'keto truque\n"ansiedade controle"\nglicemia keto';
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(50);
  check("combinada é o padrão e o botão diz isso", btn.textContent.includes("Buscar combinado (3 termos)"), btn.textContent);
  check("combinada: sem controles de tempo", win.document.querySelector("#viva-turbo-controls").hidden === true);
  btn.click(); await sleep(150);
  const navC = win.__nav ? new URL(win.__nav) : null;
  check("combinada: UMA navegação com todas as palavras", !!navC && navC.searchParams.get("q") === "keto truque ansiedade controle glicemia" && navC.searchParams.get("search_type") === "keyword_unordered", String(win.__nav));
  check("combinada: país/idioma do painel", navC && navC.searchParams.get("country") === "US" && navC.searchParams.get("content_languages[0]") === "en");
  check("combinada: nenhuma janela aberta", env.windowsCreated.length === 0, String(env.windowsCreated.length));
  // muitas palavras: aviso
  input.value = "a1 b2 c3 d4 e5 f6\ng7 h8 i9 j0 k1 l2";
  input.dispatchEvent(new win.Event("input", { bubbles: true })); await sleep(50);
  check("combinada: avisa quando há muitas palavras", win.document.querySelector("#viva-busca-info").textContent.includes("pouquíssimos"), win.document.querySelector("#viva-busca-info").textContent);

  // ── 2) Turbo: confirmação inline em 2 cliques ──
  win.document.querySelector("#viva-busca-dropdown").hidden = false;
  const modoSel = win.document.querySelector("#viva-busca-modo");
  modoSel.value = "sequencia"; modoSel.dispatchEvent(new win.Event("change", { bubbles: true }));
  input.value = "keto truque\nansiedade controle";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  btn.click(); await sleep(50);
  check("turbo: 1º clique só arma a confirmação", btn.textContent.includes("Confirmar") && env.windowsCreated.length === 0, btn.textContent);
  btn.click(); await sleep(600);
  check("turbo: 2º clique abre janela(s) de mineração", env.windowsCreated.length >= 1, String(env.windowsCreated.length));
  check("turbo: sessão única = 1 janela", env.windowsCreated.length === 1);
  check("turbo: janela é popup visível (não focada)", env.windowsCreated[0] && env.windowsCreated[0].opts.type === "popup" && env.windowsCreated[0].opts.focused === false);
  const url1 = new URL(env.windowsCreated[0].opts.url);
  check("turbo: URL inclui o termo", url1.searchParams.get("q") === "keto truque", env.windowsCreated[0].opts.url);

  // ── 3) Contexto por tabId + coleta + MINER_DONE (simula as janelas) ──
  const tabA = env.windowsCreated[0].win.tabs[0].id;
  const ctxA = await sendToBg({ action: "GET_MINER_CONTEXT" }, tabA);
  check("GET_MINER_CONTEXT devolve contexto pela aba", ctxA && ctxA.q === "keto truque" && ctxA.runId, JSON.stringify(ctxA));
  check("GET_MINER_CONTEXT nega aba desconhecida", (await sendToBg({ action: "GET_MINER_CONTEXT" }, 9999)) === null);
  const mk = (i, over = {}) => ({ id: String(300000000000000 + i), pid: "11122233" + (i % 3), sig: "s" + i, nome: "Loja " + (i % 3), copy: "Texto do criativo " + i, dest: "https://oferta" + i + ".com/x", dom: "oferta" + i + ".com", thumb: "https://scontent.fbcdn.net/t" + i + ".jpg", url: "https://www.facebook.com/ads/library/?id=" + i, dup: 3 + i, dias: i % 20, inicio: Date.now() - (i % 20) * 864e5, adv: 10 + i, stage: i % 5 === 0 ? "monstro" : "bruta", fonte: "keto truque", ...over });
  const up = await sendToBg({ action: "ACERVO_UPSERT", creatives: Array.from({ length: 12 }, (_, i) => mk(i)) }, tabA);
  check("ACERVO_UPSERT grava criativos", up && up.status === "ok" && up.total === 12, JSON.stringify(up));
  const prog = await sendToBg({ action: "MINER_PROGRESS", runId: ctxA.runId, cards: 40, escala: 12 }, tabA);
  check("MINER_PROGRESS aceito", prog && prog.status === "ok");
  const bad = await sendToBg({ action: "MINER_DONE", runId: "outro", planId: ctxA.planId }, tabA);
  check("MINER_DONE com runId errado é ignorado", bad && bad.status === "ignored");
  const done = await sendToBg({ action: "MINER_DONE", runId: ctxA.runId, planId: ctxA.planId, cards: 40, motivo: "fim_da_lista" }, tabA);
  check("MINER_DONE aceito", done && done.status === "ok");

  // segunda busca: a MESMA janela é reaproveitada (navega), nunca abre outra
  await sleep(9000);
  const tabB = tabA;
  check("segunda busca reaproveitou a mesma janela (navegou a aba)", env.windowsCreated.length === 1 && env.tabsUpdated.length === 1 && env.tabsUpdated[0].id === tabA && new URL(env.tabsUpdated[0].url).searchParams.get("q") === "ansiedade controle", JSON.stringify(env.tabsUpdated));
  check("janela 1 NÃO foi fechada entre as buscas", env.removedWindows.length === 0, JSON.stringify(env.removedWindows));
  const ctxB = await sendToBg({ action: "GET_MINER_CONTEXT" }, tabB);
  check("contexto da 2ª busca", ctxB && ctxB.q === "ansiedade controle", JSON.stringify(ctxB));
  await sendToBg({ action: "ACERVO_UPSERT", creatives: [mk(40, { fonte: "ansiedade controle", dup: 30, dias: 4, inicio: Date.now() - 4 * 864e5 })] }, tabB);
  await sendToBg({ action: "MINER_DONE", runId: ctxB.runId, planId: ctxB.planId, cards: 20, motivo: "tempo" }, tabB);
  await sleep(2500);
  const prog2 = env.store.viva_inteligente_progress;
  check("progresso final publicado no storage", prog2 && prog2.status === "completed", JSON.stringify(prog2));
  check("resumo da rodada", env.store.viva_ultimo_resumo && env.store.viva_ultimo_resumo.criativos === 13, JSON.stringify(env.store.viva_ultimo_resumo));
  check("janela única fechada ao terminar", env.removedWindows.length === 1 && env.windowsCreated.length === 1, JSON.stringify(env.removedWindows));
  check("estado final = completed", env.store.viva_inteligente_state.status === "completed");
  // o content (operador) recebeu o progresso via storage?
  const progressTxt = win.document.querySelector("#viva-progresso-inteligente").textContent;
  check("painel mostra o fim da mineração (via storage.onChanged)", progressTxt.includes("finalizada"), progressTxt);
  check("botão 'Abrir Centro' apareceu", win.document.querySelector("#viva-btn-abrir-centro").hidden === false);

  // ── 4) Dock e botão do Centro (a tela em si é testada em intel_tela.test.js) ──
  new vm.Script("injectDock()").runInContext(vmCtx);
  await sleep(200);
  const dockBadge = win.document.querySelector("#viva-intel-count");
  check("Dock mostra contagem do acervo", dockBadge && dockBadge.textContent === "13", dockBadge && dockBadge.textContent);
  const abasAntes = env.tabsAlive.size;
  win.document.querySelector("#viva-btn-show-ranking").click();
  await sleep(300);
  check("botão abre o Centro em aba própria", env.tabsAlive.size === abasAntes + 1, `${abasAntes}/${env.tabsAlive.size}`);
  check("nada é desenhado por cima da Biblioteca", !win.document.querySelector("#viva-ranking-overlay") && win.document.querySelector("div[role='main']").style.display !== "none");
  await env.chromeBase.storage.local.set({ viva_vault_info: { versao: 2, total: 150200 } });
  await sleep(100);
  check("com o banco ligado o contador mostra o banco e avisa o limite", dockBadge.textContent === "150 mil" && dockBadge.classList.contains("is-full") && /LIMITE ATINGIDO/.test(dockBadge.title), `${dockBadge.textContent} ${dockBadge.title}`);
  await env.chromeBase.storage.local.remove("viva_vault_info");
  await sleep(100);

  // ── regressão: gatilho de auto-descoberta do Instagram não pode dar ReferenceError (cachedIgUrl) ──
  {
    let erro = null;
    try { new vm.Script("tryTriggerAutoDiscoverInstagram()").runInContext(vmCtx); } catch (e) { erro = e; }
    check("tryTriggerAutoDiscoverInstagram roda sem ReferenceError", !erro, erro && erro.message);
    check("cachedIgUrl existe no escopo do módulo", new vm.Script("typeof cachedIgUrl").runInContext(vmCtx) !== "undefined");
  }

  // ── 5) limpar acervo ──
  await sendToBg({ action: "ACERVO_CLEAR" }, 7);
  await sleep(300);
  check("limpar acervo apaga o storage", !("viva_acervo" in env.store));

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE INTEGRAÇÃO PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERRO NO TESTE", e); process.exit(2); });
