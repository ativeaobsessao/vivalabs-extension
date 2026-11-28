// Peças flutuantes do Centro: aviso rápido (com "Desfazer"), confirmação, menu e painel de detalhes.
// Depende de intel_core.js, intel_view.js e ranking_engine.js (igMapBuscar).

let _intelToastTimer = null;

function intelToast(texto, { desfazer = null, erro = false } = {}) {
  const caixa = document.getElementById("toast");
  caixa.textContent = "";
  caixa.className = `toast${erro ? " erro" : ""}`;
  caixa.appendChild(intelNo("span", null, texto));
  if (desfazer) {
    caixa.appendChild(intelBotao("desfazer", "Desfazer", () => { caixa.hidden = true; desfazer(); }));
  }
  caixa.hidden = false;
  clearTimeout(_intelToastTimer);
  _intelToastTimer = setTimeout(() => { caixa.hidden = true; }, desfazer || erro ? 7000 : 3500);
}

// Confirmação (o foco começa em "Cancelar"; Esc cancela). Devolve true/false.
function intelConfirmarPagina({ titulo, mensagem, confirmar, perigo = false }) {
  return new Promise(resolver => {
    const dialogo = intelNo("dialog", "confirma");
    dialogo.appendChild(intelNo("h3", null, titulo));
    dialogo.appendChild(intelNo("p", null, mensagem));
    const acoes = intelNo("div", "confirma-acoes");
    const fim = ok => { dialogo.close(); dialogo.remove(); resolver(ok); };
    const cancelar = intelBotao("botao cancelar", "Cancelar", () => fim(false));
    acoes.appendChild(cancelar);
    acoes.appendChild(intelBotao(`botao confirmar ${perigo ? "perigo" : "primario"}`, confirmar, () => fim(true)));
    dialogo.appendChild(acoes);
    dialogo.addEventListener("cancel", evento => { evento.preventDefault(); fim(false); });
    document.body.appendChild(dialogo);
    dialogo.showModal();
    cancelar.focus();
  });
}

function intelFecharMenu() {
  const aberto = document.getElementById("menu");
  if (aberto) aberto.remove();
}

// itens = [{ rotulo, fazer, perigo }]
function intelMenu(ancora, itens) {
  const jaAberto = document.getElementById("menu");
  intelFecharMenu();
  if (jaAberto && jaAberto.ancora === ancora) return;
  const menu = intelNo("div", "menu");
  menu.id = "menu";
  menu.ancora = ancora;
  menu.setAttribute("role", "menu");
  itens.filter(Boolean).forEach(item => {
    const b = intelBotao(item.perigo ? "perigo" : "", item.rotulo, () => { intelFecharMenu(); item.fazer(); });
    b.setAttribute("role", "menuitem");
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = ancora.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + window.scrollY}px`;
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
}

function intelFecharPainel() {
  const painel = document.getElementById("painel");
  painel.hidden = true;
  painel.textContent = "";
}

function intelLinhaDetalhe(rotulo, valor) {
  const linha = intelNo("div", "detalhe");
  linha.appendChild(intelNo("span", "rotulo", rotulo));
  linha.appendChild(intelNo("span", "valor", valor || "—"));
  return linha;
}

function intelEscolha(rotulo, opcoes, atual, aoMudar) {
  const caixa = intelNo("label", "campo");
  caixa.appendChild(intelNo("span", null, rotulo));
  const select = document.createElement("select");
  opcoes.forEach(([valor, texto]) => {
    const op = intelNo("option", null, texto);
    op.value = valor;
    select.appendChild(op);
  });
  select.value = atual;
  select.addEventListener("change", () => aoMudar(select.value));
  caixa.appendChild(select);
  return caixa;
}

function intelBotaoCopiar(texto) {
  const botao = intelBotao("botao", "Copiar texto", async () => {
    try {
      await navigator.clipboard.writeText(texto);
      botao.textContent = "✓ Copiado";
    } catch (error) {
      intelToast(`Não consegui copiar: ${error.message}`, { erro: true });
    }
  });
  botao.disabled = !texto;
  return botao;
}

// ctx = { instagram, aoStatus(item, status), aoNicho(item, nicho), aoApagar(item), aoBloquear(item) }
function intelAbrirPainel(item, ctx) {
  const rec = item.rec;
  const painel = document.getElementById("painel");
  painel.textContent = "";
  const topo = intelNo("div", "painel-topo");
  topo.appendChild(intelNo("h2", null, rec.nome || "Anunciante sem nome"));
  const fechar = intelBotao("fechar", "✕", intelFecharPainel);
  fechar.setAttribute("aria-label", "Fechar detalhes");
  topo.appendChild(fechar);
  painel.appendChild(topo);

  painel.appendChild(intelNo("p", "texto-anuncio", rec.copy || "(sem texto capturado)"));
  const links = intelNo("div", "painel-links");
  const adicionar = (rotulo, url) => { if (url) links.appendChild(intelLink("botao", rotulo, url)); };
  adicionar("Abrir biblioteca", intelUrlBiblioteca(rec.pid));
  adicionar("Ver anúncio", intelUrlAnuncio(rec));
  adicionar("Página de destino", intelUrlWeb(rec.dest));
  adicionar("Instagram", ctx.instagram);
  links.appendChild(intelBotaoCopiar(rec.copy));
  painel.appendChild(links);

  painel.appendChild(intelEscolha("Status do trabalho", Object.entries(INTEL_STATUS_ROTULOS), item.status, s => ctx.aoStatus(item, s)));
  painel.appendChild(intelEscolha("Nicho (corrija se estiver errado)", INTEL_NICHOS.map(n => [n, n]), item.nicho, n => ctx.aoNicho(item, n)));
  painel.appendChild(intelLinhaDetalhe("Oferta (domínio)", intelDominio(rec)));
  painel.appendChild(intelLinhaDetalhe("Termos que acharam", (rec.fontes || []).join(" · ")));
  painel.appendChild(intelLinhaDetalhe("Quem achou", item.by));
  painel.appendChild(intelLinhaDetalhe("Formato", rec.video ? "Vídeo" : "Imagem"));
  painel.appendChild(intelLinhaDetalhe("Pontuação de escala", String(item.score)));

  const fim = intelNo("div", "painel-fim");
  fim.appendChild(intelBotao("botao perigo-leve apagar", "Apagar definitivamente", () => ctx.aoApagar(item)));
  if (intelAlvoDaPagina(rec)) fim.appendChild(intelBotao("botao perigo-leve bloquear", "Bloquear este anunciante", () => ctx.aoBloquear(item)));
  painel.appendChild(fim);
  painel.hidden = false;
  fechar.focus();
}
