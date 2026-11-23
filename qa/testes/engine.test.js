const fs = require("fs");
const vm = require("vm");
const dir = "/home/claude/repo/vivalabs-extension/";
const ctx = { console, URLSearchParams, Date, Math, Number, String, Array, Map, Set, Object, JSON, Promise };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + "intelligent_parser.js", "utf8") + "\n" + fs.readFileSync(dir + "ranking_engine.js", "utf8") +
  "\nthis.api={combinarBuscaLinhas,parseBuscaInput,buildAdLibraryUrl,gerarFilaInteligente,scoreCriativo,mesclarAcervo,agruparPaginas,diasNoAr,sanitizarCriativo,acervoKey,agruparOfertas,mesclarRemotos,VIVA_ACERVO_MAX:()=>VIVA_ACERVO_MAX};", ctx);
const a = ctx.api;
let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); } else console.log("ok  ", name); };

// parser
eq("normal 1 linha", a.parseBuscaInput("emagrecimento").modo, "normal");
eq("turbo 2 linhas", a.parseBuscaInput("a b\nc d").modo, "turbo");
eq("frase exata", a.parseBuscaInput('"keto truque"').exata, true);
eq("parcial nao exata", a.parseBuscaInput('keto "truque"').exata, false);
const u = new URL(a.buildAdLibraryUrl("keto truque", { exata: true }));
eq("url exata type", u.searchParams.get("search_type"), "keyword_exact_phrase");
eq("url exata leva o termo ENTRE ASPAS (como a própria Meta)", u.searchParams.get("q"), '"keto truque"');
const uN = new URL(a.buildAdLibraryUrl("keto truque"));
eq("url normal sem aspas", [uN.searchParams.get("q"), uN.searchParams.get("search_type")], ["keto truque", "keyword_unordered"]);
const uAsp = new URL(a.buildAdLibraryUrl('"keto"', { exata: true }));
eq("não duplica aspas", uAsp.searchParams.get("q"), '"keto"');
const uL = new URL(a.buildAdLibraryUrl("x", { filtros: { country: "US", language: "en" } }));
eq("idioma na URL", uL.searchParams.get("content_languages[0]"), "en");
eq("sem idioma não manda o parâmetro", uN.searchParams.has("content_languages[0]"), false);
const u2 = new URL(a.buildAdLibraryUrl("x", { base: "https://web.facebook.com/ads/library/", filtros: { country: "US" } }));
eq("url host", u2.host, "web.facebook.com");
eq("url country", u2.searchParams.get("country"), "US");
const fila = a.gerarFilaInteligente(['"keto truque"', "ansiedade controle"]);
eq("fila tamanho", fila.length, 2);
eq("fila exata", [fila[0].exata, fila[1].exata], [true, false]);
eq("fila q sem aspas", fila[0].q, "keto truque");
eq("fila: URL da exata tem aspas e padrão US/en", [new URL(fila[0].url).searchParams.get("q"), new URL(fila[0].url).searchParams.get("country"), new URL(fila[0].url).searchParams.get("content_languages[0]")], ['"keto truque"', "US", "en"]);
const filaBr = a.gerarFilaInteligente(["a b", "c d"], { country: "br", language: "pt" });
eq("fila respeita país/idioma escolhidos", [new URL(filaBr[0].url).searchParams.get("country"), new URL(filaBr[0].url).searchParams.get("content_languages[0]")], ["BR", "pt"]);
const filaTodos = a.gerarFilaInteligente(["a b", "c d"], { country: "ALL", language: "all" });
eq("todos os países/idiomas", [new URL(filaTodos[0].url).searchParams.get("country"), new URL(filaTodos[0].url).searchParams.has("content_languages[0]")], ["ALL", false]);

// busca combinada
const cb = a.combinarBuscaLinhas('nerve pain\n"neuropathy", feet\nPain burning\n\nx');
eq("combinada: junta todas as linhas, sem aspas/vírgula, sem repetir palavra", cb.q, "nerve pain neuropathy feet burning");
eq("combinada: contagem de termos/palavras", [cb.termos, cb.palavras, cb.cortou], [3, 5, false]);
const longo = a.combinarBuscaLinhas(Array.from({ length: 60 }, (_, i) => "palavra" + i + "xxxxx").join("\n"));
eq("combinada: respeita limite de ~250 caracteres", [longo.q.length <= 250, longo.cortou], [true, true]);
eq("combinada: linhas vazias/curtas ignoradas", a.combinarBuscaLinhas("a\n \n").q, "");

// score
const sT1 = a.scoreCriativo({ dup: 5, dias: 20, adv: 10 });
const sT4 = a.scoreCriativo({ dup: 5, dias: 20, adv: 10, termos: 4 });
eq("termos extras sobem o score (+8 cada)", sT4.score - sT1.score, 24);
eq("bônus de termos tem teto (6 extras)", a.scoreCriativo({ dup: 5, dias: 20, adv: 10, termos: 30 }).score - sT1.score, 48);
const s1 = a.scoreCriativo({ dup: 12, dias: 5, adv: 20 });
eq("em escala jovem+dup", s1.emEscala, true);
const s2 = a.scoreCriativo({ dup: 1, dias: 60, adv: 3 });
eq("evergreen nao em escala", s2.emEscala, false);
eq("escala jovem > evergreen", s1.score > s2.score, true);
eq("dias null nao dispara velocidade", a.scoreCriativo({ dup: 20, dias: null, adv: 0 }).emEscala, false);

// merge
const now = Date.UTC(2026, 10, 22);
const c1 = { id: "123456789012345", pid: "999888777", nome: "Loja A", copy: "texto", dup: 5, dias: 3, inicio: now - 3 * 864e5, adv: 10, stage: "bruta", fonte: "keto", thumb: "https://x/y.jpg", url: "https://www.facebook.com/ads/library/?id=1" };
let r = a.mesclarAcervo([], [c1], now);
eq("add 1", [r.adicionados, r.acervo.length], [1, 1]);
eq("emEscala via merge", r.acervo[0].emEscala, true);
r = a.mesclarAcervo(r.acervo, [{ ...c1, dup: 9, fonte: "dieta" }, { id: "", sig: "abc|def", nome: "B", dup: 3, dias: 20, fonte: "keto" }], now + 1000);
eq("upsert", [r.adicionados, r.atualizados, r.acervo.length], [1, 1, 2]);
const m = r.acervo.find(x => x.id === c1.id);
eq("dup max", m.dup, 9);
eq("fontes acumulam", m.fontes, ["keto", "dieta"]);
eq("firstSeen preservado", m.firstSeen, now);
eq("sanitiza lixo", a.mesclarAcervo([], [null, {}, { id: "abc" }], now).acervo.length, 0);
eq("url fora do facebook descartada", a.sanitizarCriativo({ id: "123456789012345", url: "https://evil.com/x" }).url, "");
eq("TTL remove antigos", a.mesclarAcervo(r.acervo, [], now + 31 * 864e5).acervo.length, 0);
const many = Array.from({ length: 30 }, (_, i) => ({ id: String(100000000000 + i), dup: i + 1, dias: 10, adv: 1, fonte: "t" }));
const capped = a.mesclarAcervo([], many, now, 10);
eq("cap mantem top score", [capped.acervo.length, capped.acervo[0].dup], [10, 30]);
// paginas
const pgs = a.agruparPaginas(r.acervo, now + 1000);
eq("agrupa paginas", pgs.length, 2);
eq("pagina top é a com em escala", pgs[0].nome, "Loja A");
// ---- teto do acervo (10k) e aba Ofertas
eq("teto do acervo = 10000", a.VIVA_ACERVO_MAX(), 10000);
{
  const agora = Date.now();
  const mk = (i, extra = {}) => ({ id: String(500000000 + i), pid: String(70000 + (i % 50)), nome: "P" + (i % 50), copy: "c" + i, dest: "https://o" + (i % 5) + ".com/x", dom: "o" + (i % 5) + ".com", dup: 3, dias: 10, inicio: agora - 10 * 864e5, adv: 5, stage: "bruta", fonte: "t", ...extra });
  const big = a.mesclarAcervo([], Array.from({ length: 5000 }, (_, i) => mk(i)), agora);
  eq("5000 criativos cabem sem cortar", big.acervo.length, 5000);
  const big2 = a.mesclarAcervo(big.acervo, Array.from({ length: 6000 }, (_, i) => mk(5000 + i)), agora);
  eq("acima de 10000 corta no teto", big2.acervo.length, 10000);

  const lista = [
    mk(1, { dom: "www.oferta-a.com", pid: "1", nome: "Pag1", dup: 9 }),
    mk(2, { dom: "oferta-a.com", pid: "2", nome: "Pag2", dup: 2 }),
    mk(3, { dom: "oferta-a.com", pid: "2", nome: "Pag2", dup: 4 }),
    mk(4, { dom: "oferta-b.com", pid: "3", nome: "Pag3", dup: 1, dias: 1, inicio: agora - 864e5, adv: 1 }),
    mk(5, { dom: "facebook.com", pid: "4", nome: "Pag4" }),
    mk(6, { dom: "l.facebook.com", pid: "4", nome: "Pag4" }),
    mk(7, { dom: "linktr.ee", pid: "4", nome: "Pag4" }),
    mk(8, { dom: "", dest: "", pid: "5", nome: "Pag5" }),
    mk(9, { dom: "", dest: "https://www.oferta-b.com/lp?x=1", pid: "6", nome: "Pag6" }),
  ];
  const ac = a.mesclarAcervo([], lista, agora).acervo;
  const of = a.agruparOfertas(ac, agora);
  eq("ofertas ignora plataformas e vazios", of.map(o => o.dominio).sort(), ["oferta-a.com", "oferta-b.com"]);
  const A = of.find(o => o.dominio === "oferta-a.com");
  const B = of.find(o => o.dominio === "oferta-b.com");
  eq("oferta-a: www unificado, 3 criativos, 2 páginas, maior dup 9", [A.criativos, A.paginas, A.maxDup], [3, 2, 9]);
  eq("oferta-b: domínio vindo do dest, 2 páginas", [B.criativos, B.paginas], [2, 2]);
  eq("oferta ordenada por score", of[0].score >= of[1].score, true);
  eq("novos24 conta firstSeen recente", A.novos24, 3);
  eq("campos de exibição", [typeof A.topCopy, Array.isArray(A.nomesPaginas), A.nomesPaginas.length], ["string", true, 2]);
}
console.log(fail ? `\n${fail} FALHAS` : "\nTODOS OS TESTES PASSARAM");
process.exit(fail ? 1 : 0);
