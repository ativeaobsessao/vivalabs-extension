// Centro de Inteligência no banco: SUPABASE_ATUALIZACAO_150K.sql REAL (Postgres local) conferido contra as
// regras de intel_core.js — mesmo filtro, mesma ordem, mesmo selo, mesmo nicho e mesmos grupos.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const DIR = path.resolve(__dirname, "../..");
const read = f => fs.readFileSync(path.join(DIR, f), "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };

const DB = "viva_intel_test";
const TOKEN = "codigo-de-teste-123";
const PG = ["-h", "/tmp/pgt", "-p", "5544", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-At"];
const psql = (args, db = DB, input) => execFileSync("psql", [...PG, "-d", db, ...args], { encoding: "utf8", input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
const q = v => `'${String(v).replace(/'/g, "''")}'`;
const lit = v => (v === null ? "null" : typeof v === "number" ? String(v) : typeof v === "object" ? `${q(JSON.stringify(v))}::jsonb` : q(v));
// chama a função como o app chama (papel anon do Supabase)
function rpc(fn, ...args) {
  const out = psql([], DB, `set role anon;\nselect to_jsonb(public.${fn}(${[TOKEN, ...args].map(lit).join(", ")}));\n`).trim();
  return out ? JSON.parse(out) : null;
}
function erro(fn, ...args) {
  try { rpc(fn, ...args); return ""; } catch (e) { return String(e.stderr || e.message); }
}

const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Map, Set, RegExp };
vm.createContext(ctx);
vm.runInContext(read("ranking_engine.js") + "\n" + read("intel_core.js") +
  "\nthis.X={intelItem,intelFiltrosNormalizar,intelFiltrosEnxutos,intelPassa,intelOrdenar,intelGrupos,intelNicho,intelDominio,mesclarAcervo,acervoKey};", ctx);
const X = ctx.X;

const AGORA = Date.now();
const DIA = 86400000;
const TERMOS = ["blood sugar trick", "weight loss", "menopause relief", "side hustle", "wrinkle cream", "get your ex back", "keyword x", ""];
const COPIAS = ["Doctors hate this", "Truque da glicose para emagrecer", "Sem dieta, queime gordura", "100% natural_formula", "Make money from home", "Apelo comum sem nicho"];
const DOMINIOS = ["oferta-a.com", "https://www.Oferta-B.com/lp?x=1", "facebook.com", "l.facebook.com", "loja.shop", ""];
let semente = 7;
const sorte = n => { semente = (semente * 48271) % 2147483647; return semente % n; };
function gerar(i) {
  const pid = i % 11 === 0 ? "" : String(155000000 + sorte(25));
  const comData = i % 7 !== 0;
  const adv = sorte(60);
  return {
    id: String(800000000 + i), pid, sig: "", nome: pid ? `Loja ${Number(pid) % 100}` : `Sem pagina ${sorte(3)}`,
    copy: `${COPIAS[sorte(COPIAS.length)]} #${i}`, dest: "", dom: DOMINIOS[sorte(DOMINIOS.length)], thumb: "", video: sorte(2) === 0, url: "",
    dup: 1 + sorte(14), dias: comData ? null : (i % 14 === 0 ? null : sorte(40)),
    inicio: comData ? AGORA - sorte(45) * DIA - 3600000 : 0, adv,
    fontes: [TERMOS[sorte(TERMOS.length)], TERMOS[sorte(TERMOS.length)]].filter((t, j, a) => t && a.indexOf(t) === j),
    firstSeen: AGORA - (i % 3 === 0 ? 3600000 : 5 * DIA), lastSeen: AGORA - (i % 5) * DIA,
    advBase: i % 4 === 0 ? Math.max(1, adv - 20) : 0,
  };
}

// ── banco novo: setup antigo + dados antigos + atualização (como vai acontecer no Supabase) ──
psql(["-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`], "postgres");
psql([], DB, read("SUPABASE_SETUP.sql").split("__CODIGO_DA_EQUIPE__").join(TOKEN));
const registros = Array.from({ length: 400 }, (_, i) => gerar(i + 1));
const enviar = (lista, por) => rpc("viva_push", por, lista.map(rec => ({ key: X.acervoKey(rec), rec })));
enviar(registros.slice(0, 200), "Ana"); // antes da atualização
const velho = { ...gerar(9999), lastSeen: AGORA - 80 * DIA };
psql([], DB, `insert into viva_creatives (key, rec, found_by) values ('id:velho', ${lit(velho)}, 'Ana');`);
const antes = Number(psql(["-c", "select count(*) from viva_creatives"]).trim());
psql([], DB, read("SUPABASE_ATUALIZACAO_150K.sql"));
psql([], DB, read("SUPABASE_ATUALIZACAO_150K.sql"));
check("rodar a atualização (2x) não apaga nada", Number(psql(["-c", "select count(*) from viva_creatives"]).trim()) === antes);
check("o que já existia ganha ficha", rpc("viva_info").total === antes, JSON.stringify(rpc("viva_info")));
enviar(registros.slice(200), "Bia"); // depois da atualização
check("envio não apaga anúncio velho (faxina desligada)", psql(["-c", "select count(*) from viva_creatives where key='id:velho'"]).trim() === "1");
psql([], DB, "delete from viva_creatives where key='id:velho';");
check("ficha some junto com o criativo", rpc("viva_info").total === 400);

const meta = {};
const chaveDe = i => X.acervoKey(registros[i]);
registros.forEach((r, i) => { meta[chaveDe(i)] = { by: i < 200 ? "Ana" : "Bia", status: "nova" }; });
const descartar = [3, 50, 250].map(chaveDe);
check("marcar em lote", rpc("viva_marcar", descartar, "descartada", "Ana") === 3);
descartar.forEach(k => { meta[k].status = "descartada"; });
check("marcar em análise", rpc("viva_marcar", [chaveDe(10)], "analise", "Bia") === 1);
meta[chaveDe(10)].status = "analise";
const itens = registros.map(r => X.intelItem(r, meta[X.acervoKey(r)], "", AGORA));

// ── paridade filtro a filtro ──
const casos = [
  {}, { escala: "agora" }, { escala: "bruta" }, { escala: "monstro" }, { dias: "1-7" }, { dias: "8-14" }, { dias: "15-29" }, { dias: "30+" },
  { formato: "video" }, { formato: "imagem" }, { nicho: "Diabetes" }, { nicho: "Emagrecimento" }, { nicho: "Outro" }, { nicho: "Renda extra" },
  { busca: "GLICOSE" }, { busca: "100% natural_" }, { busca: "oferta-b.com" }, { status: "descartada" }, { status: "analise" }, { status: "todas" },
  { copiasMin: 8 }, { advMin: 30 }, { termo: "weight loss" }, { quem: "Bia" }, { novos24: true }, { subindo: true },
  { dom: "oferta-a.com" }, { pid: registros[1].pid }, { nomeExato: "sem pagina 1" },
  { escala: "bruta", formato: "video", dias: "15-29" }, { nicho: "Diabetes", copiasMin: 3, status: "todas" },
];
let divergencias = [];
for (const caso of casos) {
  const f = X.intelFiltrosNormalizar(caso);
  const esperado = X.intelOrdenar(itens.filter(i => X.intelPassa(i, f, AGORA)), "score");
  const veio = rpc("viva_buscar", X.intelFiltrosEnxutos(f), "score", 0, 200);
  const a = esperado.slice(0, 200).map(i => `${i.key}|${i.score}|${i.selo}|${i.nicho}|${i.dias}`).join(",");
  const b = veio.itens.map(i => `${i.key}|${i.score}|${i.selo}|${i.nicho}|${i.dias}`).join(",");
  if (veio.total !== esperado.length || a !== b) divergencias.push(`${JSON.stringify(caso)}: js=${esperado.length} sql=${veio.total}`);
}
check(`${casos.length} combinações de filtro iguais no navegador e no banco`, divergencias.length === 0, divergencias.slice(0, 4).join(" ; "));
check("os filtros exercitam resultados de verdade", casos.filter(c => rpc("viva_chaves", X.intelFiltrosEnxutos(X.intelFiltrosNormalizar(c))).length > 0).length >= casos.length - 2);

for (const ordem of ["dup", "dias", "novos", "menor"]) {
  const esperado = X.intelOrdenar(itens.filter(i => i.status !== "descartada"), ordem).slice(0, 100).map(i => i.key);
  const veio = rpc("viva_buscar", {}, ordem, 0, 100).itens.map(i => i.key);
  check(`ordem "${ordem}" igual`, JSON.stringify(esperado) === JSON.stringify(veio));
}
const p0 = rpc("viva_buscar", {}, "score", 0, 48);
const p1 = rpc("viva_buscar", {}, "score", 1, 48);
check("páginas não se repetem e continuam em ordem", p0.itens.length === 48 && p1.itens.every(i => !p0.itens.some(j => j.key === i.key)) && p0.itens[47].score >= p1.itens[0].score);

for (const tipo of ["ofertas", "paginas"]) {
  const esperado = X.intelGrupos(itens.filter(i => i.status !== "descartada"), tipo, AGORA);
  const veio = rpc("viva_grupos", tipo, {}, 0, 200);
  const resumo = g => `${g.grupo}|${g.criativos}|${g.emEscala}|${g.maxDup}|${g.mediaDias}|${g.adv}|${g.paginas}|${g.score}`;
  check(`aba ${tipo}: mesmos grupos, números e ordem`, veio.total === esperado.length && JSON.stringify(veio.itens.map(resumo)) === JSON.stringify(esperado.slice(0, 200).map(resumo)),
    `${veio.total}/${esperado.length} ${veio.itens.slice(0, 2).map(resumo)} x ${esperado.slice(0, 2).map(resumo)}`);
}

// ── nicho manual ──
check("corrigir nicho", rpc("viva_definir_nicho", chaveDe(0), "Menopausa") === true && rpc("viva_buscar", { nicho: "Menopausa" }, "score", 0, 200).itens.some(i => i.key === chaveDe(0)));
enviar([registros[0]], "Bia");
check("novo envio não desfaz a correção", rpc("viva_buscar", { nicho: "Menopausa" }, "score", 0, 200).itens.some(i => i.key === chaveDe(0)));
check("nicho inválido é recusado", /nicho_invalido/.test(erro("viva_definir_nicho", chaveDe(0), "xyz")));

// ── apagar libera espaço e não volta ──
check("apagar descartados", JSON.stringify(rpc("viva_apagar_descartados", 2000)) === JSON.stringify({ restam: 0, apagados: 3 }), JSON.stringify(rpc("viva_info")));
enviar([registros[3]], "Ana");
check("apagado não volta quando alguém reenvia", rpc("viva_info").total === 397);
check("apagar escolhidos", rpc("viva_apagar", [chaveDe(5), chaveDe(6)]) === 2 && rpc("viva_info").total === 395);
const alvo = registros.find((r, i) => r.pid && i > 20);
const doAnunciante = rpc("viva_chaves", { pid: alvo.pid, status: "todas" }).length;
check("bloquear anunciante apaga todos os dele", rpc("viva_bloquear", `p:${alvo.pid}`) === doAnunciante && doAnunciante > 1);
enviar([{ ...gerar(5001), pid: alvo.pid }], "Ana");
check("anunciante bloqueado não entra mais", rpc("viva_chaves", { pid: alvo.pid, status: "todas" }).length === 0);
const antesDom = rpc("viva_info").total;
const nDom = rpc("viva_bloquear", "d:oferta-a.com");
enviar([{ ...gerar(5002), pid: "177000001", dom: "https://www.oferta-a.com/x" }], "Ana");
check("bloquear oferta (domínio) vale para envios novos", nDom > 0 && rpc("viva_info").total === antesDom - nDom);
check("liberar bloqueados", rpc("viva_desbloquear") > 0 && rpc("viva_info").bloqueados === 0);
enviar([registros[3]], "Ana");
check("depois de liberado pode voltar", rpc("viva_chaves", { status: "todas" }, 20000).includes(chaveDe(3)));
check("alvo de bloqueio inválido é recusado", /alvo_invalido/.test(erro("viva_bloquear", "x:1")) && /alvo_invalido/.test(erro("viva_bloquear", "p:")));

// ── robustez e segurança ──
enviar([{ id: "900000009", dup: "abc", adv: "1e99", inicio: "ontem", dias: "x", fontes: "não é lista" }], "Ana");
check("registro estranho não derruba o envio", rpc("viva_chaves", { status: "todas" }, 20000).includes("id:900000009"));
const funcoes = [["viva_info"], ["viva_buscar"], ["viva_chaves"], ["viva_grupos", "ofertas"], ["viva_opcoes"], ["viva_apagar", []], ["viva_apagar_descartados"], ["viva_bloquear", "p:1"], ["viva_desbloquear"]];
const semCodigo = funcoes.filter(([fn, ...a]) => {
  try { psql([], DB, `set role anon; select public.${fn}(${["codigo-errado-000", ...a].map(lit).join(", ")});`); return true; } catch (e) { return !/codigo_invalido/.test(String(e.stderr)); }
});
check("todas as funções exigem o código da equipe", semCodigo.length === 0, JSON.stringify(semCodigo));
const fechado = ["select * from viva_indice", "select * from viva_removidos", "select * from viva_creatives", "select public._viva_filtrar('{}'::jsonb, 0)", "select public._viva_exigir('x')"]
  .filter(sql => { try { psql([], DB, `set role anon; ${sql};`); return true; } catch (e) { return !/permission denied/.test(String(e.stderr)); } });
check("tabelas e funções internas fechadas para quem está de fora", fechado.length === 0, JSON.stringify(fechado));

psql(["-c", `drop database ${DB}`], "postgres");
console.log(fails ? `\n${fails} FALHA(S)` : "\nTUDO OK");
process.exit(fails ? 1 : 0);
