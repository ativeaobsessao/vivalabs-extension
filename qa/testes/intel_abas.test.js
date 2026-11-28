// Abrir o Centro em aba própria e voltar à Biblioteca (intel_abas.js REAL).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const code = fs.readFileSync(path.resolve(__dirname, "../../intel_abas.js"), "utf8");
let fails = 0;
const check = (name, cond) => { if (!cond) { fails++; console.log("FAIL", name); } else console.log("ok  ", name); };

const BIB = "https://www.facebook.com/ads/library/?q=keto";
const CENTRO = "chrome-extension://abc/intel.html";

function montar(abas) {
  const store = {};
  let proximo = 100;
  const lista = abas.map(a => ({ windowId: 1, index: 0, ...a }));
  const feitas = { criadas: [], focadas: [], navegadas: [] };
  const chrome = {
    runtime: { getURL: f => `chrome-extension://abc/${f}` },
    storage: { local: { async get(k) { return k in store ? { [k]: store[k] } : {}; }, async set(o) { Object.assign(store, o); } } },
    windows: { async update() {} },
    tabs: {
      async get(id) { const t = lista.find(a => a.id === id); if (!t) throw new Error("No tab"); return t; },
      async query({ url }) { return lista.filter(a => a.url.startsWith(url.replace(/\*$/, ""))); },
      async create(o) { feitas.criadas.push(o); const t = { id: proximo++, windowId: 1, index: 0, ...o }; lista.push(t); return t; },
      async update(id, o) { const t = lista.find(a => a.id === id); if (o.url) { t.url = o.url; feitas.navegadas.push({ id, url: o.url }); } if (o.active) feitas.focadas.push(id); },
    },
  };
  const ctx = vm.createContext({ chrome });
  vm.runInContext(code, ctx);
  return { abrir: ctx.abrirCentro, voltar: ctx.voltarParaBiblioteca, lista, feitas };
}

(async () => {
  const origem = { id: 1, url: BIB, windowId: 7, index: 2 };
  const t = montar([origem, { id: 2, url: "https://www.facebook.com/ads/library/?q=x&viva_miner=1" }]);
  await t.abrir({ tab: origem });
  check("abre o Centro em aba nova, ao lado da Biblioteca", t.feitas.criadas[0].url === CENTRO && t.feitas.criadas[0].index === 3 && t.feitas.criadas[0].windowId === 7);
  await t.abrir({});
  check("segundo clique reaproveita a aba do Centro", t.feitas.criadas.length === 1 && t.feitas.focadas.length === 1);
  await t.voltar({ tab: { id: 100 } });
  check("voltar foca a aba de origem", t.feitas.focadas.at(-1) === 1);

  const semOrigem = montar([{ id: 2, url: "https://www.facebook.com/ads/library/?q=x&viva_miner=1" }, { id: 3, url: CENTRO }]);
  await semOrigem.voltar({ tab: { id: 3 } });
  check("sem Biblioteca aberta, volta na própria aba e ignora janela do minerador", semOrigem.feitas.navegadas[0].id === 3 && /ads\/library\/\?active_status/.test(semOrigem.feitas.navegadas[0].url));

  console.log(fails ? `${fails} FALHA(S)` : "TUDO OK");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
