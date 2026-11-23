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
  vm.runInContext(read("team_sync.js"), bgCtx);
  vm.runInContext(read("notify.js"), bgCtx);
  vm.runInContext(read("auto_export.js"), bgCtx);
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
  for (const f of ["intelligent_parser.js", "ranking_engine.js", "export_data.js", "content.js"]) new vm.Script(read(f), { filename: f }).runInContext(vmCtx);
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

  // ── 4) Centro de Inteligência renderiza o acervo ──
  new vm.Script("injectDock()").runInContext(vmCtx);
  await sleep(200);
  const dockBadge = win.document.querySelector("#viva-intel-count");
  check("Dock mostra contagem do acervo", dockBadge && dockBadge.textContent === "13", dockBadge && dockBadge.textContent);
  win.document.querySelector("#viva-btn-show-ranking").click();
  await sleep(300);
  const overlay = win.document.querySelector("#viva-ranking-overlay");
  check("Centro abriu", !!overlay);
  let cards = overlay.querySelectorAll(".viva-intel-card");
  check("Centro lista os criativos", cards.length === 13, String(cards.length));
  const firstScore = Number(cards[0].querySelector(".viva-intel-score strong").textContent);
  const lastScore = Number(cards[cards.length - 1].querySelector(".viva-intel-score strong").textContent);
  check("ordenado por score desc", firstScore >= lastScore, `${firstScore} / ${lastScore}`);
  check("topo é o criativo jovem com 30 duplicados", cards[0].textContent.includes("30x duplicados"), cards[0].textContent.slice(0, 120));
  check("card tem botões de ação", cards[0].querySelectorAll(".viva-intel-actions button").length >= 4);
  // filtro "em escala"
  Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Em escala")).click();
  await sleep(50);
  const hot = overlay.querySelectorAll(".viva-intel-card");
  check("filtro 'Em escala agora' reduz a lista", hot.length > 0 && hot.length < 13, String(hot.length));
  // aba bibliotecas
  overlay.querySelector('.viva-intel-tabs button[data-tab="paginas"]').click();
  await sleep(50);
  const pages = overlay.querySelectorAll(".viva-intel-card");
  check("aba Bibliotecas agrupa por anunciante (3)", pages.length === 3, String(pages.length));
  // filtro por fonte
  overlay.querySelector('.viva-intel-tabs button[data-tab="criativos"]').click();
  const fonteSel = overlay.querySelector("#viva-intel-fonte");
  check("select de buscas lista as 2 fontes", fonteSel.options.length === 3, String(fonteSel.options.length));
  // atualização ao vivo: novo criativo entra com o Centro aberto
  await sendToBg({ action: "ACERVO_UPSERT", creatives: [mk(77, { fonte: "dieta", dup: 40, dias: 2, inicio: Date.now() - 2 * 864e5 })] }, 7);
  await sleep(1100);
  check("Centro atualiza ao vivo", overlay.querySelector(".viva-intel-modal, .viva-ranking-modal") && win.document.querySelector("#viva-intel-summary").textContent.startsWith("14 criativos"), win.document.querySelector("#viva-intel-summary").textContent);
  // ── radar: selos "novo" e "subindo" + filtros ──
  {
    const agoraT = Date.now();
    const atual = env.store.viva_acervo.slice();
    const alvo = atual.find(c => c.id && c.pid);
    const antigo = atual.map(c => c === alvo ? { ...c, firstSeen: agoraT - 9 * 864e5, advBase: Math.max(1, (c.adv || 12) - 20), advBaseMs: agoraT - 2 * 864e5, adv: (c.adv || 12) + 20 } : { ...c, firstSeen: agoraT - 9 * 864e5 });
    await env.chromeBase.storage.local.set({ viva_acervo: antigo });
    await sleep(1100);
    Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Todos")).click();
    await sleep(60);
    Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Subindo")).click();
    await sleep(60);
    const sub = overlay.querySelectorAll(".viva-intel-card");
    check("filtro 'Subindo' mostra só quem subiu", sub.length === 1 && sub[0].textContent.includes("SUBINDO"), String(sub.length));
    Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Novos")).click();
    await sleep(60);
    const nov = overlay.querySelectorAll(".viva-intel-card");
    check("filtro 'Novos (24h)' vazio quando nada é novo", nov.length === 0, String(nov.length));
    await env.chromeBase.storage.local.set({ viva_acervo: antigo.map(c => c === antigo[0] || c.id === alvo.id ? { ...c, firstSeen: agoraT - 3600e3 } : c) });
    await sleep(1100);
    const nov2 = overlay.querySelectorAll(".viva-intel-card");
    check("filtro 'Novos (24h)' mostra o criativo recente com selo", nov2.length >= 1 && nov2[0].textContent.includes("NOVO"), String(nov2.length));
    Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Todos")).click();
    await sleep(60);
  }
  // ── termos-chave: chips, mínimo de termos, selo e ordenação ──
  {
    const base = env.store.viva_acervo.map((c, i) => ({ ...c, fontes: ["keto truque"] }));
    base[0] = { ...base[0], fontes: ["keto truque", "ansiedade controle", "sono profundo", "glicemia"] };
    base[1] = { ...base[1], fontes: ["keto truque", "ansiedade controle"] };
    await env.chromeBase.storage.local.set({ viva_acervo: base });
    await sleep(1100);
    Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Todos")).click();
    await sleep(60);
    const chipsTermos = Array.from(overlay.querySelectorAll(".viva-intel-termo"));
    check("chips de termos-chave aparecem com contagem", chipsTermos.length >= 4 && chipsTermos[0].textContent.includes("keto truque ·"), chipsTermos.map(c => c.textContent).join("|"));
    const minSel = overlay.querySelector("#viva-intel-minterms");
    minSel.value = "2"; minSel.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(80);
    let vis = overlay.querySelectorAll(".viva-intel-card");
    check("'2+ termos' mostra só quem tem 2 ou mais", vis.length === 2, String(vis.length));
    minSel.value = "3"; minSel.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(80);
    vis = overlay.querySelectorAll(".viva-intel-card");
    check("'3+ termos' mostra só 1", vis.length === 1 && vis[0].textContent.includes("4 termos"), String(vis.length));
    check("card mostra selo 🎯 e pill com N termos", vis[0].querySelector(".viva-intel-chip.termos") && vis[0].textContent.includes("🎯 4 termos"));
    minSel.value = "1"; minSel.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(80);
    // clicar em 2 termos = exige os dois
    Array.from(overlay.querySelectorAll(".viva-intel-termo")).find(b => b.textContent.startsWith("sono profundo")).click(); await sleep(80);
    Array.from(overlay.querySelectorAll(".viva-intel-termo")).find(b => b.textContent.startsWith("ansiedade controle")).click(); await sleep(80);
    vis = overlay.querySelectorAll(".viva-intel-card");
    check("2 termos selecionados exigem os dois", vis.length === 1, String(vis.length));
    Array.from(overlay.querySelectorAll(".viva-intel-termo")).find(b => b.textContent.includes("limpar")).click(); await sleep(80);
    check("limpar termos devolve a lista", overlay.querySelectorAll(".viva-intel-card").length === base.length, String(overlay.querySelectorAll(".viva-intel-card").length));
    const sortSel = overlay.querySelector("#viva-intel-sort");
    sortSel.value = "termos"; sortSel.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(80);
    const primeiro = overlay.querySelector(".viva-intel-card");
    check("ordenar por mais termos-chave põe o de 4 termos no topo", primeiro && primeiro.textContent.includes("4 termos"));
    sortSel.value = "score"; sortSel.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(60);
  }
  // ── aba Ofertas (por domínio de destino) + sinal de vida do radar ──
  {
    const agoraT = Date.now();
    const base = env.store.viva_acervo.map((c, i) => ({ ...c, dom: i < 4 ? "oferta-x.com" : "facebook.com", dest: i < 4 ? "https://oferta-x.com/lp" : "https://facebook.com/x", pid: i < 4 ? String(90000 + i % 2) : c.pid }));
    await env.chromeBase.storage.local.set({ viva_acervo: base });
    await sleep(1100);
    overlay.querySelector('.viva-intel-tabs button[data-tab="ofertas"]').click();
    await sleep(80);
    const ofertas = overlay.querySelectorAll(".viva-intel-card");
    check("aba Ofertas: 1 oferta (plataformas ignoradas)", ofertas.length === 1 && ofertas[0].textContent.includes("oferta-x.com"), String(ofertas.length));
    check("oferta mostra páginas distintas e criativos", ofertas[0].textContent.includes("2 PÁGINAS") && ofertas[0].textContent.includes("4 criativos"), ofertas[0].textContent.slice(0, 160));
    check("filtros de criativo ficam escondidos na aba Ofertas", overlay.querySelector("#viva-intel-chips").hidden === true);
    Array.from(ofertas[0].querySelectorAll("button")).find(b => b.textContent === "Ver criativos").click();
    await sleep(80);
    const doDominio = overlay.querySelectorAll(".viva-intel-card");
    check("'Ver criativos' volta à aba Criativos filtrada pelo domínio", doDominio.length === 4, String(doDominio.length));
    overlay.querySelector("#viva-intel-search").value = ""; overlay.querySelector("#viva-intel-search").dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(80);

    const radarBox = overlay.querySelector("#viva-intel-radar");
    check("sem dados de radar, nada é mostrado", radarBox.hidden === true);
    await env.chromeBase.storage.local.set({ viva_team_radar: { at: agoraT, now: agoraT, items: [{ by: "Notebook", ms: agoraT - 60000, info: { on: true, status: "waiting", lastRunAt: agoraT - 3600e3, everyH: 6 } }] } });
    await sleep(1100);
    check("chip 'Radar OK' com a máquina e a última rodada", radarBox.hidden === false && /Radar OK · Notebook · última rodada há 1 h/.test(radarBox.textContent), radarBox.textContent);
    await env.chromeBase.storage.local.set({ viva_team_radar: { at: agoraT, now: agoraT, items: [{ by: "Notebook", ms: agoraT - 3600e3, info: { on: true, status: "waiting", lastRunAt: agoraT - 7200e3, everyH: 6 } }] } });
    await sleep(1100);
    check("sem ping há 1 h → aviso vermelho 'SEM SINAL'", /Radar SEM SINAL/.test(radarBox.textContent) && radarBox.querySelector(".viva-intel-radar-chip.semsinal"), radarBox.textContent);
    await env.chromeBase.storage.local.set({ viva_team_radar: { at: agoraT, now: agoraT, items: [{ by: "Notebook", ms: agoraT - 3600e3, info: { on: false } }] } });
    await sleep(1100);
    check("radar desligado de propósito não gera alarme", radarBox.hidden === true);
    await env.chromeBase.storage.local.set({ viva_team_radar: null });
  }
  // ── filtros avançados, seleção, presets e download ──
  {
    // o jsdom não tem estas APIs do Chrome real: injeta as do Node e captura o download
    win.TextEncoder = TextEncoder; win.CompressionStream = CompressionStream; win.Response = Response; win.Blob = require("buffer").Blob;
    const baixados = [];
    win.URL.createObjectURL = blob => { baixados.push({ blob }); return "blob:teste/" + baixados.length; };
    win.URL.revokeObjectURL = () => {};
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) baixados[baixados.length - 1].nome = this.download; };
    win.prompt = () => "Meu filtro de teste";
    const setNum = (id, v) => { const el = overlay.querySelector(id); el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); };

    Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Todos")).click();
    overlay.querySelector('.viva-intel-tabs button[data-tab="criativos"]').click();
    await sleep(100);
    const acervo = env.store.viva_acervo;
    const total = overlay.querySelector("#viva-sel-info").textContent;
    check("barra mostra quantos há no filtro atual", /\d+ criativos? no filtro atual/.test(total), total);

    // filtro avançado: duplicados ≥ 10
    const esperado = acervo.filter(c => (Number(c.dup) || 1) >= 10).length;
    setNum("#viva-adv-dup", "10");
    await sleep(450);
    const n1 = overlay.querySelectorAll(".viva-intel-card").length;
    check("Duplicados ≥ 10 filtra certo", n1 === esperado && esperado > 0 && esperado < acervo.length, `${n1}/${esperado}/${acervo.length}`);
    check("título dos filtros avançados mostra 1 ativo", /1 ativo/.test(overlay.querySelector("#viva-intel-adv-sum").textContent));
    setNum("#viva-adv-score", "999999");
    await sleep(450);
    check("combinação sem resultado mostra 'Nada com esses filtros'", overlay.querySelectorAll(".viva-intel-card").length === 0);
    setNum("#viva-adv-score", "");
    await sleep(450);
    check("limpar o campo devolve a lista", overlay.querySelectorAll(".viva-intel-card").length === esperado);
    const midia = overlay.querySelector("#viva-adv-midia"); midia.value = "video"; midia.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(100);
    const nv = overlay.querySelectorAll(".viva-intel-card").length;
    check("filtro de mídia: vídeo", nv === acervo.filter(c => (Number(c.dup) || 1) >= 10 && c.video).length, String(nv));
    midia.value = ""; midia.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(100);

    // presets
    overlay.querySelector("#viva-preset-save").click();
    await sleep(100);
    check("preset salvo no storage", (env.store.viva_filtros_salvos || []).length === 1 && env.store.viva_filtros_salvos[0].nome === "Meu filtro de teste" && env.store.viva_filtros_salvos[0].ui.adv.dup === 10, JSON.stringify(env.store.viva_filtros_salvos));
    overlay.querySelector("#viva-adv-clear").click(); await sleep(100);
    check("limpar tudo zera os filtros", overlay.querySelectorAll(".viva-intel-card").length === acervo.length && !/ativo/.test(overlay.querySelector("#viva-intel-adv-sum").textContent));
    const ps = overlay.querySelector("#viva-intel-preset"); ps.value = "0"; ps.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(100);
    check("aplicar preset restaura o filtro", overlay.querySelectorAll(".viva-intel-card").length === esperado && overlay.querySelector("#viva-adv-dup").value === "10");

    // seleção manual de 2 criativos
    const cks = overlay.querySelectorAll(".viva-intel-sel");
    cks[0].click(); cks[1].click(); await sleep(50);
    check("seleção mostra '2 criativos selecionados' e marca o card", overlay.querySelector("#viva-sel-info").textContent === "2 criativos selecionados" && overlay.querySelectorAll(".viva-intel-card.is-selected").length === 2);
    check("escopo muda para 'selecionados' sozinho", overlay.querySelector("#viva-exp-escopo").value === "selecionados" && /selecionados \(2\)/.test(overlay.querySelector("#viva-exp-escopo").options[0].textContent));
    overlay.querySelector("#viva-exp-xlsx").click();
    await sleep(900);
    const b1 = baixados[baixados.length - 1];
    check("baixou XLSX só com os 2 selecionados", b1 && /^VivaSpy_selecionados_.*_2-criativos\.xlsx$/.test(b1.nome || ""), JSON.stringify(b1 && b1.nome));
    const buf1 = Buffer.from(await b1.blob.arrayBuffer());
    check("arquivo é um zip/XLSX", buf1[0] === 0x50 && buf1[1] === 0x4B && b1.blob.type.includes("spreadsheetml"));
    fs.writeFileSync("/tmp/centro_sel.xlsx", buf1);

    // selecionar todos os filtrados + CSV do filtro
    overlay.querySelector("#viva-sel-clear").click(); await sleep(100);
    check("limpar seleção volta ao filtro atual", overlay.querySelector("#viva-sel-info").textContent === `${esperado} ${esperado === 1 ? "criativo" : "criativos"} no filtro atual` && overlay.querySelector("#viva-exp-escopo").value === "filtro", overlay.querySelector("#viva-sel-info").textContent);
    overlay.querySelector("#viva-exp-csv").click();
    await sleep(500);
    const b2 = baixados[baixados.length - 1];
    check("CSV do filtro atual com a contagem certa no nome", b2 && new RegExp(`_${esperado}-criativos\\.csv$`).test(b2.nome || ""), JSON.stringify(b2 && b2.nome));
    const txt = Buffer.from(await b2.blob.arrayBuffer()).toString("utf8");
    check("CSV tem BOM, cabeçalho e uma linha por criativo", txt.charCodeAt(0) === 0xFEFF && txt.split("\r\n").length === esperado + 2, String(txt.split("\r\n").length));
    overlay.querySelector("#viva-sel-all").click(); await sleep(150);
    check("'Selecionar os filtrados' marca todos do filtro", overlay.querySelector("#viva-sel-info").textContent === `${esperado} criativos selecionados`, overlay.querySelector("#viva-sel-info").textContent);
    overlay.querySelector("#viva-sel-clear").click(); await sleep(100);
    const esc = overlay.querySelector("#viva-exp-escopo"); esc.value = "tudo"; esc.dispatchEvent(new win.Event("change", { bubbles: true }));
    overlay.querySelector("#viva-exp-csv").click(); await sleep(500);
    const b3 = baixados[baixados.length - 1];
    check("'acervo inteiro' baixa tudo", new RegExp(`acervo-completo_.*_${acervo.length}-criativos\\.csv$`).test(b3.nome || ""), b3.nome);
    overlay.querySelector("#viva-adv-clear").click(); await sleep(100);
  }
  // ── equipe: quem achou, status compartilhado e estado do sync ──
  Array.from(overlay.querySelectorAll(".viva-intel-filter")).find(b => b.textContent.includes("Todos")).click();
  await sleep(100);
  const itemId = env.store.viva_acervo.find(c => c.id);
  const itemKey = `id:${itemId.id}`;
  await env.chromeBase.storage.local.set({ viva_team_meta: { [itemKey]: { by: "Ana", status: "nova", statusBy: "", statusMs: 0 } }, viva_sync_state: { ok: true, at: Date.now(), pushed: 0, pulled: 1, error: "" } });
  await sleep(1100);
  check("Centro mostra 'achado por Ana'", overlay.textContent.includes("👤 Ana"));
  check("Centro mostra estado do sync da equipe", win.document.querySelector("#viva-intel-summary").textContent.includes("equipe sincronizada"), win.document.querySelector("#viva-intel-summary").textContent);
  const totalAntes = overlay.querySelectorAll(".viva-intel-card").length;
  const selects = overlay.querySelectorAll(".viva-intel-status");
  check("cada card tem seletor de status", selects.length === totalAntes && totalAntes > 0, `${selects.length}/${totalAntes}`);
  const cardDoItem = Array.from(overlay.querySelectorAll(".viva-intel-card")).find(c => c.textContent.includes("👤 Ana"));
  const selItem = cardDoItem.querySelector(".viva-intel-status");
  selItem.value = "descartada";
  selItem.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(1300);
  check("status gravado pelo background", env.store.viva_team_meta && env.store.viva_team_meta[itemKey] && env.store.viva_team_meta[itemKey].status === "descartada", JSON.stringify(env.store.viva_team_meta));
  check("status entrou na fila de envio da equipe", (env.store.viva_sync_dirty_status || []).includes(itemKey));
  check("descartada some da lista padrão", overlay.querySelectorAll(".viva-intel-card").length === totalAntes - 1, `${overlay.querySelectorAll(".viva-intel-card").length} vs ${totalAntes}`);
  const filtroStatus = overlay.querySelector("#viva-intel-status");
  filtroStatus.value = "todas"; filtroStatus.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(100);
  check("filtro 'Todos os status' traz de volta", overlay.querySelectorAll(".viva-intel-card").length === totalAntes);
  filtroStatus.value = "ativas"; filtroStatus.dispatchEvent(new win.Event("change", { bubbles: true }));

  // fechar restaura feed
  win.document.querySelector("#viva-close-ranking").click();
  await sleep(100);
  check("fechar remove o overlay", !win.document.querySelector("#viva-ranking-overlay"));
  check("fechar devolve o feed", win.document.querySelector("div[role='main']").style.display !== "none");

  // ── regressão: gatilho de auto-descoberta do Instagram não pode dar ReferenceError (cachedIgUrl) ──
  {
    let erro = null;
    try { new vm.Script("tryTriggerAutoDiscoverInstagram()").runInContext(vmCtx); } catch (e) { erro = e; }
    check("tryTriggerAutoDiscoverInstagram roda sem ReferenceError", !erro, erro && erro.message);
    check("cachedIgUrl existe no escopo do módulo", new vm.Script("typeof cachedIgUrl").runInContext(vmCtx) !== "undefined");
  }

  // ── 5) limpar acervo ──
  win.document.querySelector("#viva-btn-show-ranking").click(); await sleep(100);
  const clear = win.document.querySelector("#viva-intel-clear");
  clear.click(); await sleep(250);
  const modalLimpar = win.document.querySelector("#viva-intel-confirm");
  check("Limpar acervo abre pop-up de confirmação (não apaga no 1º clique)", !!modalLimpar && ("viva_acervo" in env.store) && /Apagar TODO o acervo/.test(modalLimpar.textContent));
  check("pop-up mostra a contagem e o botão perigoso", /criativos/.test(modalLimpar.textContent) && !!modalLimpar.querySelector(".viva-intel-confirm-btn.danger"));
  modalLimpar.querySelectorAll(".viva-intel-confirm-btn")[0].click(); await sleep(400);
  check("Cancelar mantém o acervo e fecha o pop-up", ("viva_acervo" in env.store) && !win.document.querySelector("#viva-intel-confirm"));
  clear.click(); await sleep(250);
  win.document.querySelector("#viva-intel-confirm .viva-intel-confirm-btn.danger").click(); await sleep(600);
  check("limpar acervo (confirmado) apaga o storage", !("viva_acervo" in env.store));
  check("Centro mostra estado vazio", !!win.document.querySelector(".viva-intel-empty"));

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE INTEGRAÇÃO PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERRO NO TESTE", e); process.exit(2); });
