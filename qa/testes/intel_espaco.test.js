// Aviso dos 150 mil: intel_espaco.js REAL (com team_sync, notify, auto_export e export_data reais), banco simulado.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const DIR = path.resolve(__dirname, "../..");
const read = f => fs.readFileSync(path.join(DIR, f), "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };

function montar({ comEquipe = true, linhasNoBanco = 2500 } = {}) {
  const store = comEquipe ? { viva_team_code: "codigo-de-teste-123", viva_team_name: "Gus" } : {};
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const mundo = { agora: 1_800_000_000_000, total: 0, bytes: 100e6, versao: 2, downloads: [], mensagens: [], chamadas: [], falhaPull: false, falhaAviso: false, selo: "" };
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) { const out = {}; (keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = clone(store[k]); }); return out; },
        async set(o) { const mudou = {}; Object.entries(o).forEach(([k, v]) => { store[k] = clone(v); mudou[k] = { newValue: clone(v) }; }); listeners.forEach(fn => fn(mudou, "local")); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); },
      },
      onChanged: { addListener: fn => listeners.push(fn) },
    },
    alarms: { create() {}, async get() {}, onAlarm: { addListener() {} } },
    action: {
      async setBadgeText({ text }) { mundo.selo = text; },
      async getBadgeText() { return mundo.selo; },
      async setBadgeBackgroundColor() {},
    },
    runtime: {
      getManifest: () => ({ version: "1.14.0" }),
      async getContexts() { return [{}]; },
      async sendMessage(m) { return m.action === "BLOB_URL" ? { ok: true, url: "blob:x" } : { ok: true }; },
    },
    offscreen: { async createDocument() {}, async closeDocument() {} },
    downloads: { async download(o) { mundo.downloads.push(o.filename); return mundo.downloads.length; } },
  };
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {} }, chrome, AbortController, Promise, Date, Math, JSON, URL,
    TextEncoder, TextDecoder, Uint8Array, Uint32Array, Blob, Response, CompressionStream,
    setTimeout: () => 0, clearTimeout() {}, btoa: s => Buffer.from(s, "binary").toString("base64"),
    fetch: async () => { throw new Error("sem rede no teste"); },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  ["ranking_engine.js", "export_data.js", "intel_core.js", "team_sync.js", "notify.js", "auto_export.js", "intel_espaco.js"]
    .forEach(f => vm.runInContext(read(f), ctx, { filename: f }));
  const linha = i => ({ key: `id:${700000000 + i}`, seq: i, by: "Ana", status: i % 5 === 0 ? "descartada" : "nova", rec: { id: String(700000000 + i), nome: `Loja ${i}`, copy: "texto", dup: 2, dias: 3, adv: 4, lastSeen: mundo.agora } });
  ctx.__rpc = async (fn, body) => {
    mundo.chamadas.push(fn);
    if (fn === "viva_info") {
      if (mundo.versao < 2) throw new Error("Could not find the function public.viva_info(p_token) in the schema cache");
      return { versao: 2, total: mundo.total, descartados: 0, bloqueados: 0, bytes: mundo.bytes };
    }
    if (fn === "viva_pull") {
      if (mundo.falhaPull) throw new Error("Failed to fetch");
      return Array.from({ length: linhasNoBanco }, (_, i) => linha(i + 1)).filter(r => r.seq > body.p_since).slice(0, body.p_limit);
    }
    return fn === "viva_status" ? { items: [] } : 0;
  };
  ctx.__enviar = async (_cfg, texto) => { if (mundo.falhaAviso) throw new Error("Discord recusou"); mundo.mensagens.push(texto); return true; };
  ctx.__agora = () => mundo.agora;
  vm.runInContext(`teamRpc = (f, b) => __rpc(f, b); notifEnviarTexto = (c, t) => __enviar(c, t);
    espacoInit({ now: () => __agora(), linhasPorArquivo: 1000 }); aexpInit({ now: () => __agora() });`, ctx);
  return { ctx, store, mundo, run: code => vm.runInContext(code, ctx) };
}

const discord = { tipo: "discord", webhook: "https://discord.com/api/webhooks/1/abc" };
const acesso = a => a.run("espacoVerificar({ acesso: true })");
const periodico = a => a.run("espacoVerificar({ acesso: false })");
const sincronizar = a => a.run("teamSyncNow({ force: true })");

(async () => {
  let a = montar({ comEquipe: false });
  check("sem código da equipe: nada acontece", (await acesso(a)).status === "local" && a.mundo.downloads.length === 0);

  a = montar();
  a.mundo.versao = 1;
  check("banco antigo (SQL não rodou): modo local, sem erro", (await acesso(a)).status === "local");
  await sincronizar(a);
  check("banco antigo: continua baixando o cofre como antes", a.mundo.chamadas.includes("viva_pull") && !a.store.viva_vault_info);

  a = montar();
  a.store.viva_notify_config = discord;
  a.mundo.total = 90000;
  await sincronizar(a);
  check("banco novo: guarda o total e NÃO baixa o cofre inteiro", a.store.viva_vault_info.total === 90000 && !a.mundo.chamadas.includes("viva_pull"));
  let r = await acesso(a);
  check("90 mil: sem aviso, sem planilha, sem selo", r.nivel === "ok" && a.mundo.mensagens.length === 0 && a.mundo.downloads.length === 0 && a.mundo.selo === "");

  a.mundo.total = 121000;
  r = await acesso(a); await acesso(a);
  check("121 mil: avisa a equipe uma vez que está acabando", r.nivel === "atencao" && a.mundo.mensagens.length === 1 && /121\.000 de 150 mil/.test(a.mundo.mensagens[0]), a.mundo.mensagens[0]);
  check("121 mil: ainda não baixa nada", a.mundo.downloads.length === 0);

  a.mundo.total = 150200;
  await sincronizar(a);
  r = await periodico(a);
  check("passou de 150 mil: selo no ícone e aviso à equipe já na sincronização", r.nivel === "estourou" && a.mundo.selo === "150k" && a.mundo.mensagens.length === 2, JSON.stringify(a.mundo.mensagens));
  check("aviso diz o que fazer", /sem espaço/.test(a.mundo.mensagens[1]) && /apag/.test(a.mundo.mensagens[1]) && /supabase\.com\/pricing/.test(a.mundo.mensagens[1]));
  check("sem ninguém abrir a extensão, ainda não baixa", a.mundo.downloads.length === 0);

  await acesso(a);
  check("no próximo acesso a planilha baixa sozinha, em partes", a.mundo.downloads.length === 3 && a.mundo.downloads.every(n => /^VivaSpy\/VivaSpy_banco-equipe-parte-\d_.*criativos\.xlsx$/.test(n)), JSON.stringify(a.mundo.downloads));
  check("as partes somam tudo que está no banco", a.mundo.downloads.map(n => Number(/_(\d+)-criativos/.exec(n)[1])).reduce((s, n) => s + n, 0) === 2500);
  check("registra o que foi baixado", a.store.viva_espaco.baixadoTotal === 2500 && a.store.viva_espaco.arquivos === 3 && !a.store.viva_espaco_progresso);
  await acesso(a); await acesso(a); await periodico(a);
  check("não repete a cada acesso", a.mundo.downloads.length === 3 && a.mundo.mensagens.length === 2);

  a.mundo.total = 148000;
  await acesso(a);
  check("pouca folga (148 mil) ainda não rearma", a.store.viva_espaco.baixadoEm > 0 && a.mundo.selo === "");
  a.mundo.total = 130000;
  await acesso(a);
  a.mundo.total = 150001;
  await acesso(a);
  check("limpou e estourou de novo: baixa e avisa de novo", a.mundo.downloads.length === 6 && a.mundo.mensagens.length === 3);

  a = montar();
  a.mundo.total = 160000;
  a.store.viva_export_config = { auto: false, formato: "csv" };
  await acesso(a);
  check("download automático desligado: não baixa, mas marca o ícone", a.mundo.downloads.length === 0 && a.mundo.selo === "150k");
  await a.run("espacoBaixarAgora()");
  check("botão baixa mesmo assim, no formato escolhido", a.mundo.downloads.length === 3 && a.mundo.downloads[0].endsWith(".csv"));

  a = montar();
  a.mundo.total = 160000;
  a.mundo.falhaPull = true;
  await acesso(a);
  check("falha no download fica registrada", /Sem conexão/.test(a.store.viva_espaco.erro) && !a.store.viva_espaco.baixadoEm, JSON.stringify(a.store.viva_espaco));
  a.mundo.falhaPull = false;
  await acesso(a);
  check("não insiste na mesma hora", a.mundo.downloads.length === 0);
  a.mundo.agora += 11 * 60 * 1000;
  await acesso(a);
  check("tenta de novo depois de 10 minutos", a.mundo.downloads.length === 3 && a.store.viva_espaco.erro === "");

  a = montar();
  a.store.viva_notify_config = discord;
  a.mundo.total = 155000;
  a.mundo.falhaAviso = true;
  await acesso(a);
  a.mundo.falhaAviso = false;
  a.mundo.agora += 11 * 60 * 1000;
  await periodico(a);
  check("aviso que falhou é reenviado depois", a.mundo.mensagens.length === 1);

  a = montar();
  a.mundo.selo = "!";
  a.mundo.total = 1000;
  await acesso(a);
  check("não apaga o selo de outro aviso da extensão", a.mundo.selo === "!");

  a = montar();
  a.mundo.total = 151000;
  await Promise.all([periodico(a), acesso(a), acesso(a)]);
  check("acessos simultâneos geram uma planilha só", a.mundo.downloads.length === 3, String(a.mundo.downloads.length));

  a = montar();
  a.mundo.total = 151000;
  await sincronizar(a);
  a.store.viva_acervo = Array.from({ length: 10000 }, (_, i) => ({ id: String(i + 100000000), dup: 1 }));
  check("com o banco novo, a planilha antiga dos 10 mil não dispara", (await a.run("aexpVerificar()")).status === "banco" && a.mundo.downloads.length === 0);
  await a.run("teamConfigChanged()");
  a.store.viva_team_code = "";
  await sincronizar(a);
  check("sem equipe volta a valer a regra dos 10 mil", !a.store.viva_vault_info && (await a.run("aexpVerificar()")).status === "baixado");

  console.log(fails ? `\n${fails} FALHA(S)` : "\nTUDO OK");
  process.exit(fails ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
