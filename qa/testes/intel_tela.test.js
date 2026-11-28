// Tela do Centro de Inteligência (intel.html e todos os scripts REAIS) com chrome e banco falsos.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const DIR = path.resolve(__dirname, "../..");
const read = f => fs.readFileSync(path.join(DIR, f), "utf8");
let fails = 0;
const check = (name, cond) => { if (!cond) { fails++; console.log("FAIL", name); } else console.log("ok  ", name); };
const esperar = (ms = 30) => new Promise(r => setTimeout(r, ms));
const DIA = 86400000;

const HTML = read("intel.html");
const SCRIPTS = Array.from(HTML.matchAll(/<script src="([^"]+)"><\/script>/g), m => m[1]);

function criativo(i, extra = {}) {
  const agora = Date.now();
  return {
    id: String(100000000000 + i), pid: String(900000000 + i), nome: `Pagina ${i}`, copy: `Weight loss secret ${i}`,
    dom: `oferta${i}.com`, dest: `https://oferta${i}.com/p`, thumb: "", video: i % 2 === 0, dup: 1 + (i % 9), adv: 5,
    firstSeen: agora - 3 * DIA, lastSeen: agora, startedAt: agora - (i % 40) * DIA, fontes: ["weight loss"], ...extra,
  };
}

async function abrir({ local = {}, rpc = null, url = "chrome-extension://abc/intel.html" } = {}) {
  const dom = new JSDOM(HTML.replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: url.replace("chrome-extension://abc", "https://abc.test") });
  const { window } = dom;
  const store = { ...local };
  const mensagens = [];
  const chamadas = [];
  const ouvintes = [];
  window.chrome = {
    storage: {
      local: {
        async get(chaves) {
          const lista = Array.isArray(chaves) ? chaves : [chaves];
          return Object.fromEntries(lista.filter(k => k in store).map(k => [k, JSON.parse(JSON.stringify(store[k]))]));
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener: f => ouvintes.push(f) },
    },
    runtime: {
      getManifest: () => ({ version: "1.14.0" }),
      async sendMessage(m) {
        mensagens.push(m);
        if (m.action === "TEAM_SET_STATUS_LOTE") {
          store.viva_team_meta = { ...(store.viva_team_meta || {}) };
          m.keys.forEach(k => { store.viva_team_meta[k] = { by: "Gus", status: m.novoStatus, statusBy: "Gus" }; });
          return { status: "ok" };
        }
        if (m.action === "ACERVO_DELETE") {
          const quero = new Set(m.chaves || []);
          const antes = (store.viva_acervo || []).length;
          store.viva_acervo = (store.viva_acervo || []).filter(c => !quero.has(window.eval("(c) => acervoKey(c)")(c)));
          return { status: "ok", removidos: antes - store.viva_acervo.length };
        }
        return { status: "ok" };
      },
    },
    downloads: { async download(o) { baixados[baixados.length - 1].nome = o.filename; return 1; } },
  };
  window.fetch = async (endereco, opcoes) => {
    const fn = endereco.split("/rpc/")[1];
    const corpo = JSON.parse(opcoes.body);
    chamadas.push({ fn, corpo });
    const resposta = rpc ? rpc(fn, corpo) : undefined;
    if (resposta === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ message: `Could not find the function public.${fn}` }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  window.CSS = { escape: s => String(s).replace(/["\\]/g, "\\$&") };
  window.scrollTo = () => {};
  // APIs do Chrome que o jsdom não tem: usa as do Node e guarda o que seria baixado
  const baixados = [];
  window.TextEncoder = TextEncoder; window.CompressionStream = CompressionStream; window.Response = Response; window.Blob = require("buffer").Blob;
  window.URL.createObjectURL = blob => { baixados.push({ blob }); return `blob:teste/${baixados.length}`; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const erros = [];
  window.addEventListener("error", e => erros.push(e.message));
  window.eval(SCRIPTS.map(read).join("\n;\n"));
  await esperar(80);
  const $ = s => window.document.querySelector(s);
  const $$ = s => Array.from(window.document.querySelectorAll(s));
  const mudar = async (sel, valor) => {
    const el = $(sel);
    if (el.type === "checkbox") el.checked = valor; else el.value = valor;
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
    await esperar();
  };
  const clicar = async alvo => { (typeof alvo === "string" ? $(alvo) : alvo).click(); await esperar(); };
  const botaoComTexto = texto => $$("button").find(b => b.textContent === texto);
  const mudouNoStorage = async obj => { Object.assign(store, obj); ouvintes.forEach(f => f(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { newValue: v }])), "local")); await esperar(950); };
  return { window, $, $$, mudar, clicar, botaoComTexto, mudouNoStorage, store, mensagens, chamadas, baixados, erros };
}

async function testarLocal() {
  const acervo = Array.from({ length: 60 }, (_, i) => criativo(i + 1));
  const t = await abrir({ local: { viva_acervo: acervo } });

  check("diz na página que o limite é de 150 mil anúncios", /150 mil anúncios/.test(t.$("#limiteTexto").textContent));
  check("sem a palavra proibida na tela", !/apple/i.test(t.window.document.documentElement.textContent));
  check("mostra 48 cards por página", t.$$(".card").length === 48);
  check("conta o total", t.$("#contagem").textContent === "60 anúncios");
  check("sem equipe: avisa que está vendo só este computador", !t.$("#aviso").hidden && /código da equipe/.test(t.$("#aviso").textContent));
  check("sem equipe: não mostra alerta de espaço", t.$("#alerta").hidden);
  check("abrir o Centro conta como acesso", t.mensagens.some(m => m.action === "ESPACO_ACESSO"));
  check("não existe Monitorar", !/monitorar/i.test(t.window.document.body.textContent));
  const abrirBib = t.$(".card .abrir");
  check("um clique abre a biblioteca", abrirBib.textContent === "Abrir biblioteca" && /view_all_page_id=\d+/.test(abrirBib.href) && abrirBib.target === "_blank");
  check("card mostra cópias, dias e ads na biblioteca", ["cópias", "dias no ar", "ads na biblioteca"].every(r => t.$(".card").textContent.includes(r)));

  await t.clicar("#proxima");
  check("segunda página tem o resto", t.$$(".card").length === 12 && /Página 2 de 2/.test(t.$("#paginaTexto").textContent));
  check("página fica no endereço", t.window.location.search.includes("pagina=1"));

  await t.mudar("#formato", "video");
  check("filtro volta para a primeira página e fica no endereço", t.window.location.search === "?formato=video");
  check("filtro de formato aplicado", t.$("#contagem").textContent === "30 anúncios");
  await t.clicar("#limpar");
  check("limpar filtros volta tudo", t.$("#contagem").textContent === "60 anúncios" && t.window.location.search === "");

  const chave = t.$(".card").dataset.key;
  await t.clicar(".card .descartar");
  check("descartar some com o card na hora", !t.$(`.card[data-key="${chave}"]`) && t.$("#contagem").textContent === "59 anúncios");
  check("oferece Desfazer", Boolean(t.botaoComTexto("Desfazer")));
  await t.clicar(t.botaoComTexto("Desfazer"));
  check("desfazer devolve o anúncio", t.$("#contagem").textContent === "60 anúncios");

  await t.clicar("#selecionar");
  await t.clicar("#selTodos");
  check("seleciona todos do filtro, não só a página", t.$("#selContagem").textContent === "60 selecionados");
  await t.clicar("#selApagar");
  check("apagar pede confirmação", Boolean(t.$("dialog.confirma")));
  await t.clicar("dialog .cancelar");
  check("cancelar não apaga e mantém a seleção", t.store.viva_acervo.length === 60 && t.$("#selContagem").textContent === "60 selecionados");
  await t.clicar("#selCancelar");

  await t.clicar('#abas [data-aba="ofertas"]');
  check("aba Ofertas agrupa por domínio", t.$$(".card.grupo").length === 48 && t.$("#contagem").textContent === "60 ofertas");
  await t.clicar(".card.grupo .ver");
  check("Ver criativos filtra a oferta", t.$("#contagem").textContent === "1 anúncio" && /Oferta: /.test(t.$("#recorte").textContent));
  await t.clicar("#limpar");

  await t.clicar("#voltar");
  check("botão voltar pede para voltar à Biblioteca", t.mensagens.some(m => m.action === "INTEL_VOLTAR"));
  check("sem erros de script", t.erros.length === 0);
}

async function testarTrabalhoDaEquipe() {
  const agora = Date.now();
  const acervo = Array.from({ length: 6 }, (_, i) => criativo(i + 1));
  const chave1 = `id:${acervo[0].id}`;
  const t = await abrir({ local: { viva_acervo: acervo, viva_team_meta: { [chave1]: { by: "Ana", status: "nova" } } } });

  const cards = () => t.$$(".card");
  const marca = i => cards()[i].querySelector(".marcar input");
  await t.clicar("#selecionar");
  marca(0).click(); await esperar();
  marca(3).dispatchEvent(new t.window.MouseEvent("click", { bubbles: true, shiftKey: true })); await esperar();
  check("Shift+clique marca o intervalo", t.$("#selContagem").textContent === "4 selecionados");
  await t.clicar("#selBaixar");
  await esperar(500);
  const arquivo = t.baixados[0];
  check("baixa planilha só dos selecionados", Boolean(arquivo) && /^VivaSpy\/VivaSpy_selecao_.*_4-criativos\.xlsx$/.test(arquivo.nome));
  await t.clicar("#selDescartar");
  check("descarta em lote sem apagar do acervo", t.$("#contagem").textContent === "2 anúncios" && t.store.viva_acervo.length === 6);
  await t.mudar("#status", "descartada");
  check("filtro Descartada recupera os descartados", cards().length === 4);
  await t.clicar(cards()[0].querySelector(".restaurar"));
  check("restaurar tira da lista de descartados", cards().length === 3);
  await t.clicar("#limpar");

  const cardDaAna = t.$(`.card[data-key="${chave1}"]`) || cards()[0];
  await t.clicar(cardDaAna.querySelector(".nome"));
  check("detalhes abrem no painel lateral", !t.$("#painel").hidden && /Quem achou/.test(t.$("#painel").textContent));
  const selects = t.$$("#painel select");
  selects[1].value = "Diabetes";
  selects[1].dispatchEvent(new t.window.Event("change")); await esperar();
  check("corrige o nicho pelo painel", Object.values(t.store.viva_nichos_manuais || {}).includes("Diabetes"));

  await t.mudar("#status", "todas");
  await t.mudar("#dias", "1-7");
  t.$("#salvoNome").value = "Meu filtro";
  await t.clicar("#salvoGravar");
  check("salva o filtro com nome", t.store.viva_filtros_salvos[0].nome === "Meu filtro" && t.store.viva_filtros_salvos[0].filtros.dias === "1-7");
  const filtrados = cards().length;
  await t.clicar("#limpar");
  await t.mudar("#salvos", "0");
  check("aplicar o filtro salvo restaura o recorte", t.$("#dias").value === "1-7" && cards().length === filtrados);
  await t.clicar("#limpar");

  await t.mudouNoStorage({ viva_acervo: [...t.store.viva_acervo, criativo(50)] });
  check("atualiza ao vivo quando a coleta grava (os 3 descartados seguem escondidos)", t.$("#contagem").textContent === "4 anúncios");
  await t.mudouNoStorage({ viva_team_radar: { at: agora, now: agora, items: [{ by: "Notebook", ms: agora - 3600e3, info: { on: true, status: "waiting", everyH: 4, lastRunAt: agora - 3600e3 } }] } });
  check("avisa quando o radar está sem sinal", /Radar sem sinal · Notebook/.test(t.$("#radar").textContent));

  await t.clicar("#opcoes");
  await t.clicar(t.botaoComTexto("Apagar acervo deste computador"));
  check("limpar o computador pede confirmação", Boolean(t.$("dialog.confirma")) && !t.mensagens.some(m => m.action === "ACERVO_CLEAR"));
  await t.clicar("dialog .confirmar");
  check("confirmado: manda limpar o computador", t.mensagens.some(m => m.action === "ACERVO_CLEAR"));

  await t.clicar(cards()[0].querySelector(".mais"));
  await t.clicar(t.botaoComTexto("Bloquear este anunciante"));
  await t.clicar("dialog .confirmar");
  const bloqueio = t.mensagens.find(m => m.action === "ACERVO_DELETE" && m.paginas);
  check("bloquear anunciante apaga e impede de voltar", Boolean(bloqueio) && bloqueio.bloquear === true && bloqueio.paginas.length === 1);
  check("sem erros de script na triagem", t.erros.length === 0);
}

function bancoFalso(total) {
  const itens = [criativo(1), criativo(2)].map((rec, i) => ({
    key: `k${i + 1}`, rec, by: "Ana", status: "nova", statusBy: "", score: 50 - i, dias: 10, selo: "bruta", nicho: i ? "Outro" : "Emagrecimento",
  }));
  return fn => ({
    viva_info: { versao: 2, total, descartados: 7, bloqueados: 0, bytes: 310e6 },
    viva_opcoes: { termos: ["weight loss"], quem: ["Ana"] },
    viva_buscar: { total, itens },
    viva_marcar: 1,
    viva_apagar_descartados: { apagados: 7, restam: 0 },
  })[fn];
}

async function testarBanco() {
  const equipe = { viva_team_code: "codigo-secreto-123", viva_team_name: "Gus" };
  const cheio = await abrir({ local: equipe, rpc: bancoFalso(150200) });
  check("banco: medidor mostra X de 150 mil", /150\.200 de 150 mil anúncios · 310 MB de 500 MB/.test(cheio.$("#medidorTexto").textContent));
  check("banco: acima do limite o alerta aparece", !cheio.$("#alerta").hidden && cheio.$("#alerta").dataset.nivel === "estourou");
  check("alerta manda apagar fora do modelo ou assinar o plano", /modelo de negócio/.test(cheio.$("#alerta").textContent) && /plano pago/.test(cheio.$("#alerta").textContent));
  check("alerta diz que nada é apagado sozinho", /Nada é apagado sozinho/.test(cheio.$("#alerta").textContent));
  check("banco: não mostra aviso de modo local", cheio.$("#aviso").hidden);
  check("banco: paginação pelo total do servidor", /Página 1 de 3\.130/.test(cheio.$("#paginaTexto").textContent));

  await cheio.clicar("#alerta .fora");
  const ultima = cheio.chamadas.filter(c => c.fn === "viva_buscar").pop();
  check("ver fora dos nichos filtra Outro e liga a seleção", ultima.corpo.p_filtros.nicho === "Outro" && !cheio.$("#barraSelecao").hidden);

  await cheio.clicar("#alerta .apagar-descartados");
  await cheio.clicar("dialog .confirmar");
  check("apagar descartados chama o banco depois de confirmar", cheio.chamadas.some(c => c.fn === "viva_apagar_descartados"));

  await cheio.clicar("#alerta .baixar-tudo");
  check("baixar planilha de novo pede ao background", cheio.mensagens.some(m => m.action === "EXPORT_NOW"));

  await cheio.clicar("#selCancelar");
  await cheio.clicar(".card .descartar");
  const marcar = cheio.chamadas.find(c => c.fn === "viva_marcar");
  check("descartar grava no banco com o nome de quem fez", marcar && marcar.corpo.p_status === "descartada" && marcar.corpo.p_by === "Gus");
  check("banco: sem erros de script", cheio.erros.length === 0);

  const folgado = await abrir({ local: equipe, rpc: bancoFalso(1000) });
  check("com folga não há alerta", folgado.$("#alerta").hidden);

  const semSql = await abrir({ local: { ...equipe, viva_acervo: [criativo(3)] }, rpc: () => undefined });
  check("sem o SQL novo: usa o computador e avisa o arquivo a rodar", /SUPABASE_ATUALIZACAO_150K\.sql/.test(semSql.$("#aviso").textContent) && semSql.$$(".card").length === 1);

  const fora = await abrir({ local: equipe, rpc: () => { throw new Error("Failed to fetch"); } });
  check("sem conexão: mostra erro, não troca de fonte em silêncio", /Não consegui carregar/.test(fora.$("#grade").textContent) && fora.$$(".card").length === 0);

  const perigoso = criativo(9, { nome: "<img src=x onerror=alert(1)>", dest: "javascript:alert(1)", thumb: "javascript:alert(1)" });
  const seguro = await abrir({ local: { viva_acervo: [perigoso] } });
  check("texto de anúncio entra como texto, nunca como HTML", !seguro.$(".card img") && seguro.$(".card .nome").textContent === perigoso.nome);
  check("link javascript: nunca vira link", !seguro.$$("a").some(a => /^javascript:/i.test(a.getAttribute("href"))));
}

(async () => {
  await testarLocal();
  await testarTrabalhoDaEquipe();
  await testarBanco();
  console.log(fails ? `${fails} FALHA(S)` : "TUDO OK");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
