// Exportação: export_data.js REAL; o XLSX gerado é aberto com openpyxl (leitor independente) no passo seguinte.
const fs = require("fs");
const vm = require("vm");
const DIR = "/home/claude/repo/vivalabs-extension/";
const read = f => fs.readFileSync(DIR + f, "utf8");
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name); };
const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Map, Set, URLSearchParams, Promise, TextEncoder, Uint8Array, Uint32Array, Blob, Response, CompressionStream, Int32Array };
vm.createContext(ctx);
vm.runInContext(read("intelligent_parser.js") + "\n" + read("ranking_engine.js") + "\n" + read("export_data.js") + "\nthis.X={exportMontarLinhas,exportCsv,exportXlsx,exportGerar,exportNomeArquivo,EXPORT_COLUNAS_CRIATIVOS,mesclarAcervo};", ctx);
const X = ctx.X;
const agora = Date.now();
const mk = (i, extra = {}) => ({ id: String(800000000 + i), pid: String(155000000 + (i % 40)), nome: "Loja " + (i % 40), copy: "Texto do anúncio " + i, dest: "https://oferta" + (i % 7) + ".com/lp?x=1", dom: "oferta" + (i % 7) + ".com", thumb: "https://scontent.xx.fbcdn.net/a" + i + ".jpg", video: i % 2 === 0, dup: 1 + (i % 12), dias: i % 30, inicio: agora - (i % 30) * 864e5, adv: 5 + (i % 40), stage: i % 3 === 0 ? "bruta" : "", fonte: i % 2 ? "nerve pain" : "joint support", ...extra });

(async () => {
  const lista = Array.from({ length: 50 }, (_, i) => mk(i));
  lista[0] = mk(0, { nome: "=HYPERLINK(\"http://evil\")", copy: "+cmd|' /C calc'!A0 \"aspas\" com; ponto e vírgula\nquebra", fonte: "a" });
  lista[1] = mk(1, { copy: "emoji 🚀 acentuação ção <b>&amp;</b> \u0007controle" });
  const ac = X.mesclarAcervo([], lista, agora).acervo;
  const meta = {}; meta["id:800000003"] = { by: "Ana", status: "analise" };
  const linhas = X.exportMontarLinhas(ac, meta, agora);
  check("uma linha por criativo, ordenadas por score", linhas.length === 50 && linhas.every((l, i) => i === 0 || linhas[i - 1].score >= l.score));
  check("rank sequencial", linhas[0].rank === 1 && linhas[49].rank === 50);
  const l3 = linhas.find(l => l.idAnuncio === "800000003");
  check("status e quem achou vêm da equipe", l3.status === "Em análise" && l3.por === "Ana", JSON.stringify(l3));
  check("link do anúncio e da página montados", /ads\/library\/\?id=800000003$/.test(l3.linkAnuncio) && /view_all_page_id=155000003$/.test(l3.linkPagina));
  check("fase traduzida", linhas.some(l => l.fase === "Escala bruta"));

  const csv = X.exportCsv(linhas);
  check("CSV começa com BOM UTF-8", csv.charCodeAt(0) === 0xFEFF);
  const cab = csv.split("\r\n")[0].replace("﻿", "").split(";");
  check("CSV: cabeçalho legível e na ordem das colunas", cab[0] === "#" && cab[1] === "Score" && cab.length === X.EXPORT_COLUNAS_CRIATIVOS.length, cab.join("|"));
  check("CSV: fórmula maliciosa é neutralizada", !/(^|;)"?=HYPERLINK/.test(csv) && /'=HYPERLINK/.test(csv));
  check("CSV: quebra de linha no texto vira espaço", csv.split("\r\n").length === 50 + 2);
  check("CSV: ; e aspas dentro do texto ficam entre aspas", /"[^"\r\n]*""aspas""[^"\r\n]*;[^"\r\n]*"/.test(csv));
  check("CSV: datas em dd/mm/aaaa", /\d{2}\/\d{2}\/\d{4}/.test(csv));

  const xlsx = await X.exportXlsx(linhas, ac, { origem: "teste", recorte: "50 criativos", filtros: "dup ≥ 2", versao: "9.9.9" }, agora);
  check("XLSX é um zip (PK)", xlsx[0] === 0x50 && xlsx[1] === 0x4B);
  fs.writeFileSync("/tmp/teste_export.xlsx", xlsx);
  const g = await X.exportGerar("xlsx", ac, meta, {}, "Nerve Pain / teste", agora);
  check("nome do arquivo organizado", /^VivaSpy_Nerve-Pain-teste_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}_50-criativos\.xlsx$/.test(g.nome), g.nome);
  const gc = await X.exportGerar("csv", ac, meta, {}, "acervo", agora);
  check("exportGerar csv", gc.nome.endsWith(".csv") && gc.dados.length > 1000 && gc.mime.startsWith("text/csv"));
  console.log(fails ? `\n${fails} FALHAS` : "\nTODOS OS TESTES DE EXPORTAÇÃO PASSARAM");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("ERRO", e); process.exit(2); });
