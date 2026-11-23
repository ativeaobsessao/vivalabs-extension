// Aviso Discord/Telegram: notify.js REAL com fetch falso.
const fs = require("fs");
const vm = require("vm");
const DIR = "/home/claude/repo/vivalabs-extension/";
const read = f => fs.readFileSync(DIR + f, "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };

function env() {
  const store = {};
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const calls = [];
  let resposta = { ok: true, status: 200 };
  const chrome = { storage: { local: {
    async get(keys) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = clone(store[k]); }); return out; },
    async set(o) { Object.entries(o).forEach(([k, v]) => { store[k] = clone(v); }); },
  } } };
  const fakeFetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: resposta.ok, status: resposta.status, text: async () => resposta.texto || "" }; };
  const ctx = { console: { log() {}, info() {}, warn() {}, error() {} }, chrome, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, Promise, Date, Math, JSON, URLSearchParams, Map, Set, Array, Object, String, Number };
  vm.createContext(ctx);
  vm.runInContext(read("intelligent_parser.js") + "\n" + read("ranking_engine.js") + "\n" + read("notify.js"), ctx);
  return { store, calls, ctx, run: c => vm.runInContext(c, ctx), setResp: r => { resposta = r; } };
}

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";
const TOKEN = "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK12";
const agora = Date.now();
const cri = (i, extra = {}) => ({ id: String(600000000 + i), pid: String(81000 + i), nome: "Loja " + i, copy: "texto " + i, dest: "https://oferta" + i + ".com", dom: "oferta" + i + ".com", dup: 8, dias: 5, inicio: agora - 5 * 864e5, adv: 40, firstSeen: agora - 1000, lastSeen: agora - 500, stage: "bruta", ...extra });

(async () => {
  let E = env();
  // validação
  check("config desligada não envia", (await E.run(`notifRadarRodada({ inicio: 0 })`)).status === "off");
  check("webhook ruim é recusado", E.run(`notifValidar(notifNormalizarConfig({ tipo: "discord", webhook: "https://evil.com/x" }))`) !== "");
  check("webhook discord válido", E.run(`notifValidar(notifNormalizarConfig({ tipo: "discord", webhook: "${WEBHOOK}" }))`) === "");
  check("telegram token/chat válidos", E.run(`notifValidar(notifNormalizarConfig({ tipo: "telegram", botToken: "${TOKEN}", chatId: "-1001234567890" }))`) === "");
  check("telegram chat @canal válido", E.run(`notifValidar(notifNormalizarConfig({ tipo: "telegram", botToken: "${TOKEN}", chatId: "@meucanal" }))`) === "");
  check("telegram token ruim", E.run(`notifValidar(notifNormalizarConfig({ tipo: "telegram", botToken: "abc", chatId: "-1001234567890" }))`) !== "");

  // Discord: rodada com 12 em escala + 1 fraco + 1 antigo (lastSeen < inicio)
  E.store.viva_notify_config = { tipo: "discord", webhook: WEBHOOK };
  const lista = Array.from({ length: 12 }, (_, i) => cri(i, { dup: 8 + i, nome: i === 0 ? "Loja @everyone [clique](http://evil.com) `x`" : "Loja " + i }));
  lista.push(cri(50, { dup: 1, dias: 1, inicio: agora - 864e5, adv: 1 }));          // não está em escala
  lista.push(cri(51, { lastSeen: agora - 10 * 3600e3 }));                              // visto antes da rodada
  E.store.viva_acervo = lista;
  const inicio = agora - 3600e3;
  let r = await E.run(`notifRadarRodada({ inicio: ${inicio}, resumo: { criativos: 14 } })`);
  check("enviou 1 mensagem", r.status === "enviado" && E.calls.length === 1, JSON.stringify(r));
  check("12 candidatos, 8 listados", r.total === 12 && r.itens === 8, JSON.stringify(r));
  const msg = E.calls[0];
  check("vai para o webhook certo", msg.url === WEBHOOK);
  check("discord sem menções (allowed_mentions.parse vazio)", Array.isArray(msg.body.allowed_mentions.parse) && msg.body.allowed_mentions.parse.length === 0);
  check("texto sem @ e sem markdown perigoso", !/@/.test(msg.body.content) && !/\]\(/.test(msg.body.content) && !msg.body.content.includes("`"), msg.body.content.slice(0, 200));
  check("mensagem cabe no limite do Discord", msg.body.content.length <= 2000);
  check("diz que há mais no Centro", /mais 4 no Centro/.test(msg.body.content));
  check("links do Discord com <> (sem embed)", /<https:\/\/www\.facebook\.com\/ads\/library\/\?id=\d+>/.test(msg.body.content));
  check("ranqueado por score (maior primeiro)", msg.body.content.indexOf("Loja 11") < msg.body.content.indexOf("Loja 5"));
  const marcados = E.store.viva_notified || [];
  check("os 12 candidatos foram marcados como avisados", marcados.length === 12, String(marcados.length));

  // 2ª rodada igual: nada novo → não envia
  r = await E.run(`notifRadarRodada({ inicio: ${inicio} })`);
  check("sem novidade não envia (dedupe)", r.status === "nada" && E.calls.length === 1, JSON.stringify(r));
  // aparece 1 novo → envia só ele
  E.store.viva_acervo = [...lista, cri(90, { dup: 20 })];
  r = await E.run(`notifRadarRodada({ inicio: ${inicio} })`);
  check("só o novo é avisado", r.status === "enviado" && r.total === 1 && E.calls.length === 2, JSON.stringify(r));

  // falha de envio: não marca como avisado e não vaza webhook
  E = env();
  E.store.viva_notify_config = { tipo: "discord", webhook: WEBHOOK };
  E.store.viva_acervo = [cri(1)];
  E.setResp({ ok: false, status: 404, texto: "Unknown Webhook" });
  r = await E.run(`notifRadarRodada({ inicio: ${inicio} })`);
  check("falha do Discord → status error", r.status === "error" && /404/.test(r.error), JSON.stringify(r));
  check("falha não marca como avisado (tenta de novo depois)", !E.store.viva_notified);
  E.setResp({ ok: true, status: 200 });
  r = await E.run(`notifRadarRodada({ inicio: ${inicio} })`);
  check("na rodada seguinte envia", r.status === "enviado");

  // Telegram
  E = env();
  E.store.viva_notify_config = { tipo: "telegram", botToken: TOKEN, chatId: "-1001234567890" };
  E.store.viva_acervo = [cri(1), cri(2)];
  r = await E.run(`notifRadarRodada({ inicio: ${inicio} })`);
  check("telegram: URL do bot + sendMessage", E.calls[0].url === `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  check("telegram: chat_id e sem preview", E.calls[0].body.chat_id === "-1001234567890" && E.calls[0].body.disable_web_page_preview === true);
  check("telegram: links sem <>", /📚 https:\/\/www\.facebook\.com/.test(E.calls[0].body.text) && !/<https/.test(E.calls[0].body.text));
  const t = await E.run(`notifTestar()`);
  check("botão Testar envia", t.status === "ok" && E.calls.length === 2);
  // erro de rede nunca vaza token
  E.ctx.fetch = async () => { throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`); };
  const t2 = await E.run(`notifTestar()`);
  check("erro não vaza o token", t2.status === "error" && !t2.error.includes(TOKEN), JSON.stringify(t2));

  // cap do histórico de avisados
  E = env();
  E.store.viva_notify_config = { tipo: "discord", webhook: WEBHOOK };
  E.store.viva_notified = Array.from({ length: 3500 }, (_, i) => "id:" + (700000000 + i));
  E.store.viva_acervo = [cri(1)];
  await E.run(`notifRadarRodada({ inicio: ${inicio} })`);
  check("histórico de avisados limitado a 3000", E.store.viva_notified.length === 3000, String(E.store.viva_notified.length));

  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE AVISO PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("ERRO NO TESTE", e); process.exit(2); });
