// Posts virais: reconhecimento do link e fila de envio (viral_url.js e viral_outbox.js REAIS).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const DIR = path.resolve(__dirname, "../..");
const read = f => fs.readFileSync(path.join(DIR, f), "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function makeWorld({ latency = 0, respond } = {}) {
  const store = {}, calls = [], badges = [];
  const world = { store, calls, badges, respond: respond || (() => ({ status: 200, body: { id: 1, criado: true } })) };
  const bg = {
    chrome: {
      storage: { local: {
        async get(k) { return k in store ? { [k]: clone(store[k]) } : {}; },
        async set(o) { for (const [k, v] of Object.entries(o)) store[k] = clone(v); },
      } },
      runtime: { onMessage: { addListener() {} } },
      alarms: { create() {}, async clear() {}, onAlarm: { addListener() {} } },
      action: { async setBadgeText(o) { badges.push(o.text); }, async setBadgeBackgroundColor() {} },
    },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, AbortController, URL, JSON, Date, Math,
    fetch: async (url, opt) => {
      const call = { url, path: new URL(url).pathname, body: JSON.parse(opt.body) };
      calls.push(call);
      await sleep(latency);
      const r = world.respond(call);
      if (r === "offline") throw new TypeError("Failed to fetch");
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    },
  };
  vm.createContext(bg);
  vm.runInContext(read("viral_url.js"), bg);
  vm.runInContext(read("viral_outbox.js"), bg);
  world.parse = url => clone(bg.viralParseUrl(url));
  world.feed = url => bg.viralIsFeed(url);
  world.save = url => bg.viralEnqueue({ url });
  world.undo = id => bg.viralUndo(id);
  world.process = () => bg.viralProcess();
  world.job = id => (store.viva_viral_jobs || []).find(j => j.id === id);
  return world;
}

const VIDEO = "https://www.tiktok.com/@ana/video/7000000000000000001?x=1";

(async () => {
  let w = makeWorld();
  check("tiktok: padroniza e pega o perfil", w.parse(VIDEO).url === "https://www.tiktok.com/@ana/video/7000000000000000001" && w.parse(VIDEO).autor === "ana");
  check("instagram: reel e post viram o mesmo link", w.parse("https://www.instagram.com/reels/Abc_1/").url === "https://www.instagram.com/p/Abc_1/");
  check("youtube: só Shorts salva sozinho", w.parse("https://www.youtube.com/shorts/abcDEF12345") && !w.parse("https://www.youtube.com/watch?v=abcDEF12345"));
  check("não confunde outros sites", !w.parse("https://tiktok.com.evil.com/@a/video/1") && !w.parse("chrome://extensions") && !w.parse("https://www.instagram.com/reels/audio/1/"));
  check("feeds reconhecidos", w.feed("https://www.tiktok.com/pt-BR/foryou") && w.feed("https://www.instagram.com/") && !w.feed("https://www.tiktok.com/@ana") && !w.feed("https://www.instagram.com/direct/inbox/"));

  w = makeWorld({ latency: 200 });
  const t0 = Date.now();
  let r = await w.save(VIDEO);
  check("clique responde na hora", Date.now() - t0 < 150);
  await w.process();
  check("salvou, com desfazer", w.job(r.id).status === "salvo" && w.job(r.id).podeDesfazer === true);
  check("sem endereço configurado usa o Nutra Monitor", w.calls[0].url === "https://nutra-monitor.onrender.com/api/virais");

  w = makeWorld();
  w.store.viva_monitor_api_url = "https://viva-labs-monitor.onrender.com/";
  r = await w.save(VIDEO); await w.process();
  check("endereço antigo desativado é ignorado", w.calls[0].url.startsWith("https://nutra-monitor.onrender.com/"));

  w = makeWorld({ respond: () => ({ status: 200, body: { id: 9, criado: false } }) });
  r = await w.save(VIDEO); await w.process();
  check("post de outra pessoa: sem desfazer", w.job(r.id).podeDesfazer === false);
  await w.undo(r.id); await w.process();
  check("desfazer não apaga post alheio", !w.calls.some(c => c.path === "/api/virais/remover"));

  let criado = true;
  w = makeWorld({ respond: () => ({ status: 200, body: { id: 5, criado } }) });
  await w.save(VIDEO); await w.process();
  criado = false;
  r = await w.save(VIDEO); await w.process();
  check("meu post, segundo clique ainda permite desfazer", w.job(r.id).podeDesfazer === true);
  await w.undo(r.id); await w.process();
  const apagou = w.calls.find(c => c.path === "/api/virais/remover");
  check("desfazer apaga no servidor", apagou && apagou.body.id === 5 && w.job(r.id).status === "desfeito");

  w = makeWorld({ latency: 150 });
  r = await w.save(VIDEO); await sleep(40);
  await w.undo(r.id); await w.process();
  check("desfazer durante o envio apaga depois", w.job(r.id).status === "desfeito" && w.calls.map(c => c.path).join() === "/api/virais,/api/virais/remover", w.job(r.id).status);

  let online = false;
  w = makeWorld({ respond: () => (online ? { status: 200, body: { id: 2, criado: true } } : "offline") });
  r = await w.save(VIDEO); await w.process();
  check("sem rede fica na fila", w.job(r.id).status === "pendente" && Boolean(w.job(r.id).erro));
  online = true; await w.process();
  check("rede voltou: salva sozinho", w.job(r.id).status === "salvo");

  w = makeWorld({ respond: () => ({ status: 404, body: null }) });
  r = await w.save(VIDEO); await w.process();
  check("servidor sem a área nova: avisa e marca o ícone", w.job(r.id).status === "falhou" && /404/.test(w.job(r.id).erro) && w.badges.includes("!"));

  console.log(fails ? `${fails} FALHA(S)` : "TUDO OK");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERRO", e.stack); process.exit(2); });
