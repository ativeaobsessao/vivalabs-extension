// Cards do Centro. Só monta elementos: todo texto vindo de anúncio entra por textContent e todo link
// é conferido antes (conteúdo de terceiros é dado não confiável). Depende de intel_core.js.

const INTEL_STATUS_ROTULOS = { nova: "Nova", analise: "Em análise", minerada: "Minerada", descartada: "Descartada" };

function intelNo(tag, classe, texto) {
  const no = document.createElement(tag);
  if (classe) no.className = classe;
  if (texto !== undefined && texto !== null) no.textContent = texto;
  return no;
}

function intelBotao(classe, texto, aoClicar) {
  const b = intelNo("button", classe, texto);
  b.type = "button";
  if (aoClicar) b.addEventListener("click", aoClicar);
  return b;
}

function intelLink(classe, texto, url) {
  const a = intelNo("a", classe, texto);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function intelUrlBiblioteca(pid) {
  return /^\d{5,20}$/.test(String(pid || ""))
    ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=${pid}`
    : "";
}

function intelUrlAnuncio(rec) {
  if (/^\d{8,20}$/.test(String(rec.id || ""))) return `https://www.facebook.com/ads/library/?id=${rec.id}`;
  return /^https:\/\/www\.facebook\.com\/ads\/library\//.test(String(rec.url || "")) ? rec.url : "";
}

function intelUrlWeb(url) {
  return /^https?:\/\//i.test(String(url || "")) ? String(url) : "";
}

function intelMidia(url, thumb, video) {
  const moldura = url ? intelLink("midia", null, url) : intelNo("div", "midia");
  if (url) moldura.setAttribute("aria-label", "Abrir o anúncio");
  const vazio = () => moldura.appendChild(intelNo("span", "sem-imagem", video ? "Vídeo sem prévia" : "Sem prévia"));
  if (!/^https:\/\//i.test(String(thumb || ""))) { vazio(); return moldura; }
  const img = document.createElement("img");
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.src = thumb;
  img.addEventListener("error", () => { img.remove(); vazio(); }, { once: true });
  moldura.appendChild(img);
  return moldura;
}

function intelNumeros(trios) {
  const lista = intelNo("dl", "numeros");
  trios.forEach(([rotulo, valor]) => {
    const bloco = intelNo("div");
    bloco.appendChild(intelNo("dd", null, valor === null || valor === undefined ? "—" : intelNumero(valor)));
    bloco.appendChild(intelNo("dt", null, rotulo));
    lista.appendChild(bloco);
  });
  return lista;
}

function intelCaixaSelecao(key, ctx) {
  const rotulo = intelNo("label", "marcar");
  const caixa = document.createElement("input");
  caixa.type = "checkbox";
  caixa.checked = ctx.selecionados.has(key);
  caixa.setAttribute("aria-label", "Selecionar anúncio");
  caixa.addEventListener("click", evento => ctx.aoMarcar(key, caixa.checked, evento.shiftKey));
  rotulo.appendChild(caixa);
  return rotulo;
}

// ctx = { selecionando, selecionados, aoMarcar, aoDescartar, aoRestaurar, aoDetalhes, aoMenu }
function intelCardCriativo(item, posicao, ctx) {
  const rec = item.rec;
  const card = intelNo("article", `card${ctx.selecionados.has(item.key) ? " marcado" : ""}`);
  card.dataset.key = item.key;
  const midia = intelMidia(intelUrlAnuncio(rec), rec.thumb, rec.video);
  midia.appendChild(intelNo("span", "posicao", `#${posicao}`));
  if (item.selo) midia.appendChild(intelNo("span", `selo ${item.selo}`, INTEL_SELOS[item.selo]));
  card.appendChild(midia);
  if (ctx.selecionando) card.appendChild(intelCaixaSelecao(item.key, ctx));

  const corpo = intelNo("div", "corpo");
  const linha = intelNo("div", "linha-nome");
  linha.appendChild(intelBotao("nome", rec.nome || "Anunciante sem nome", () => ctx.aoDetalhes(item)));
  const mais = intelBotao("mais", "⋯", () => ctx.aoMenu(item, mais));
  mais.setAttribute("aria-label", "Mais opções");
  linha.appendChild(mais);
  corpo.appendChild(linha);
  corpo.appendChild(intelNo("div", "sub", [intelDominio(rec), item.nicho !== "Outro" ? item.nicho : ""].filter(Boolean).join(" · ") || "Fora dos nichos"));
  if (item.status !== "nova") corpo.appendChild(intelNo("div", `etiqueta ${item.status}`, [INTEL_STATUS_ROTULOS[item.status], item.statusBy].filter(Boolean).join(" · ")));
  corpo.appendChild(intelNumeros([["cópias", Number(rec.dup) || 1], ["dias no ar", item.dias], ["ads na biblioteca", Number(rec.adv) || null]]));

  const acoes = intelNo("div", "acoes");
  const biblioteca = intelUrlBiblioteca(rec.pid);
  const destino = biblioteca || intelUrlAnuncio(rec);
  if (destino) acoes.appendChild(intelLink("botao primario abrir", biblioteca ? "Abrir biblioteca" : "Abrir anúncio", destino));
  else acoes.appendChild(intelNo("span", "botao desligado", "Sem link"));
  acoes.appendChild(item.status === "descartada"
    ? intelBotao("botao restaurar", "Restaurar", () => ctx.aoRestaurar(item))
    : intelBotao("botao descartar", "Descartar", () => ctx.aoDescartar(item)));
  corpo.appendChild(acoes);
  card.appendChild(corpo);
  return card;
}

// ctx = { aoVerCriativos, aoMenuGrupo }
function intelCardGrupo(grupo, tipo, posicao, ctx) {
  const card = intelNo("article", "card grupo");
  card.dataset.grupo = grupo.grupo;
  const midia = intelMidia("", grupo.thumb, false);
  midia.appendChild(intelNo("span", "posicao", `#${posicao}`));
  if (grupo.emEscala > 0) midia.appendChild(intelNo("span", "selo agora", `${grupo.emEscala} escalando`));
  card.appendChild(midia);

  const corpo = intelNo("div", "corpo");
  const titulo = tipo === "ofertas" ? grupo.grupo : grupo.nome || "Anunciante sem nome";
  const linha = intelNo("div", "linha-nome");
  linha.appendChild(intelBotao("nome", titulo, () => ctx.aoVerCriativos(grupo)));
  const mais = intelBotao("mais", "⋯", () => ctx.aoMenuGrupo(grupo, mais));
  mais.setAttribute("aria-label", "Mais opções");
  linha.appendChild(mais);
  corpo.appendChild(linha);
  corpo.appendChild(intelNo("div", "sub", tipo === "ofertas"
    ? `${intelNumero(grupo.paginas)} página(s) anunciando`
    : grupo.adv > 1 ? `${intelNumero(grupo.adv)} ads na biblioteca` : "Biblioteca"));
  corpo.appendChild(intelNumeros([["criativos", grupo.criativos], ["maior nº de cópias", grupo.maxDup], ["média de dias", grupo.mediaDias]]));

  const acoes = intelNo("div", "acoes");
  const externo = tipo === "ofertas" ? intelUrlWeb(grupo.dest) : intelUrlBiblioteca(grupo.pid);
  if (externo) acoes.appendChild(intelLink("botao primario abrir", tipo === "ofertas" ? "Abrir oferta" : "Abrir biblioteca", externo));
  acoes.appendChild(intelBotao("botao ver", "Ver criativos", () => ctx.aoVerCriativos(grupo)));
  corpo.appendChild(acoes);
  card.appendChild(corpo);
  return card;
}

function intelVazio(titulo, texto, acao) {
  const caixa = intelNo("div", "vazio");
  caixa.appendChild(intelNo("h2", null, titulo));
  caixa.appendChild(intelNo("p", null, texto));
  if (acao) caixa.appendChild(intelBotao("botao primario", acao.rotulo, acao.fazer));
  return caixa;
}
