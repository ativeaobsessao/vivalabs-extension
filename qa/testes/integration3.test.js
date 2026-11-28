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

  // fetch do content: registra o que vai para /api/salvar (Monitorar)
  const salvos = [];
  win.fetch = async (url, opts) => {
    if (String(url).includes("/api/salvar")) { salvos.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => [] };
  };
  const abertas = [];
  win.open = (u, alvo, feat) => { abertas.push({ u, alvo, feat }); return null; };
  win.navigator.clipboard = { writeText: async () => {} };

  // acervo: 3 bibliotecas, 3 domínios
  const mk = (i, pid, dom, nome, over = {}) => ({ id: String(300000000000000 + i), pid, sig: "s" + i, nome, copy: "Texto " + i, dest: "https://" + dom + "/x", dom, thumb: "", video: false, dup: 5, dias: 6, inicio: Date.now() - 6 * 864e5, adv: 7, stage: "bruta", fonte: "diabetes receitas", ...over });
  const lista = [
    mk(1, "111222331", "boa.com", "Loja Boa"), mk(2, "111222331", "boa.com", "Loja Boa"),
    mk(3, "111222332", "lixo1.com", "Lixo Um"), mk(4, "111222332", "lixo1.com", "Lixo Um"),
    mk(5, "111222333", "lixo2.com", "Lixo Dois"), mk(6, "111222333", "boa.com", "Lixo Dois"),
  ];
  await sendToBg({ action: "ACERVO_UPSERT", creatives: lista }, 7);
  new vm.Script("injectTopBar()").runInContext(vmCtx);
  new vm.Script("injectDock()").runInContext(vmCtx);
  new vm.Script("injectSidebar()").runInContext(vmCtx);
  await sleep(300);
  check("acervo com 6 criativos", env.store.viva_acervo.length === 6, String(env.store.viva_acervo && env.store.viva_acervo.length));
  const $ = s => win.document.querySelector(s);
  const $$ = s => Array.from(win.document.querySelectorAll(s));

  // ── apagar e bloquear (o que a tela do Centro pede ao background) ──
  {
    const total = env.store.viva_acervo.length;
    await sendToBg({ action: "ACERVO_DELETE", chaves: ["id:" + lista[2].id], bloquear: false }, 7);
    check("apagar sem bloquear tira do acervo", env.store.viva_acervo.length === total - 1);
    await sendToBg({ action: "ACERVO_UPSERT", creatives: [lista[2]] }, 7);
    check("sem bloqueio o criativo pode voltar", env.store.viva_acervo.length === total);
    await sendToBg({ action: "ACERVO_DELETE", paginas: ["111222333"], bloquear: true }, 7);
    check("bloquear biblioteca apaga os criativos dela", !env.store.viva_acervo.some(c => c.pid === "111222333"));
    await sendToBg({ action: "ACERVO_UPSERT", creatives: [lista[4]] }, 7);
    check("biblioteca bloqueada não volta na coleta", !env.store.viva_acervo.some(c => c.pid === "111222333"));
    await sendToBg({ action: "ACERVO_DELETE", dominios: ["boa.com"], bloquear: true }, 7);
    check("bloquear oferta apaga os criativos do domínio", !env.store.viva_acervo.some(c => c.dom === "boa.com") && env.store.viva_lixeira.dominios.includes("boa.com"));
    await sendToBg({ action: "LIXEIRA_CLEAR" }, 7);
    check("liberar esvazia a lista de bloqueio", !env.store.viva_lixeira);
  }

  // ── cofre da equipe não devolve o que está bloqueado ──
  {
    const l = (await (async () => { await sendToBg({ action: "ACERVO_UPSERT", creatives: [mk(21, "111222341", "x.com", "Pag X"), mk(22, "111222342", "y.com", "Pag Y")] }, 7); return 1; })());
    const vazio = await env.chromeBase.storage.local.get("viva_acervo");
    const ids = vazio.viva_acervo.map(c => c.id);
    await sendToBg({ action: "ACERVO_DELETE", chaves: ["id:" + mk(21).id], paginas: [], dominios: [], bloquear: true }, 7);
    check("ACERVO_DELETE direto apaga e bloqueia", !env.store.viva_acervo.some(c => c.id === mk(21).id) && env.store.viva_lixeira.chaves.includes("id:" + mk(21).id));
    const ctxBg = bgCtx;
    const r = vm.runInContext(`mesclarRemotos(${JSON.stringify(env.store.viva_acervo)}, ${JSON.stringify([{ key: "id:" + mk(21).id, rec: { ...mk(21, "111222341", "x.com", "Pag X"), firstSeen: Date.now(), lastSeen: Date.now() } }])}, Date.now(), undefined, lixeiraNormalizar(${JSON.stringify(env.store.viva_lixeira)}))`, bgCtx);
    check("sincronização da equipe respeita a lixeira", !r.acervo.some(c => c.id === mk(21).id));
    await sendToBg({ action: "LIXEIRA_CLEAR" }, 7);
  }

  // ── o painel Monitorar da Biblioteca continua salvando a página aberta ──
  {
    salvos.length = 0;
    $("#viva-side-name").value = "Loja Nova";
    $("#viva-side-nicho").value = "Diabetes";
    $("#viva-side-save").click(); await sleep(250);
    check("salvar pede confirmação antes de enviar", !!$("#viva-confirm-overlay") && salvos.length === 0);
    $("#viva-modal-confirm").click(); await sleep(500);
    check("salva a página com a URL da biblioteca aberta", salvos.length === 1 && salvos[0].tipo === "pagina" && salvos[0].nome === "Loja Nova" && salvos[0].url === win.location.href, JSON.stringify(salvos));
    $("#viva-side-domain").value = "boa.com";
    salvos.length = 0;
    $("#viva-side-save-domain").click(); await sleep(250); $("#viva-modal-confirm").click(); await sleep(500);
    check("salva domínio como tipo 'dominio'", salvos.length === 1 && salvos[0].tipo === "dominio" && salvos[0].url === "boa.com", JSON.stringify(salvos));
    check("não existe mais pop-up do Centro no painel", !$("#viva-btn-close-ctx") && !$("#viva-monitor-ctx-note"));
  }

  // ── INSTAGRAM na biblioteca: detecção grava no mapa; clique abre nova guia e salva ──
  {
    const igInput = $("#viva-side-instagram");
    const helper = $("#viva-ig-helper");
    // simula o usuário colando um link e clicando na caixa
    igInput.value = "@minhaloja";
    abertas.length = 0;
    igInput.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(300);
    check("digitar @usuário e sair do campo grava no mapa", Object.values(env.store.viva_ig_map).some(e => e.url === "https://www.instagram.com/minhaloja"), JSON.stringify(env.store.viva_ig_map));
    igInput.click(); await sleep(300);
    check("clicar na caixa abre o Instagram em nova guia", abertas.length === 1 && abertas[0].u === "https://www.instagram.com/minhaloja" && abertas[0].alvo === "_blank", JSON.stringify(abertas));
    check("mensagem confirma 'aberto em nova guia e salvo'", /nova guia e salvo/.test(helper.textContent), helper.textContent);
    abertas.length = 0;
    igInput.value = "https://evil.example.com/x";
    igInput.click(); await sleep(100);
    check("link que não é do Instagram NÃO abre nada", abertas.length === 0);
    igInput.value = ""; igInput.click(); await sleep(50);
    check("campo vazio não abre nada", abertas.length === 0);
  }
  // detecção automática ao entrar na biblioteca (DOM com link do Instagram) grava no mapa
  {
    win.history.replaceState({}, "", "/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=555666777&search_type=page");
    win.document.documentElement.dataset.vivaDetectedInstagram = "https://www.instagram.com/detectada/";
    const antes = Object.keys(env.store.viva_ig_map || {}).length;
    new vm.Script("injectSidebar(); 0").runInContext(vmCtx);
    const igRes = new vm.Script(`(function(){ const a = vivaPaginaAtualIdentidade(); vivaIgMapSalvar(a.pid, "Pagina Detectada", "https://www.instagram.com/detectada/"); return a; })()`).runInContext(vmCtx);
    await sleep(300);
    check("identidade da biblioteca lê o view_all_page_id da URL", igRes.pid === "555666777", JSON.stringify(igRes));
    check("detecção ao entrar na biblioteca grava por ID e por nome", env.store.viva_ig_map["pid:555666777"] && env.store.viva_ig_map["n:pagina detectada"] && Object.keys(env.store.viva_ig_map).length >= antes + 2, JSON.stringify(Object.keys(env.store.viva_ig_map)));
    check("mesmo link não regrava (sem escrita repetida)", new vm.Script(`vivaIgMapSalvar("555666777", "Pagina Detectada", "https://www.instagram.com/detectada/")`).runInContext(vmCtx) === false);
    check("link que não é perfil nunca entra no mapa", new vm.Script(`vivaIgMapSalvar("555666777", "X", "https://www.instagram.com/p/ABC123/")`).runInContext(vmCtx) === false);
  }

  // ── lote de status: o background recusa entrada inválida ──
  {
    const bad = await sendToBg({ action: "TEAM_SET_STATUS_LOTE", keys: [], novoStatus: "descartada" }, 7);
    check("background recusa lote vazio", bad && bad.status === "error", JSON.stringify(bad));
    const bad2 = await sendToBg({ action: "TEAM_SET_STATUS_LOTE", keys: ["id:1"], novoStatus: "qualquer" }, 7);
    check("background recusa status inválido", bad2 && bad2.status === "error", JSON.stringify(bad2));
  }

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE APAGAR/MONITORAR/INSTAGRAM PASSARAM");
  process.exit(fails ? 1 : 0);
})();
