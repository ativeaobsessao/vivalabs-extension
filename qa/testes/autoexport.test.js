// Planilha automática (auto_export.js REAL) com chrome falso.
const fs = require("fs");
const vm = require("vm");
const DIR = "/home/claude/repo/vivalabs-extension/";
const read = f => fs.readFileSync(DIR + f, "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };

function env() {
  const store = {};
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const downloads = [];
  const msgs = [];
  let falharDownload = false;
  let clock = Date.now();
  const chrome = {
    storage: { local: {
      async get(keys) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = clone(store[k]); }); return out; },
      async set(o) { Object.entries(o).forEach(([k, v]) => { store[k] = clone(v); }); },
    }, onChanged: { addListener() {} } },
    runtime: {
      getManifest: () => ({ version: "1.8.0" }),
      getContexts: async () => [],
      async sendMessage(m) {
        msgs.push(m);
        if (m.action === "BLOB_URL") return { ok: true, url: "blob:chrome-extension://x/" + msgs.length };
        return { ok: true };
      },
    },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    downloads: { async download(o) { if (falharDownload) throw new Error("Download bloqueado"); downloads.push(o); return downloads.length; } },
  };
  const ctx = { console: { log() {}, info() {}, warn() {}, error() {} }, chrome, setTimeout: () => 0, clearTimeout() {}, Promise, Date, Math, JSON, Number, String, Array, Object, Map, Set, URLSearchParams, TextEncoder, Uint8Array, Uint32Array, Blob, Response, CompressionStream, atob, btoa };
  vm.createContext(ctx);
  vm.runInContext(["intelligent_parser.js", "ranking_engine.js", "export_data.js", "auto_export.js"].map(read).join("\n") + "\nthis.A={aexpVerificar,aexpBaixarAgora,aexpInit,mk:(i,e)=>Object.assign({id:String(400000000+i),pid:String(190000000+i%50),nome:'L'+(i%50),copy:'c'+i,dom:'o'+(i%9)+'.com',dup:3,dias:5,inicio:Date.now()-5*864e5,adv:9,fonte:'t'},e||{}),mesclarAcervo};", ctx);
  ctx.A.aexpInit({ now: () => clock });
  return { store, downloads, msgs, A: ctx.A, setFalha: v => { falharDownload = v; }, avancar: ms => { clock += ms; }, agora: () => clock };
}

(async () => {
  const E = env();
  const cheio = n => E.A.mesclarAcervo([], Array.from({ length: n }, (_, i) => E.A.mk(i)), E.agora(), 20000).acervo;
  E.store.viva_acervo = cheio(9999);
  let r = await E.A.aexpVerificar();
  check("abaixo de 10.000 não baixa", r.status === "abaixo" && E.downloads.length === 0, JSON.stringify(r));
  E.store.viva_acervo = cheio(10000);
  r = await E.A.aexpVerificar();
  check("ao bater 10.000 baixa 1 arquivo", r.status === "baixado" && E.downloads.length === 1, JSON.stringify(r));
  const d = E.downloads[0];
  check("vai para Downloads/VivaSpy com nome organizado", /^VivaSpy\/VivaSpy_acervo-completo_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}_10000-criativos\.xlsx$/.test(d.filename) && d.conflictAction === "uniquify" && d.saveAs === false, d.filename);
  const blobMsg = E.msgs.find(m => m.action === "BLOB_URL");
  const bytes = Buffer.from(blobMsg.base64, "base64");
  check("arquivo enviado ao offscreen é um XLSX válido (zip)", bytes[0] === 0x50 && bytes[1] === 0x4B && blobMsg.mime.includes("spreadsheetml"), String(bytes.length));
  fs.writeFileSync("/tmp/auto10k.xlsx", bytes);
  check("estado gravado", E.store.viva_export_state.lastCount === 10000 && E.store.viva_export_state.lastOrigem === "auto" && !E.store.viva_export_state.lastError);
  r = await E.A.aexpVerificar();
  check("não baixa de novo sem novidade", r.status === "ja-baixado" && E.downloads.length === 1, JSON.stringify(r));

  // 4.999 novos → não; 5.000 novos → baixa de novo
  E.avancar(3600e3);
  const base = E.store.viva_acervo.slice();
  const comNovos = n => base.map((c, i) => i < n ? { ...c, firstSeen: E.agora() - 1000 } : c);
  E.store.viva_acervo = comNovos(4999);
  r = await E.A.aexpVerificar();
  check("4.999 novos ainda não repete", r.status === "ja-baixado" && E.downloads.length === 1, JSON.stringify(r));
  E.store.viva_acervo = comNovos(5000);
  r = await E.A.aexpVerificar();
  check("5.000 novos baixa de novo", r.status === "baixado" && E.downloads.length === 2, JSON.stringify(r));

  // automático desligado
  const F = env();
  F.store.viva_acervo = F.A.mesclarAcervo([], Array.from({ length: 10000 }, (_, i) => F.A.mk(i)), F.agora(), 20000).acervo;
  F.store.viva_export_config = { auto: false, formato: "xlsx" };
  r = await F.A.aexpVerificar();
  check("automático desligado não baixa", r.status === "off" && F.downloads.length === 0);
  // CSV
  F.store.viva_export_config = { auto: true, formato: "csv" };
  r = await F.A.aexpVerificar();
  check("formato CSV respeitado", r.status === "baixado" && /\.csv$/.test(F.downloads[0].filename) && F.msgs.find(m => m.action === "BLOB_URL").mime.startsWith("text/csv"));

  // falha: registra erro, espera 10 min, tenta de novo
  const G = env();
  G.store.viva_acervo = G.A.mesclarAcervo([], Array.from({ length: 10000 }, (_, i) => G.A.mk(i)), G.agora(), 20000).acervo;
  G.setFalha(true);
  r = await G.A.aexpVerificar();
  check("falha de download vira erro registrado", r.status === "error" && /bloqueado/.test(G.store.viva_export_state.lastError), JSON.stringify(r));
  r = await G.A.aexpVerificar();
  check("não fica tentando em loop (espera 10 min)", r.status === "aguardando" && G.downloads.length === 0);
  G.setFalha(false); G.avancar(11 * 60e3);
  r = await G.A.aexpVerificar();
  check("depois de 10 min tenta de novo e conclui", r.status === "baixado" && G.downloads.length === 1 && !G.store.viva_export_state.lastError, JSON.stringify(r));

  // botão "Baixar agora" com acervo pequeno
  const H = env();
  H.store.viva_acervo = H.A.mesclarAcervo([], Array.from({ length: 30 }, (_, i) => H.A.mk(i)), H.agora()).acervo;
  r = await H.A.aexpBaixarAgora();
  check("Baixar agora funciona com 30 criativos", r.status === "ok" && r.linhas === 30 && H.downloads.length === 1 && /30-criativos/.test(H.downloads[0].filename), JSON.stringify(r));
  H.store.viva_acervo = [];
  r = await H.A.aexpBaixarAgora();
  check("acervo vazio avisa com clareza", r.status === "error" && /vazio/.test(r.error));

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DA PLANILHA AUTOMÁTICA PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("ERRO", e); process.exit(2); });
