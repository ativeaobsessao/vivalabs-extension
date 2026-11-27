// Salvar Funil: 1 clique, modal fecha na hora, envio em segundo plano com reenvio (funnel_outbox.js REAL).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");
const DIR = path.resolve(__dirname, "../..");
const read = f => fs.readFileSync(path.join(DIR, f), "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function makeWorld({ latency = 0, respond } = {}) {
  const store = {}, listeners = [], calls = [], alarms = [], increments = [];
  const storage = {
    local: {
      async get(k) { return k in store ? { [k]: clone(store[k]) } : {}; },
      async set(o) {
        for (const [k, v] of Object.entries(o)) { store[k] = clone(v); listeners.forEach(l => l({ [k]: { newValue: clone(v) } }, "local")); }
      },
    },
    onChanged: { addListener: l => listeners.push(l), removeListener() {} },
  };
  const world = { store, calls, alarms, increments, storage, respond: respond || (() => ({ status: 200, body: {} })) };
  const bg = {
    chrome: { storage, runtime: {}, alarms: { create: n => alarms.push(n), async clear() {}, onAlarm: { addListener() {} } } },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, AbortController, JSON, Date, Boolean, Array, Promise,
    getNextFunilSequence: async () => ({ proximo: "ads07" }),
    incrementFunilSequence: async (...a) => increments.push(a),
    fetch: async (url, opt = {}) => {
      const call = { path: new URL(url).pathname, body: opt.body ? JSON.parse(opt.body) : null };
      calls.push(call);
      await sleep(latency);
      const r = world.respond(call);
      if (r === "offline") throw new TypeError("Failed to fetch");
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    },
  };
  vm.createContext(bg);
  vm.runInContext(read("funnel_outbox.js"), bg);
  world.run = code => vm.runInContext(code, bg);
  world.enqueue = job => bg.funnelEnqueue(clone(job));
  world.process = () => bg.funnelProcess();
  world.queue = () => store.viva_funnel_outbox || [];
  world.result = () => store.viva_funnel_result;
  return world;
}

const job = (over = {}) => ({
  id: "j1", apiUrl: "https://api.test", nome: "Loja", slug: "loja", pageId: "123", urlPageId: "123",
  registro: { url: "https://fb/lib", tipo: "pagina", ads_count_inicial: 250 },
  etapas: [{ tipo: "ads", rotulo: "ads01", url: "https://ads/1" }, { tipo: "tsl", rotulo: "tsl01", url: "https://tsl/1" }],
  autoLabel: false, ...over,
});
const nodes = w => w.calls.filter(c => c.path === "/api/funis/salvar-node");

(async () => {
  let w = makeWorld({ latency: 300 });
  const t0 = Date.now();
  const ack = await w.enqueue(job());
  const ms = Date.now() - t0;
  check("enfileirar não espera o servidor", ack.ok && ms < 100, `${ms}ms`);
  check("funil já está guardado antes de o servidor responder", w.queue().length === 1);
  await w.process();
  check("envio concluído: fila vazia e resultado ok", w.queue().length === 0 && w.result().status === "ok", JSON.stringify(w.result()));
  check("cadastra uma vez e salva as 2 etapas", w.calls.filter(c => c.path === "/api/salvar").length === 1 && nodes(w).length === 2);
  check("checkout_url encadeia a próxima etapa", nodes(w)[0].body.checkout_url === "https://tsl/1" && nodes(w)[1].body.checkout_url === null);
  check("sequencial local avança só pelo ADS", w.increments.length === 1);

  w = makeWorld({ respond: () => "offline" });
  await w.enqueue(job()); await w.process();
  check("sem rede: nada é perdido e o reenvio é agendado", w.queue().length === 1 && w.alarms.length > 0 && w.result().status === "tentando");
  w.respond = () => ({ status: 200, body: {} });
  await w.process();
  check("rede voltou: salvo", w.queue().length === 0 && w.result().status === "ok");

  let quebra = true;
  w = makeWorld({ respond: c => (quebra && c.body?.tipo === "ads" ? { status: 500, body: {} } : { status: 200, body: {} }) });
  await w.enqueue(job()); await w.process();
  check("uma etapa com erro 500 não impede as outras", nodes(w).some(c => c.body.tipo === "tsl") && w.queue()[0].etapas[1].salva === true);
  quebra = false; w.calls.length = 0; await w.process();
  check("reenvio manda só o que faltava, sem recadastrar", nodes(w).length === 1 && nodes(w)[0].body.tipo === "ads" && !w.calls.some(c => c.path === "/api/salvar"));

  w = makeWorld({ respond: c => (c.body?.tipo === "ads" ? { status: 500, body: {} } : { status: 200, body: {} }) });
  await w.enqueue(job());
  for (let i = 0; i < 6; i++) await w.process();
  check("erro persistente: avisa falha parcial e guarda o funil", w.result().status === "falhou" && w.result().message.includes("1 de 2") && w.queue()[0].status === "falhou", JSON.stringify(w.result()));

  w = makeWorld({ respond: c => (c.path === "/api/paginas" ? { status: 200, body: [{ tipo: "pagina", slug: "ja-monitorada", url: "x?view_all_page_id=123" }] } : { status: 200, body: { slug: "loja" } }) });
  await w.enqueue(job({ autoLabel: true })); await w.process();
  check("anunciante já monitorado mantém o slug dele", nodes(w).every(c => c.body.slug === "ja-monitorada"));
  check("rótulo pendente é resolvido em segundo plano", nodes(w)[0].body.rotulo === "ads07", nodes(w)[0].body.rotulo);

  // ── content.js REAL: um clique em "Revisar & Salvar Funil" ──
  w = makeWorld({ latency: 2000 });
  const dom = new JSDOM(`<!DOCTYPE html><body><div role="main">x</div></body>`, { url: "https://www.facebook.com/ads/library/?view_all_page_id=123", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  win.chrome = {
    storage: w.storage,
    runtime: { id: "x", onMessage: { addListener() {} }, sendMessage: async m => {
      if (m.action === "FUNNEL_ENQUEUE") return w.enqueue(m.job);
      if (m.action === "GET_NEXT_FUNIL_SEQ") { await sleep(4000); return { proximo: "ads02" }; }
      return null;
    } },
  };
  win.fetch = async () => ({ ok: true, json: async () => [] });
  win.IntersectionObserver = win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.console = { log() {}, info() {}, debug() {}, warn() {}, error() {} };
  const ctx = dom.getInternalVMContext();
  for (const f of ["intelligent_parser.js", "ranking_engine.js", "export_data.js", "monitor_url.js", "content.js"]) new vm.Script(read(f), { filename: f }).runInContext(ctx);
  await sleep(100);
  new vm.Script(`openFunnelModal("https://tsl/1", "Loja", { prefillAd: true, pageId: "123", libraryUrl: "https://ads/1" })`).runInContext(ctx);
  const t1 = Date.now();
  win.document.querySelector("#viva-funnel-review").click();
  await sleep(100);
  check("modal fecha em menos de 100ms, mesmo com servidor e sequencial lentos", !win.document.querySelector("#viva-funnel-modal-container"), `${Date.now() - t1}ms`);
  check("sem segunda janela de confirmação", !win.document.querySelector("#viva-funnel-confirm-overlay"));
  check("aviso imediato de salvo", win.document.body.textContent.includes("Funil salvo!"));
  await sleep(8600); // 4 chamadas de 2s cada
  check("aviso de confirmação do servidor", win.document.body.textContent.includes("Funil no dashboard"));

  console.log(fails ? `${fails} FALHA(S)` : "TODOS OS TESTES DE SALVAR FUNIL PASSARAM");
  process.exit(fails ? 1 : 0);
})();
