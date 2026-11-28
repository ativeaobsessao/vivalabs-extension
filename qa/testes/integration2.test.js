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


  // ── CONTENT em modo mineração: janela real iniciada pelo background ──
  const fila = await sendToBg({ action: "INICIAR_MINERACAO_INTELIGENTE", consentGranted: true, linhas: ["keto truque", "ansiedade controle"], options: { tempoPorBusca: 20 } }, 7);
  check("background iniciou a fila", fila && fila.status === "fila_iniciada", JSON.stringify(fila));
  await sleep(600);
  const tabM = env.windowsCreated[0].win.tabs[0].id;

  const dom = new JSDOM(`<!DOCTYPE html><html><body><div role="main"></div></body></html>`, { url: env.windowsCreated[0].opts.url, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  win.chrome = { ...env.chromeBase, runtime: { sendMessage: m => sendToBg(m, tabM), onMessage: { addListener() {} }, id: "x" } };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.requestAnimationFrame = cb => setTimeout(cb, 0);
  win.scrollTo = () => { win.__scrolls = (win.__scrolls || 0) + 1; };
  win.fetch = async () => ({ ok: true, json: async () => ({}) });
  win.console = { log() {}, info: (...a) => { if (String(a[0]).includes("DIAG")) console.log("   ", ...a); }, debug() {}, warn: (...a) => console.log("[CS WARN]", ...a), error: (...a) => console.log("[CS ERR]", ...a) };
  const vmCtx = dom.getInternalVMContext();
  for (const f of ["intelligent_parser.js", "ranking_engine.js", "export_data.js", "monitor_url.js", "content.js"]) new vm.Script(read(f), { filename: f }).runInContext(vmCtx);
  const run = code => new vm.Script(code).runInContext(vmCtx);

  // Cards falsos no DOM + processCards stub que reproduz o que o motor faz (preenche activeCardData)
  const body = win.document.body;
  const makeCard = i => {
    const div = win.document.createElement("div");
    div.innerHTML = `Library ID: ${400000000000000 + i} <a href="https://www.facebook.com/ads/library/?view_all_page_id=555666777${i % 2}">pág</a><img src="https://scontent.fbcdn.net/img${i}.jpg" width="320" height="320">`;
    body.appendChild(div);
    return div;
  };
  win.__cards = [];
  win.__makeCard = makeCard;
  run(`
    var __tick = 0;
    processCards = function () {
      __tick += 1;
      const n = Math.min(30, __tick * 10);          // cresce nos 3 primeiros ciclos e estagna
      while (window.__cards.length < n) window.__cards.push(window.__makeCard(window.__cards.length));
      activeCardData = window.__cards.map((card, i) => ({
        card,
        baixoVolume: i === 0,                                   // este NÃO deve entrar no acervo
        stage: i < 25 ? "bruta" : "teste",                      // "teste" sem em-escala NÃO entra
        effectiveDupCount: 3 + (i % 7),
        advAds: 12,
        data: { identitySignal: "sig" + i, sig: "t" + i + "|m", pageId: "555666777" + (i % 2), advertiserName: "Loja " + (i % 2),
                title: "Titulo " + i, primaryText: "Texto " + i, destUrl: "https://oferta.com/p" + i, mediaUrl: "https://scontent.fbcdn.net/img" + i + ".jpg",
                adAgeDays: 5 + i, startDateMs: Date.now() - (5 + i) * 864e5, metaAdCount: 3 },
      }));
      coletarParaAcervo();   // o processCards real chama isto ao fim da fase de leitura
    };
  `);
  const ctx = await sendToBg({ action: "GET_MINER_CONTEXT" }, tabM);
  check("janela recebeu contexto de mineração", ctx && ctx.q === "keto truque");
  const t0 = Date.now();
  run(`iniciarAutoScrollMineracao(${JSON.stringify(ctx)})`);
  // espera o loop decidir sozinho que acabou (fim da lista) e o background fechar a janela
  let fechou = false;
  for (let i = 0; i < 50 && !fechou; i += 1) { await sleep(500); fechou = env.tabsUpdated.length > 0; }   // a sessão reaproveita a janela: terminou = navegou para o termo seguinte
  const seg = Math.round((Date.now() - t0) / 1000);
  check("auto-scroll terminou sozinho (fim da lista) e a sessão seguiu para o próximo termo", fechou, `${seg}s`);
  check("terminou antes do limite de tempo (rápido)", seg < 25, `${seg}s`);
  check("rolou a página", (win.__scrolls || 0) >= 5, String(win.__scrolls));
  const acervo = env.store.viva_acervo || [];
  check("acervo recebeu criativos da janela", acervo.length > 0, String(acervo.length));
  check("baixo volume NÃO entrou", !acervo.some(c => c.id === "400000000000000"));
  check("estágio teste NÃO entrou", !acervo.some(c => c.id === "400000000000027"));
  check("entrou 24 criativos (25 'bruta' - 1 baixo volume)", acervo.length === 24, String(acervo.length));
  const c5 = acervo.find(c => c.id === "400000000000005");
  check("criativo tem id, página, thumb e link do anúncio", c5 && c5.pid === "5556667771" && c5.thumb.includes("img5.jpg") && c5.url.includes("id=400000000000005") && c5.url.includes("view_all_page_id=5556667771"), JSON.stringify(c5));
  check("criativo tem copy, destino e domínio", c5 && c5.copy.includes("Titulo 5") && c5.dom === "oferta.com");
  check("fonte = termo da busca (não a URL)", c5 && c5.fontes.includes("keto truque"), JSON.stringify(c5 && c5.fontes));
  check("duplicados e dias gravados", c5 && c5.dup === 3 + 5 % 7 && c5.dias === 10, `${c5 && c5.dup}/${c5 && c5.dias}`);
  // a 2ª busca começa em seguida
  await sleep(1500);
  check("2ª busca navegou a mesma janela depois da 1ª", env.windowsCreated.length === 1 && env.tabsUpdated.length === 1, `${env.windowsCreated.length}/${env.tabsUpdated.length}`);

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE INTEGRAÇÃO PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERRO NO TESTE", e); process.exit(2); });
