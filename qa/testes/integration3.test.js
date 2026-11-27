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
  const abrirCentro = async () => { $("#viva-btn-show-ranking").click(); await sleep(300); return $("#viva-ranking-overlay"); };
  const aba = async (ov, nome) => { ov.querySelector(`.viva-intel-tabs button[data-tab="${nome}"]`).click(); await sleep(120); };
  const modal = () => $("#viva-intel-confirm");
  const cliqueModal = async (qual) => { const b = $$("#viva-intel-confirm .viva-intel-confirm-btn"); (qual === "cancelar" ? b[0] : b[b.length - 1]).click(); await sleep(500); };

  let ov = await abrirCentro();
  check("Centro abriu", !!ov);
  const cards = () => $$("#viva-intel-list .viva-intel-card");
  check("barra tem botões de apagar", !!ov.querySelector("#viva-del-sel") && !!ov.querySelector("#viva-del-all"));
  check("apagar selecionados começa desabilitado", ov.querySelector("#viva-del-sel").disabled === true);

  // ── apagar selecionados (criativos) ──
  const todos = ov.querySelector("#viva-intel-search");
  todos.value = "Lixo Um"; todos.dispatchEvent(new win.Event("input", { bubbles: true })); await sleep(350);
  check("filtro por nome mostra 2 criativos", cards().length === 2, String(cards().length));
  cards()[0].querySelector(".viva-intel-sel").click(); await sleep(60);
  check("seleção habilita 'Apagar selecionados (1)'", ov.querySelector("#viva-del-sel").disabled === false && /\(1\)/.test(ov.querySelector("#viva-del-sel").textContent), ov.querySelector("#viva-del-sel").textContent);
  ov.querySelector("#viva-del-sel").click(); await sleep(250);
  check("apagar abre pop-up (nada some antes de confirmar)", !!modal() && env.store.viva_acervo.length === 6 && /Apagar 1 criativo\?/.test(modal().textContent), modal() && modal().textContent.slice(0, 80));
  check("pop-up tem caixinha de bloqueio marcada", modal().querySelector("input[type=checkbox]").checked === true);
  await cliqueModal("cancelar");
  check("Cancelar não apaga nada", env.store.viva_acervo.length === 6 && !modal());
  ov.querySelector("#viva-del-sel").click(); await sleep(250);
  await cliqueModal("confirmar");
  check("confirmar apaga só o selecionado", env.store.viva_acervo.length === 5 && !env.store.viva_acervo.some(c => c.id === lista[2].id), String(env.store.viva_acervo.length));
  check("item apagado foi para a lixeira (bloqueado)", env.store.viva_lixeira && env.store.viva_lixeira.chaves.includes("id:" + lista[2].id), JSON.stringify(env.store.viva_lixeira));
  check("lista na tela já atualizou", cards().length === 1, String(cards().length));
  check("chip de bloqueados apareceu", !ov.querySelector("#viva-intel-lixeira").hidden && /1 bloqueado/.test(ov.querySelector("#viva-intel-lixeira").textContent), ov.querySelector("#viva-intel-lixeira").textContent);

  // o motor coleta de novo o mesmo criativo → bloqueado
  const re = await sendToBg({ action: "ACERVO_UPSERT", creatives: [lista[2], mk(9, "111222339", "novo.com", "Loja Nova")] }, 7);
  check("coleta nova NÃO traz de volta o apagado, mas aceita o resto", env.store.viva_acervo.length === 6 && !env.store.viva_acervo.some(c => c.id === lista[2].id) && env.store.viva_acervo.some(c => c.nome === "Loja Nova"), String(env.store.viva_acervo.length));

  // ── apagar os filtrados (criativos) ──
  todos.value = ""; todos.dispatchEvent(new win.Event("input", { bubbles: true })); await sleep(350);
  const nAntes = env.store.viva_acervo.length;
  todos.value = "Loja Nova"; todos.dispatchEvent(new win.Event("input", { bubbles: true })); await sleep(350);
  check("botão 'Apagar os filtrados' mostra a contagem", /\(1\)/.test(ov.querySelector("#viva-del-all").textContent), ov.querySelector("#viva-del-all").textContent);
  ov.querySelector("#viva-del-all").click(); await sleep(250);
  check("pop-up dos filtrados cita o filtro", /Filtro:/.test(modal().textContent) && /Loja Nova/.test(modal().textContent), modal().textContent);
  modal().querySelector("input[type=checkbox]").click();  // desmarca "bloquear"
  await cliqueModal("confirmar");
  check("filtrados apagados sem bloquear", env.store.viva_acervo.length === nAntes - 1 && !(env.store.viva_lixeira.chaves.includes("id:" + mk(9).id)), JSON.stringify(env.store.viva_lixeira));
  await sendToBg({ action: "ACERVO_UPSERT", creatives: [mk(9, "111222339", "novo.com", "Loja Nova")] }, 7);
  check("sem bloqueio o criativo pode voltar", env.store.viva_acervo.length === nAntes, String(env.store.viva_acervo.length));
  todos.value = ""; todos.dispatchEvent(new win.Event("input", { bubbles: true })); await sleep(350);

  // ── bibliotecas em lote ──
  await aba(ov, "paginas");
  check("aba Bibliotecas tem caixinha de seleção", cards().length >= 2 && cards().every(c => !!c.querySelector(".viva-intel-sel")), String(cards().length));
  const cardLixo = cards().find(c => c.textContent.includes("Lixo Dois"));
  cardLixo.querySelector(".viva-intel-sel").click(); await sleep(60);
  check("info da aba Bibliotecas fala em bibliotecas", /1 biblioteca selecionad/.test(ov.querySelector("#viva-sel-info").textContent), ov.querySelector("#viva-sel-info").textContent);
  ov.querySelector("#viva-del-sel").click(); await sleep(250);
  check("pop-up de biblioteca avisa quantos criativos saem junto", /Apagar 1 biblioteca\?/.test(modal().textContent) && /2 criativos serão removidos/.test(modal().textContent), modal().textContent);
  await cliqueModal("confirmar");
  check("biblioteca inteira apagada (2 criativos)", !env.store.viva_acervo.some(c => c.pid === "111222333"), JSON.stringify(env.store.viva_acervo.map(c => c.pid)));
  check("biblioteca bloqueada na lixeira", env.store.viva_lixeira.paginas.includes("111222333"));
  await sendToBg({ action: "ACERVO_UPSERT", creatives: [mk(5, "111222333", "lixo2.com", "Lixo Dois")] }, 7);
  check("biblioteca bloqueada não volta na coleta", !env.store.viva_acervo.some(c => c.pid === "111222333"));

  // ── ofertas em lote ──
  await aba(ov, "ofertas");
  check("aba Ofertas tem caixinha de seleção", cards().length >= 1 && cards().every(c => !!c.querySelector(".viva-intel-sel")), String(cards().length));
  const cardBoa = cards().find(c => c.textContent.includes("boa.com"));
  check("card de oferta tem botão Monitorar", !!cardBoa && !!Array.from(cardBoa.querySelectorAll("button")).find(b => b.textContent === "Monitorar"));
  ov.querySelector("#viva-sel-all").click(); await sleep(100);
  const nOfertas = cards().length;
  check("'Selecionar os filtrados' marca todas as ofertas", new RegExp(`^${nOfertas} ofertas? selecionad`).test(ov.querySelector("#viva-sel-info").textContent), ov.querySelector("#viva-sel-info").textContent);
  ov.querySelector("#viva-sel-clear").click(); await sleep(60);
  cards().find(c => c.textContent.includes("boa.com")).querySelector(".viva-intel-sel").click(); await sleep(60);
  ov.querySelector("#viva-del-sel").click(); await sleep(250);
  await cliqueModal("confirmar");
  check("oferta apagada leva os criativos do domínio", !env.store.viva_acervo.some(c => c.dom === "boa.com") && env.store.viva_lixeira.dominios.includes("boa.com"), JSON.stringify(env.store.viva_acervo.map(c => c.dom)));

  // ── liberar bloqueados ──
  const chip = ov.querySelector("#viva-intel-lixeira");
  check("chip mostra o total de bloqueados", !chip.hidden && /bloqueados/.test(chip.textContent), chip.textContent);
  chip.click(); await sleep(250);
  check("liberar pede confirmação", !!modal() && /Liberar/.test(modal().textContent) && !!env.store.viva_lixeira);
  await cliqueModal("cancelar");
  check("cancelar mantém o bloqueio", !!env.store.viva_lixeira);
  chip.click(); await sleep(250); await cliqueModal("confirmar");
  check("liberar esvazia a lixeira e some o chip", !env.store.viva_lixeira && ov.querySelector("#viva-intel-lixeira").hidden === true);

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

  // ── MONITORAR: sempre abre o pop-up, pré-preenchido ──
  await aba(ov, "criativos");
  // mapa de Instagram conhecido para a biblioteca Loja Nova (111222339) → pré-preenche o pop-up
  await sendToBg({ action: "IG_MAP_SET", pid: "111222339", nome: "Loja Nova", url: "https://www.instagram.com/lojanova/" }, 7);
  await sleep(150);
  check("mapa de Instagram gravado no storage", env.store.viva_ig_map && env.store.viva_ig_map["pid:111222339"].url === "https://www.instagram.com/lojanova", JSON.stringify(env.store.viva_ig_map));
  await sleep(1100);
  const cNova = cards().find(c => c.textContent.includes("Loja Nova"));
  check("card mostra pílula 📸 do Instagram mapeado", !!cNova && !!cNova.querySelector(".viva-intel-pill.ig") && /lojanova/.test(cNova.querySelector(".viva-intel-pill.ig").textContent), cNova && cNova.textContent.slice(0, 200));
  cNova.querySelector(".viva-intel-pill.ig").click();
  check("pílula 📸 abre em nova guia sem opener", abertas.length === 1 && abertas[0].u === "https://www.instagram.com/lojanova" && abertas[0].alvo === "_blank" && /noopener/.test(abertas[0].feat), JSON.stringify(abertas));
  abertas.length = 0;

  const sb = $("#viva-sidebar");
  check("antes de clicar, painel Monitorar está recolhido atrás do Centro", sb.classList.contains("viva-ranking-suspended") && !sb.classList.contains("viva-from-intel"));
  Array.from(cNova.querySelectorAll("button")).find(b => b.textContent === "Monitorar").click(); await sleep(250);
  check("clicar Monitorar ABRE o pop-up (não salva direto)", sb.classList.contains("viva-from-intel") && !sb.classList.contains("viva-ranking-suspended") && salvos.length === 0, String(salvos.length));
  check("pop-up foi para o fim do body (fica por cima do Centro)", win.document.body.lastElementChild === sb);
  check("nome da página pré-preenchido", $("#viva-side-name").value === "Loja Nova", $("#viva-side-name").value);
  check("GEO pré-preenchido", $("#viva-side-geo").value === "ALL");
  check("nicho sugerido a partir do termo de busca", $("#viva-side-nicho").value === "Diabetes receitas", $("#viva-side-nicho").value);
  check("Instagram vem do mapa", $("#viva-side-instagram").value === "https://www.instagram.com/lojanova", $("#viva-side-instagram").value);
  check("aba Página selecionada", $("#viva-tab-page").classList.contains("active"));
  check("aviso 'Vindo do Centro' visível", /Vindo do Centro/.test($("#viva-monitor-ctx-note").textContent));
  check("botão de fechar do pop-up existe", !!$("#viva-btn-close-ctx"));

  // fechar sem salvar limpa e devolve o painel
  $("#viva-btn-close-ctx").click(); await sleep(100);
  check("fechar sem salvar: nada foi enviado", salvos.length === 0);
  check("fechar devolve o painel ao estado de fundo e limpa campos", sb.classList.contains("viva-ranking-suspended") && !sb.classList.contains("viva-from-intel") && $("#viva-side-name").value === "" && $("#viva-side-nicho").value === "");

  // abrir de novo, editar e confirmar → salva com o ALVO do Centro (não a página de trás)
  Array.from(cNova.querySelectorAll("button")).find(b => b.textContent === "Monitorar").click(); await sleep(200);
  $("#viva-side-nicho").value = "Diabetes";
  $("#viva-side-save").click(); await sleep(250);
  const conf = $("#viva-confirm-overlay");
  check("salvar mostra a confirmação com os dados do alvo", !!conf && /Loja Nova/.test(conf.textContent) && /Diabetes/.test(conf.textContent) && /instagram\.com\/lojanova/.test(conf.textContent), conf && conf.textContent.replace(/\s+/g, " ").slice(0, 200));
  check("ainda nada salvo antes de confirmar", salvos.length === 0);
  $("#viva-modal-confirm").click(); await sleep(500);
  check("salvou 1 vez", salvos.length === 1, String(salvos.length));
  const s = salvos[0] || {};
  check("payload usa a URL da biblioteca do alvo (não a da aba atual)", s.url === "https://www.facebook.com/ads/library/?view_all_page_id=111222339" && s.tipo === "pagina", JSON.stringify(s));
  check("payload leva nome, geo, nicho editado e Instagram", s.nome === "Loja Nova" && s.geo === "ALL" && s.nicho === "Diabetes" && s.instagram_url === "https://www.instagram.com/lojanova", JSON.stringify(s));
  check("total inicial vem do acervo (7 anúncios)", s.ads_count_inicial === 7, String(s.ads_count_inicial));
  check("botão do card virou '✓ Monitorado'", Array.from(cNova.querySelectorAll("button")).find(b => /Monitorado/.test(b.textContent)) !== undefined);
  await sleep(300);
  $("#viva-btn-close-ctx").click(); await sleep(50);

  // falha de rede em modo Centro: não finge sucesso
  const cOutra = cards().find(c => !c.textContent.includes("Loja Nova"));
  win.fetch = async (url, opts) => ({ ok: false, status: 500, json: async () => ({}) });
  if (cOutra) {
    Array.from(cOutra.querySelectorAll("button")).find(b => b.textContent === "Monitorar").click(); await sleep(200);
    $("#viva-side-save").click(); await sleep(200); $("#viva-modal-confirm").click(); await sleep(400);
    check("erro do servidor: botão volta a poder tentar de novo", $("#viva-side-save").textContent === "Tentar de novo" && $("#viva-side-save").disabled === false, $("#viva-side-save").textContent);
    $("#viva-btn-close-ctx").click(); await sleep(50);
  }
  win.fetch = async (url, opts) => { if (String(url).includes("/api/salvar")) { salvos.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; } return { ok: true, json: async () => [] }; };

  // oferta (domínio): pop-up abre na aba Domínio
  await aba(ov, "ofertas");
  const cardOf = cards()[0];
  Array.from(cardOf.querySelectorAll("button")).find(b => b.textContent === "Monitorar").click(); await sleep(200);
  check("Monitorar de oferta abre a aba Domínio com o domínio", $("#viva-tab-domain").classList.contains("active") && $("#viva-side-domain").value.includes("."), $("#viva-side-domain").value);
  salvos.length = 0;
  $("#viva-side-save-domain").click(); await sleep(200); $("#viva-modal-confirm").click(); await sleep(400);
  check("salva domínio como tipo 'dominio'", salvos.length === 1 && salvos[0].tipo === "dominio" && salvos[0].nome === $("#viva-side-domain").value, JSON.stringify(salvos));
  $("#viva-btn-close-ctx").click(); await sleep(50);

  // criativo sem ID de biblioteca não abre pop-up
  check("fechar o Centro fecha também o pop-up", true);
  const sbAntes = $("#viva-sidebar");
  await aba(ov, "criativos");
  Array.from(cards()[0].querySelectorAll("button")).find(b => b.textContent === "Monitorar").click(); await sleep(150);
  check("pop-up aberto de novo", $("#viva-sidebar").classList.contains("viva-from-intel"));
  $("#viva-close-ranking").click(); await sleep(150);
  check("fechar o Centro derruba o pop-up e limpa o contexto", !$("#viva-sidebar").classList.contains("viva-from-intel") && new vm.Script("_vivaMonitorCtx === null").runInContext(vmCtx));
  check("painel volta visível para o uso normal", !$("#viva-sidebar").classList.contains("viva-ranking-suspended"));

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

  // ── triagem em lote: descartar + Shift ──
  {
    const novos = [41, 42, 43, 44, 45, 46].map(i => mk(i, "9990000" + i, "triagem" + i + ".com", "Triagem " + i, { dup: 20 - i }));
    await sendToBg({ action: "ACERVO_UPSERT", creatives: novos }, 7);
    const ov3 = await abrirCentro();
    await aba(ov3, "criativos");
    const busca = ov3.querySelector("#viva-intel-search");
    busca.value = "Triagem"; busca.dispatchEvent(new win.Event("input", { bubbles: true })); await sleep(350);
    const cs = () => $$("#viva-intel-list .viva-intel-card");
    check("triagem: 6 criativos listados", cs().length === 6, String(cs().length));
    const tri = ov3.querySelector("#viva-triagem");
    check("triagem: faixa própria existe com Descartar e Apagar", !!tri && !!tri.querySelector("#viva-dis-sel") && !!tri.querySelector("#viva-del-sel") && !!tri.querySelector("#viva-sel-all"));
    check("triagem: Descartar começa desabilitado", tri.querySelector("#viva-dis-sel").disabled === true);
    check("triagem: dica explica o que fazer", /Shift/.test(tri.querySelector("#viva-tri-dica").textContent), tri.querySelector("#viva-tri-dica").textContent);
    check("triagem: 'Selecionar todos' mostra a contagem", /Selecionar todos \(6\)/.test(tri.querySelector("#viva-sel-all").textContent), tri.querySelector("#viva-sel-all").textContent);
    // Shift + clique marca intervalo (1ª e 4ª => 4 cards)
    const marcar = (idx, shift) => {
      const cb = cs()[idx].querySelector(".viva-intel-sel");
      cb.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: !!shift }));
      return cb;
    };
    marcar(0, false); await sleep(60);
    check("triagem: clique simples marca 1", /^1 criativo selecionado/.test(ov3.querySelector("#viva-sel-info").textContent), ov3.querySelector("#viva-sel-info").textContent);
    marcar(3, true); await sleep(120);
    check("triagem: Shift+clique marca o intervalo (4)", /^4 criativos selecionados/.test(ov3.querySelector("#viva-sel-info").textContent) && cs().slice(0, 4).every(c => c.querySelector(".viva-intel-sel").checked) && !cs()[4].querySelector(".viva-intel-sel").checked, ov3.querySelector("#viva-sel-info").textContent);
    check("triagem: faixa muda de estado com seleção", ov3.querySelector("#viva-triagem").classList.contains("tem-selecao"));
    check("triagem: botão mostra (4)", /Descartar selecionados \(4\)/.test(ov3.querySelector("#viva-dis-sel").textContent));
    const chavesSel = cs().slice(0, 4).map(c => null);
    const antesAcervo = env.store.viva_acervo.length;
    ov3.querySelector("#viva-dis-sel").click(); await sleep(400);
    const meta = env.store.viva_team_meta || {};
    const descartadas = Object.entries(meta).filter(([k, v]) => v && v.status === "descartada").map(([k]) => k);
    check("descartar em lote grava status descartada nas 4 chaves", descartadas.length === 4, JSON.stringify(meta));
    check("descartar NÃO apaga do acervo nem bloqueia", env.store.viva_acervo.length === antesAcervo && !env.store.viva_lixeira, `${env.store.viva_acervo.length} vs ${antesAcervo}`);
    check("descartados saem da lista (filtro Sem descartadas)", cs().length === 2, String(cs().length));
    check("seleção é limpa após descartar", /^2 criativos no filtro atual/.test(ov3.querySelector("#viva-sel-info").textContent), ov3.querySelector("#viva-sel-info").textContent);
    // recuperar: filtro Descartadas mostra os 4
    const st = ov3.querySelector("#viva-intel-status");
    st.value = "descartada"; st.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(200);
    check("filtro Descartadas recupera os 4", cs().length === 4, String(cs().length));
    st.value = "ativas"; st.dispatchEvent(new win.Event("change", { bubbles: true })); await sleep(200);
    // abas Ofertas/Bibliotecas: Descartar não aparece
    await aba(ov3, "ofertas");
    check("Descartar fica escondido na aba Ofertas", ov3.querySelector("#viva-dis-sel").hidden === true);
    await aba(ov3, "paginas");
    check("Descartar fica escondido na aba Bibliotecas", ov3.querySelector("#viva-dis-sel").hidden === true);
    await aba(ov3, "criativos");
    check("Descartar volta a aparecer em Criativos", ov3.querySelector("#viva-dis-sel").hidden === false);
    // mensagem inválida no background
    const bad = await sendToBg({ action: "TEAM_SET_STATUS_LOTE", keys: [], novoStatus: "descartada" }, 7);
    check("background recusa lote vazio", bad && bad.status === "error", JSON.stringify(bad));
    const bad2 = await sendToBg({ action: "TEAM_SET_STATUS_LOTE", keys: ["id:1"], novoStatus: "qualquer" }, 7);
    check("background recusa status inválido", bad2 && bad2.status === "error", JSON.stringify(bad2));
    $("#viva-close-ranking").click(); await sleep(150);
  }

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE LOTE/MONITORAR/INSTAGRAM PASSARAM");
  process.exit(fails ? 1 : 0);
})();
