// Sincronização da equipe: team_sync.js REAL contra o SQL REAL (Postgres local), via fetch que imita o PostgREST do Supabase.
const fs = require("fs");
const vm = require("vm");
const { execFileSync } = require("child_process");
const DIR = "/home/claude/repo/vivalabs-extension/";
const read = f => fs.readFileSync(DIR + f, "utf8");
const CODE = fs.readFileSync("/home/claude/work/team_code.txt", "utf8").trim();
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };

const lit = v => (typeof v === "number" ? String(v) : (v !== null && typeof v === "object") ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb` : `'${String(v).replace(/'/g, "''")}'`);
let rpcCalls = 0;
let offline = false;
function fakeFetch(url, opts) {
  const m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url);
  if (offline) return Promise.reject(new TypeError("Failed to fetch"));
  if (!m) return Promise.resolve({ ok: false, status: 404, text: async () => "{}" });
  if (!opts.headers || !opts.headers.apikey) return Promise.resolve({ ok: false, status: 401, text: async () => JSON.stringify({ message: "No API key" }) });
  rpcCalls += 1;
  const body = JSON.parse(opts.body);
  const args = Object.entries(body).map(([k, v]) => `${k} => ${lit(v)}`).join(", ");
  try {
    const out = execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1", "-c", "set role anon", "-c", `select to_jsonb(public.${m[1]}(${args}))`, "postgres"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return Promise.resolve({ ok: true, status: 200, text: async () => out.trim() });
  } catch (e) {
    const msg = /ERROR:\s+(.*)/.exec(String(e.stderr || ""));
    return Promise.resolve({ ok: false, status: 400, text: async () => JSON.stringify({ message: msg ? msg[1] : "erro" }) });
  }
}

function makeMiner(nome) {
  const store = {};
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const alarms = {};
  const chrome = {
    storage: { local: {
      async get(keys) { const out = {}; (keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = clone(store[k]); }); return out; },
      async set(o) { Object.entries(o).forEach(([k, v]) => { store[k] = clone(v); }); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); },
    } },
    alarms: { create(n, i) { alarms[n] = i; }, async get(n) { return alarms[n]; }, onAlarm: { addListener() {} } },
  };
  const ctx = { console: { log() {}, info() {}, warn() {}, error() {} }, chrome, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, Promise, Date, Math, JSON };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("intelligent_parser.js"), ctx);
  vm.runInContext(read("ranking_engine.js"), ctx);
  vm.runInContext(read("team_sync.js"), ctx);
  // fila serializada igual à do background
  vm.runInContext(`let _chain = Promise.resolve(); teamSyncInit({ serial: fn => { const run = _chain.then(fn); _chain = run.catch(() => {}); return run; } });
    // equivalente ao upsertAcervo do background:
    function upsertLocal(creatives) { const run = _chain.then(async () => {
      const d = await chrome.storage.local.get(VIVA_ACERVO_KEY);
      const r = mesclarAcervo(d[VIVA_ACERVO_KEY], creatives, Date.now());
      await chrome.storage.local.set({ [VIVA_ACERVO_KEY]: r.acervo });
      if (await teamConfig()) { await teamMarkDirtyRaw(creatives.map(c => acervoKey(sanitizarCriativo(c))).filter(Boolean)); }
    }); _chain = run.catch(() => {}); return run; }`, ctx);
  const run = code => vm.runInContext(code, ctx);
  const configure = async (code, name = nome) => { await chrome.storage.local.set({ viva_team_name: name, viva_team_code: code }); };
  return { nome, store, ctx, run, chrome, configure };
}
const cri = (i, extra = {}) => ({ id: String(100000000 + i), pid: "200000001", nome: `Pag ${i}`, copy: `copy ${i}`, dest: "https://x.com/a", dom: "x.com", dup: 6, dias: 20, inicio: Date.now() - 20 * 864e5, adv: 30, stage: "bruta", fonte: "glicemia", ...extra });
const sync = (m) => m.run("teamSyncNow({ force: true })");

(async () => {
  // limpa o cofre
  execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-q", "-c", "truncate public.viva_creatives", "postgres"]);

  const ana = makeMiner("Ana");
  const gus = makeMiner("Gus");

  // 0) sem configuração: nada acontece, estado 'off'
  let st = await sync(ana);
  check("sem código → estado 'off', sem chamadas", st.off === true && rpcCalls === 0);

  // 1) Gus já tinha acervo ANTES de entrar na equipe (seed) + Ana minera criativos novos
  await gus.run(`upsertLocal(${JSON.stringify([cri(1), cri(2)])})`);
  check("Gus: acervo local tem 2", (await gus.chrome.storage.local.get("viva_acervo")).viva_acervo.length === 2);
  await ana.configure(CODE);
  await ana.run(`upsertLocal(${JSON.stringify([cri(2, { dup: 9, adv: 50 }), cri(3), cri(4)])})`);
  st = await sync(ana);
  check("Ana sincroniza ok", st.ok === true && st.pushed === 3, JSON.stringify(st));
  await gus.configure(CODE);
  st = await sync(gus);
  check("Gus: 1ª sincronização ok (seed + pull)", st.ok === true, JSON.stringify(st));
  let gAc = (await gus.chrome.storage.local.get("viva_acervo")).viva_acervo;
  check("Gus agora vê 4 criativos (2 dele + 2 da Ana)", gAc.length === 4, String(gAc.length));
  const g2 = gAc.find(c => c.id === "100000002");
  check("merge: dup/adv do criativo em comum = o maior", g2.dup === 9 && g2.adv === 50, JSON.stringify([g2.dup, g2.adv]));
  let gMeta = (await gus.chrome.storage.local.get("viva_team_meta")).viva_team_meta;
  check("Gus vê quem achou (Ana)", gMeta["id:100000003"] && gMeta["id:100000003"].by === "Ana");
  check("Gus: o item que ele achou primeiro é dele", gMeta["id:100000001"] && gMeta["id:100000001"].by === "Gus");

  // 2) Ana recebe o que o Gus tinha (seed do Gus subiu)
  st = await sync(ana);
  let aAc = (await ana.chrome.storage.local.get("viva_acervo")).viva_acervo;
  check("Ana recebeu o criativo do Gus (4 no total)", aAc.length === 4 && aAc.some(c => c.id === "100000001"), String(aAc.length));

  // 3) Status compartilhado
  await gus.run(`teamSetStatus("id:100000003", "minerada")`);
  st = await sync(gus);
  check("Gus enviou status", st.ok === true);
  st = await sync(ana);
  let aMeta = (await ana.chrome.storage.local.get("viva_team_meta")).viva_team_meta;
  check("Ana vê 'minerada' por Gus", aMeta["id:100000003"].status === "minerada" && aMeta["id:100000003"].statusBy === "Gus", JSON.stringify(aMeta["id:100000003"]));
  // conflito: Ana marca descartada DEPOIS → vale a mais recente
  await new Promise(r => setTimeout(r, 5));
  await ana.run(`teamSetStatus("id:100000003", "descartada")`);
  await sync(ana); await sync(gus);
  gMeta = (await gus.chrome.storage.local.get("viva_team_meta")).viva_team_meta;
  check("status mais recente vence (descartada)", gMeta["id:100000003"].status === "descartada" && gMeta["id:100000003"].statusBy === "Ana", JSON.stringify(gMeta["id:100000003"]));

  // 4) Idempotência: sincronizar de novo não duplica nem altera
  const antes = (await gus.chrome.storage.local.get("viva_acervo")).viva_acervo.length;
  await sync(gus); await sync(gus);
  check("ressincronizar não duplica", (await gus.chrome.storage.local.get("viva_acervo")).viva_acervo.length === antes);
  check("fila de envio esvaziou", ((await gus.chrome.storage.local.get("viva_sync_dirty")).viva_sync_dirty || []).length === 0);

  // 5) Código errado
  const intruso = makeMiner("Intruso");
  await intruso.configure("CODIGO-ERRADO-123");
  await intruso.run(`upsertLocal(${JSON.stringify([cri(99)])})`);
  st = await sync(intruso);
  check("código errado → erro amigável", st.ok === false && /inválido/i.test(st.error), JSON.stringify(st));
  check("intruso não recebeu nada", ((await intruso.chrome.storage.local.get("viva_acervo")).viva_acervo || []).length === 1);
  const cofre = execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-At", "-c", "select count(*) from public.viva_creatives where key='id:100000099'", "postgres"], { encoding: "utf8" }).trim();
  check("intruso não gravou no cofre", cofre === "0", cofre);

  // 6) Offline: não quebra, mantém fila, e envia depois
  offline = true;
  await ana.run(`upsertLocal(${JSON.stringify([cri(5)])})`);
  st = await sync(ana);
  check("offline → erro, sem exceção", st.ok === false && /conex/i.test(st.error), JSON.stringify(st));
  check("offline → item segue na fila", ((await ana.chrome.storage.local.get("viva_sync_dirty")).viva_sync_dirty || []).includes("id:100000005"));
  offline = false;
  st = await sync(ana); await sync(gus);
  gAc = (await gus.chrome.storage.local.get("viva_acervo")).viva_acervo;
  check("volta a internet → Gus recebe o criativo 5", st.ok && gAc.some(c => c.id === "100000005"));

  // 7) Paginação (700 itens > página de 500)
  const lote = Array.from({ length: 700 }, (_, i) => cri(1000 + i));
  await ana.run(`upsertLocal(${JSON.stringify(lote)})`);
  st = await sync(ana);
  check("Ana enviou 700 em lotes", st.ok && st.pushed >= 700, JSON.stringify(st));
  rpcCalls = 0;
  st = await sync(gus);
  gAc = (await gus.chrome.storage.local.get("viva_acervo")).viva_acervo;
  check("Gus puxou as 2 páginas e tem ≥ 700", st.ok && gAc.length >= 700, String(gAc.length));
  check("puxou em mais de uma página", rpcCalls >= 2, String(rpcCalls));

  // 8) Item vencido (TTL) vindo do cofre é ignorado
  const velho = cri(7777, { });
  const agora = Date.now();
  const r = await gus.run(`mesclarRemotos([], [{ key: "id:107777777", rec: Object.assign(${JSON.stringify(velho)}, { lastSeen: ${agora - 40 * 864e5}, firstSeen: ${agora - 60 * 864e5} }) }], ${agora})`);
  check("registro com +30 dias não entra", r.acervo.length === 0);

  // 9) Trocar o código recomeça do zero
  await gus.configure(CODE);
  st = await gus.run("teamConfigChanged()");
  check("config alterada → ressincroniza ok", st.ok === true);

  // 10) Limpar local: Gus apaga a visão local, cursor mantém, nada volta sozinho
  await gus.chrome.storage.local.remove(["viva_acervo", "viva_team_meta", "viva_sync_dirty", "viva_sync_dirty_status"]);
  st = await sync(gus);
  check("após limpar local, nada reaparece até haver novidade", ((await gus.chrome.storage.local.get("viva_acervo")).viva_acervo || []).length === 0, JSON.stringify(st));

  // 11) Sinal de vida do radar
  {
    const psql = sql => execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-At", "-q", "-c", sql, "postgres"], { encoding: "utf8" }).trim();
    psql("truncate public.viva_heartbeat");
    const okPing = await ana.run(`teamPing({ on: true, status: "waiting", lastRunAt: Date.now() - 3600e3, nextRunAt: Date.now() + 3600e3, everyH: 6, n: 5 })`);
    check("ping do radar aceito", okPing === true);
    check("heartbeat gravado com nome do minerador", psql("select count(*) from public.viva_heartbeat where by = 'Ana'") === "1");
    // código errado: nada é gravado e não derruba
    const lixo = makeMiner("Intruso");
    await lixo.configure("CODIGO-ERRADO-123");
    const rLixo = await lixo.run(`teamPing({ on: true })`);
    check("ping com código errado falha sem gravar", rLixo === false && psql("select count(*) from public.viva_heartbeat where by = 'Intruso'") === "0");
    // info gigante é descartada (não estoura)
    await gus.run(`teamPing({ on: true, lixo: "x".repeat(5000) })`);
    check("info gigante vira {}", psql("select info::text from public.viva_heartbeat where by = 'Gus'") === "{}");
    // anon não lê a tabela direto
    let negado = false;
    try { execFileSync("psql", ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1", "-c", "set role anon", "-c", "select * from public.viva_heartbeat", "postgres"], { encoding: "utf8", stdio: "pipe" }); } catch (_) { negado = true; }
    check("tabela do heartbeat é inacessível direto", negado);
    // outra máquina lê pelo sync
    st = await sync(gus);
    const radarData = (await gus.chrome.storage.local.get("viva_team_radar")).viva_team_radar;
    check("sync traz o sinal de vida dos radares", radarData && Array.isArray(radarData.items) && radarData.items.some(i => i.by === "Ana"), JSON.stringify(radarData).slice(0, 200));
    const sinais = await gus.run(`radarSinais(${JSON.stringify(radarData)}, Date.now())`);
    const sAna = sinais.find(x => x.by === "Ana");
    check("radar da Ana aparece OK (ping fresco, rodada há 1 h)", sAna && sAna.nivel === "ok", JSON.stringify(sinais));
    check("radar com on:false (Gus) não aparece", !sinais.some(x => x.by === "Gus"));
    // passa o tempo: 30 min depois sem novo ping = sem sinal
    const sinais30 = await gus.run(`radarSinais(${JSON.stringify(radarData)}, Date.now() + 30 * 60000)`);
    check("30 min sem ping = SEM SINAL", sinais30.find(x => x.by === "Ana").nivel === "semsinal");
    // rodada atrasada (everyH 6, última rodada há 20 h, ping fresco)
    await ana.run(`teamPing({ on: true, status: "waiting", lastRunAt: Date.now() - 20 * 3600e3, everyH: 6 })`);
    await sync(gus);
    const rd2 = (await gus.chrome.storage.local.get("viva_team_radar")).viva_team_radar;
    const s2 = await gus.run(`radarSinais(${JSON.stringify(rd2)}, Date.now())`);
    check("rodada 20 h atrás com everyH 6 = ATRASADO", s2.find(x => x.by === "Ana").nivel === "atrasado", JSON.stringify(s2));
    // SQL antigo (sem viva_status): sync continua ok
    psql("alter function public.viva_status(text) rename to viva_status_bak");
    st = await sync(gus);
    const rd3 = (await gus.chrome.storage.local.get("viva_team_radar")).viva_team_radar;
    psql("alter function public.viva_status_bak(text) rename to viva_status");
    check("sem a função nova no banco, o sync normal NÃO quebra", st.ok === true && rd3.items.length === 0 && !!rd3.error, JSON.stringify(st));
  }

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE SINCRONIZAÇÃO PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("ERRO NO TESTE", e); process.exit(2); });
