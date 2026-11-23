const fs = require("fs");
const vm = require("vm");
const dir = "/home/claude/repo/vivalabs-extension/";
const ctx = { console, URLSearchParams, Date, Math, Number, String, Array, Map, Set, Object, JSON, Promise };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + "intelligent_parser.js", "utf8") + "\n" + fs.readFileSync(dir + "ranking_engine.js", "utf8") +
  "\nthis.api={mesclarAcervo,mesclarRemotos,acervoKey,lixeiraVazia,lixeiraNormalizar,lixeiraAdicionar,acervoRemover,lixeiraConjuntos,lixeiraBloqueia,igUrlValida,igMapGravar,igMapBuscar,igMapChaves,VIVA_IG_MAP_MAX:()=>VIVA_IG_MAP_MAX};", ctx);
const a = ctx.api;
let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); } else console.log("ok  ", name); };
const AG = 1700000000000;
const cr = (i, pid, dom, nome) => ({ id: String(100000000 + i), pid: String(pid), nome: nome || "Pag " + pid, dom, dest: "https://" + dom + "/lp", copy: "t" + i, dup: 3, dias: 5, adv: 2, fonte: "q" });

// base: 6 criativos em 3 páginas e 2 domínios
const base = a.mesclarAcervo([], [cr(1, 900000001, "a.com"), cr(2, 900000001, "a.com"), cr(3, 900000002, "b.com"), cr(4, 900000002, "a.com"), cr(5, 900000003, "c.com"), cr(6, 900000003, "c.com")], AG).acervo;
eq("base tem 6", base.length, 6);

// apagar por chave
let r = a.acervoRemover(base, { chaves: ["id:100000001", "id:100000002"] });
eq("remove 2 por chave", [r.acervo.length, r.removidos.length], [4, 2]);
// apagar por página (bibliotecas)
r = a.acervoRemover(base, { paginas: ["900000002"] });
eq("remove biblioteca inteira", [r.acervo.length, r.removidos.sort()], [4, ["id:100000003", "id:100000004"]]);
// apagar por domínio (ofertas)
r = a.acervoRemover(base, { dominios: ["a.com"] });
eq("remove oferta por domínio (cruza páginas)", [r.acervo.length, r.removidos.length], [3, 3]);
// página sem pid: chave n:nome
const semPid = a.mesclarAcervo([], [{ id: "", sig: "abc", nome: "Fulano", dom: "z.com", copy: "x", dup: 2 }], AG).acervo;
r = a.acervoRemover(semPid, { paginas: ["n:fulano"] });
eq("remove página sem pid por nome", r.acervo.length, 0);
// vazio/lixo de entrada
eq("alvo vazio não remove nada", a.acervoRemover(base, {}).acervo.length, 6);
eq("acervo inválido", a.acervoRemover(null, { chaves: ["x"] }), { acervo: [], removidos: [] });

// lixeira: imutável, sem duplicar, com teto
const l0 = a.lixeiraVazia();
const l1 = a.lixeiraAdicionar(l0, { chaves: ["id:1", "id:1", "id:2"], paginas: ["9"], dominios: ["a.com"] }, 5);
eq("lixeira original intacta", l0.chaves.length, 0);
eq("lixeira sem duplicata", [l1.chaves, l1.paginas, l1.dominios, l1.at], [["id:1", "id:2"], ["9"], ["a.com"], 5]);
const grande = a.lixeiraAdicionar(l0, { chaves: Array.from({ length: 25000 }, (_, i) => "id:" + i) });
eq("teto de chaves 20000 (mantém as mais recentes)", [grande.chaves.length, grande.chaves[0], grande.chaves[19999]], [20000, "id:5000", "id:24999"]);
eq("lixeira inválida vira vazia", a.lixeiraNormalizar("lixo"), a.lixeiraVazia());

// bloqueio nas portas de entrada
const lix = a.lixeiraAdicionar(null, { chaves: ["id:100000001"], paginas: ["900000003"], dominios: ["b.com"] });
const novos = [cr(1, 900000001, "a.com"), cr(2, 900000001, "a.com"), cr(3, 900000002, "b.com"), cr(5, 900000003, "c.com"), cr(7, 900000004, "d.com")];
const m = a.mesclarAcervo([], novos, AG, undefined, lix);
eq("mesclarAcervo respeita a lixeira", [m.acervo.map(c => c.id).sort(), m.bloqueados], [["100000002", "100000007"], 3]);
const m2 = a.mesclarAcervo(base, [], AG, undefined, lix);
eq("lixeira também limpa o que já estava no acervo", m2.acervo.map(c => c.id).sort(), ["100000002", "100000004"].sort());
const m3 = a.mesclarAcervo(base, novos, AG);
eq("sem lixeira nada muda (compat)", m3.acervo.length, 7);
const rem = a.mesclarRemotos([], novos.map(c => ({ key: a.acervoKey(c), rec: { ...c, firstSeen: AG, lastSeen: AG } })), AG, undefined, lix);
eq("cofre da equipe não devolve o apagado", rem.acervo.map(c => c.id).sort(), ["100000002", "100000007"]);
eq("restaurar: lixeira vazia deixa voltar", a.mesclarRemotos([], novos.map(c => ({ key: a.acervoKey(c), rec: { ...c, firstSeen: AG, lastSeen: AG } })), AG, undefined, a.lixeiraVazia()).acervo.length, 5);

// Instagram
eq("ig canônico", a.igUrlValida("http://instagram.com/Loja.Teste/?hl=pt"), "https://www.instagram.com/Loja.Teste");
eq("ig rejeita post/reel/explore", [a.igUrlValida("https://www.instagram.com/p/abc"), a.igUrlValida("https://instagram.com/reel/x"), a.igUrlValida("https://www.instagram.com/explore/")], ["", "", ""]);
eq("ig rejeita outro site/lixo", [a.igUrlValida("https://evil.com/instagram.com/x"), a.igUrlValida("javascript:alert(1)"), a.igUrlValida("")], ["", "", ""]);
eq("ig chaves", a.igMapChaves("123456789", "Minha Loja"), ["pid:123456789", "n:minha loja"]);
eq("ig chaves sem pid válido", a.igMapChaves("abc", "X"), ["n:x"]);
let mp = a.igMapGravar({}, { pid: "123456789", nome: "Minha Loja", url: "https://www.instagram.com/minhaloja/" }, 10);
eq("ig gravado por pid e nome", Object.keys(mp).sort(), ["n:minha loja", "pid:123456789"]);
eq("ig busca por pid", a.igMapBuscar(mp, { pid: "123456789", nome: "outro" }), "https://www.instagram.com/minhaloja");
eq("ig busca por nome (sem pid)", a.igMapBuscar(mp, { pid: "", nome: "MINHA LOJA" }), "https://www.instagram.com/minhaloja");
eq("ig busca inexistente", a.igMapBuscar(mp, { pid: "999999999", nome: "zzz" }), "");
eq("ig inválido não grava", a.igMapGravar(mp, { pid: "123456789", nome: "Minha Loja", url: "https://evil.com" }, 11), mp);
eq("ig grava só com identidade", a.igMapGravar({}, { pid: "", nome: "", url: "https://www.instagram.com/x" }, 1), {});
let cheio = {};
for (let i = 0; i < a.VIVA_IG_MAP_MAX() + 50; i += 1) cheio = a.igMapGravar(cheio, { pid: String(100000000 + i), nome: "", url: "https://www.instagram.com/u" + i }, i + 1);
eq("ig mapa respeita o teto e descarta os mais antigos", [Object.keys(cheio).length, "pid:100000000" in cheio, "pid:" + (100000000 + a.VIVA_IG_MAP_MAX() + 49) in cheio], [a.VIVA_IG_MAP_MAX(), false, true]);

console.log(fail ? `\n${fail} FALHAS` : "\nTODOS OS TESTES DA LIXEIRA/INSTAGRAM PASSARAM");
process.exit(fail ? 1 : 0);
