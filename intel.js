// Centro de Inteligência (aba própria): estado da tela, filtros no endereço e desenho da grade.
// Depende de todos os intel_*.js, ranking_engine.js, export_data.js e team_sync.js.

const INTEL_SALVOS_KEY = "viva_filtros_salvos";
const INTEL_CAMPOS_TEXTO = { busca: "busca", nicho: "nicho", dias: "dias", formato: "formato", copiasMin: "copiasMin", advMin: "advMin", termo: "termo", quem: "quem", status: "status" };

const intelEstado = {
  fonte: null, aba: "criativos", ordem: "score", pagina: 0, filtros: intelFiltrosPadrao(),
  itens: [], total: 0, info: null, selecionando: false, selecionados: new Set(), ultimaMarca: "",
  igMap: {}, salvos: [], pedido: 0,
};

const intelPorId = id => document.getElementById(id);

const intelTelaApi = {
  get fonte() { return intelEstado.fonte; },
  recarregar: () => intelCarregar(),
  filtros: () => intelEstado.filtros,
  selecionados: () => Array.from(intelEstado.selecionados),
  definirSelecao(keys) {
    intelEstado.selecionados = new Set(keys);
    intelDesenharGrade();
  },
};

// ── endereço (voltar/recarregar mantém o recorte) ────────────────────────────────────────────────
function intelLerEndereco() {
  const p = new URLSearchParams(location.search);
  intelEstado.aba = ["criativos", "ofertas", "paginas"].includes(p.get("aba")) ? p.get("aba") : "criativos";
  intelEstado.ordem = INTEL_ORDENS.includes(p.get("ordem")) ? p.get("ordem") : "score";
  intelEstado.pagina = Math.max(0, Math.floor(Number(p.get("pagina")) || 0));
  intelEstado.filtros = intelFiltrosNormalizar(Object.fromEntries(p));
}

function intelGravarEndereco() {
  const p = new URLSearchParams(intelFiltrosEnxutos(intelEstado.filtros));
  if (intelEstado.aba !== "criativos") p.set("aba", intelEstado.aba);
  if (intelEstado.ordem !== "score") p.set("ordem", intelEstado.ordem);
  if (intelEstado.pagina) p.set("pagina", String(intelEstado.pagina));
  const texto = p.toString();
  history.replaceState(null, "", texto ? `?${texto}` : location.pathname);
}

// ── controles ────────────────────────────────────────────────────────────────────────────────────
function intelDesenharControles() {
  const f = intelEstado.filtros;
  document.querySelectorAll("#abas button").forEach(b => b.classList.toggle("ativo", b.dataset.aba === intelEstado.aba));
  document.querySelectorAll("#escala button").forEach(b => b.classList.toggle("ativo", b.dataset.escala === f.escala));
  Object.entries(INTEL_CAMPOS_TEXTO).forEach(([id, campo]) => {
    const el = intelPorId(id);
    if (document.activeElement !== el) el.value = f[campo] || "";
  });
  intelPorId("novos24").checked = f.novos24;
  intelPorId("subindo").checked = f.subindo;
  intelPorId("ordem").value = intelEstado.ordem;
  intelPorId("ordem").hidden = intelEstado.aba !== "criativos";
  intelPorId("selecionar").hidden = intelEstado.aba !== "criativos";
  intelPorId("selecionar").setAttribute("aria-pressed", String(intelEstado.selecionando));
  intelPorId("limpar").hidden = Object.keys(intelFiltrosEnxutos(f)).length === 0;
  const recorte = f.dom ? `Oferta: ${f.dom}` : f.pid || f.nomeExato ? "Só os anúncios desta biblioteca" : "";
  intelPorId("recorte").textContent = recorte;
}

// Mudou filtro, aba ou ordem: volta para a primeira página e desfaz a seleção.
function intelMudar(mudanca) {
  const { aba, ordem, ...filtros } = mudanca;
  if (aba) intelEstado.aba = aba;
  if (ordem) intelEstado.ordem = ordem;
  intelEstado.filtros = intelFiltrosNormalizar({ ...intelEstado.filtros, ...filtros });
  intelEstado.pagina = 0;
  intelEstado.selecionados = new Set();
  if (intelEstado.aba !== "criativos") intelEstado.selecionando = false;
  return intelCarregar();
}

function intelLimparFiltros() {
  intelEstado.filtros = intelFiltrosPadrao();
  return intelMudar({});
}

function intelMarcar(key, marcado, comShift) {
  const ordem = intelEstado.itens.map(i => i.key);
  const de = ordem.indexOf(intelEstado.ultimaMarca);
  const ate = ordem.indexOf(key);
  const faixa = comShift && de >= 0 && ate >= 0 ? ordem.slice(Math.min(de, ate), Math.max(de, ate) + 1) : [key];
  const nova = new Set(intelEstado.selecionados);
  faixa.forEach(k => (marcado ? nova.add(k) : nova.delete(k)));
  intelEstado.selecionados = nova;
  intelEstado.ultimaMarca = key;
  intelDesenharGrade();
}

// ── cards ────────────────────────────────────────────────────────────────────────────────────────
function intelContextoPainel() {
  return {
    aoStatus: (item, status) => { intelFecharPainel(); intelMudarStatus(intelTelaApi, item.key, status); },
    aoNicho: (item, nicho) => { intelFecharPainel(); intelMudarNicho(intelTelaApi, item.key, nicho); },
    aoApagar: async item => { if (await intelApagar(intelTelaApi, [item.key])) intelFecharPainel(); },
    aoBloquear: async item => {
      if (await intelBloquear(intelTelaApi, intelAlvoDaPagina(item.rec), item.rec.nome || "este anunciante")) intelFecharPainel();
    },
  };
}

function intelDetalhes(item) {
  const instagram = igMapBuscar(intelEstado.igMap, { pid: item.rec.pid, nome: item.rec.nome });
  intelAbrirPainel(item, { instagram, ...intelContextoPainel() });
}

function intelContextoCards() {
  return {
    selecionando: intelEstado.selecionando,
    selecionados: intelEstado.selecionados,
    aoMarcar: intelMarcar,
    aoDetalhes: intelDetalhes,
    aoDescartar: item => { document.querySelector(`.card[data-key="${CSS.escape(item.key)}"]`)?.remove(); intelDescartar(intelTelaApi, [item]); },
    aoRestaurar: item => intelMudarStatus(intelTelaApi, item.key, "nova"),
    aoMenu: (item, ancora) => intelMenu(ancora, [
      { rotulo: "Ver detalhes", fazer: () => intelDetalhes(item) },
      intelAlvoDaPagina(item.rec) && { rotulo: "Bloquear este anunciante", perigo: true, fazer: () => intelBloquear(intelTelaApi, intelAlvoDaPagina(item.rec), item.rec.nome || "este anunciante") },
      { rotulo: "Apagar definitivamente", perigo: true, fazer: () => intelApagar(intelTelaApi, [item.key]) },
    ]),
  };
}

function intelRecorteDoGrupo(grupo) {
  if (intelEstado.aba === "ofertas") return { dom: grupo.grupo };
  return grupo.pid ? { pid: grupo.pid } : { nomeExato: grupo.grupo.slice(2) };
}

function intelContextoGrupos() {
  const aba = intelEstado.aba;
  const verCriativos = grupo => intelMudar({ aba: "criativos", dom: "", pid: "", nomeExato: "", ...intelRecorteDoGrupo(grupo) });
  return {
    aoVerCriativos: verCriativos,
    aoMenuGrupo: (grupo, ancora) => {
      const nome = aba === "ofertas" ? grupo.grupo : grupo.nome || "este anunciante";
      const alvo = aba === "ofertas" ? `d:${grupo.grupo}` : grupo.pid ? `p:${grupo.pid}` : grupo.grupo;
      intelMenu(ancora, [
        { rotulo: "Ver criativos", fazer: () => verCriativos(grupo) },
        { rotulo: aba === "ofertas" ? "Bloquear esta oferta" : "Bloquear este anunciante", perigo: true, fazer: () => intelBloquear(intelTelaApi, alvo, nome) },
      ]);
    },
  };
}

function intelDesenharVazio(grade) {
  const filtrado = Object.keys(intelFiltrosEnxutos(intelEstado.filtros)).length > 0;
  grade.appendChild(filtrado
    ? intelVazio("Nada com esses filtros", "Afrouxe um filtro para ver mais anúncios.", { rotulo: "Limpar filtros", fazer: intelLimparFiltros })
    : intelVazio("Ainda não há anúncios aqui", "Abra a Meta Ad Library e role a página, ou use a Busca Inteligente: o que for encontrado aparece aqui."));
}

function intelDesenharGrade() {
  const grade = intelPorId("grade");
  grade.textContent = "";
  const inicio = intelEstado.pagina * INTEL_PAGINA;
  const cards = intelEstado.aba === "criativos" ? intelContextoCards() : intelContextoGrupos();
  intelEstado.itens.forEach((item, i) => grade.appendChild(intelEstado.aba === "criativos"
    ? intelCardCriativo(item, inicio + i + 1, cards)
    : intelCardGrupo(item, intelEstado.aba, inicio + i + 1, cards)));
  if (!intelEstado.itens.length) intelDesenharVazio(grade);

  const unidade = { criativos: ["anúncio", "anúncios"], ofertas: ["oferta", "ofertas"], paginas: ["biblioteca", "bibliotecas"] }[intelEstado.aba];
  intelPorId("contagem").textContent = intelPlural(intelEstado.total, ...unidade);
  const totalPaginas = Math.max(1, Math.ceil(intelEstado.total / INTEL_PAGINA));
  intelPorId("paginas").hidden = totalPaginas <= 1;
  intelPorId("paginaTexto").textContent = `Página ${intelNumero(intelEstado.pagina + 1)} de ${intelNumero(totalPaginas)}`;
  intelPorId("anterior").disabled = intelEstado.pagina === 0;
  intelPorId("proxima").disabled = intelEstado.pagina >= totalPaginas - 1;

  const n = intelEstado.selecionados.size;
  intelPorId("barraSelecao").hidden = !intelEstado.selecionando;
  intelPorId("selContagem").textContent = intelPlural(n, "selecionado", "selecionados");
  intelPorId("selTodos").textContent = `Selecionar todos do filtro (${intelNumero(intelEstado.total)})`;
  ["selDescartar", "selApagar", "selBaixar"].forEach(id => { intelPorId(id).disabled = n === 0; });
}

// ── topo ─────────────────────────────────────────────────────────────────────────────────────────
async function intelDesenharTopo() {
  const [espaco, progresso, radar, igMap] = await Promise.all([
    intelLerLocal("viva_espaco", null), intelLerLocal("viva_espaco_progresso", null),
    intelLerLocal("viva_team_radar", null), intelLerLocal(VIVA_IG_MAP_KEY, {}),
  ]);
  intelEstado.igMap = igMap;
  const modo = intelEstado.fonte.modo;
  intelDesenharModo(intelEstado.fonte);
  intelDesenharMedidor(modo, intelEstado.info);
  intelDesenharAlerta(modo === "banco" ? intelEstado.info : null, espaco, progresso, {
    foraDosNichos: () => { intelEstado.selecionando = true; return intelMudar({ aba: "criativos", nicho: "Outro" }); },
    apagarDescartados: quantos => intelApagarTodosDescartados(intelTelaApi, quantos),
    baixarTudo: intelBaixarTudo,
  });
  intelDesenharRadar(radar);
}

function intelDesenharErro(error) {
  const grade = intelPorId("grade");
  grade.textContent = "";
  grade.appendChild(intelVazio("Não consegui carregar", teamFriendlyError(error), { rotulo: "Tentar de novo", fazer: intelIniciarFonte }));
  intelPorId("contagem").textContent = "";
  intelPorId("paginas").hidden = true;
}

// Só a resposta do pedido mais recente é desenhada.
async function intelCarregar() {
  if (!intelEstado.fonte) return;
  const pedido = ++intelEstado.pedido;
  const { fonte, aba, filtros, ordem, pagina } = intelEstado;
  intelFecharMenu();
  intelGravarEndereco();
  intelDesenharControles();
  intelPorId("grade").classList.add("carregando");
  try {
    const [resultado, info] = await Promise.all([
      aba === "criativos" ? fonte.buscar(filtros, ordem, pagina) : fonte.grupos(aba, filtros, pagina),
      fonte.info(),
    ]);
    if (pedido !== intelEstado.pedido) return;
    if (!resultado.itens.length && pagina > 0) {
      intelEstado.pagina = Math.max(0, Math.ceil(resultado.total / INTEL_PAGINA) - 1);
      await intelCarregar();
      return;
    }
    intelEstado.itens = resultado.itens;
    intelEstado.total = resultado.total;
    intelEstado.info = info;
    intelDesenharGrade();
    await intelDesenharTopo();
  } catch (error) {
    if (pedido === intelEstado.pedido) intelDesenharErro(error);
  } finally {
    if (pedido === intelEstado.pedido) intelPorId("grade").classList.remove("carregando");
  }
}

// ── filtros salvos ───────────────────────────────────────────────────────────────────────────────
function intelDesenharSalvos() {
  const select = intelPorId("salvos");
  select.textContent = "";
  [{ nome: intelEstado.salvos.length ? "Escolher…" : "Nenhum salvo ainda" }, ...intelEstado.salvos].forEach((salvo, i) => {
    const op = intelNo("option", null, salvo.nome);
    op.value = i ? String(i - 1) : "";
    select.appendChild(op);
  });
}

async function intelGravarSalvos(lista) {
  intelEstado.salvos = lista.slice(-30);
  await chrome.storage.local.set({ [INTEL_SALVOS_KEY]: intelEstado.salvos });
  intelDesenharSalvos();
}

async function intelLerSalvos() {
  const brutos = await intelLerLocal(INTEL_SALVOS_KEY, []);
  intelEstado.salvos = (Array.isArray(brutos) ? brutos : [])
    .filter(s => s && typeof s.nome === "string" && (s.filtros || s.ui))
    .map(s => ({
      nome: s.nome,
      filtros: s.filtros ? intelFiltrosNormalizar(s.filtros) : intelFiltrosDoModeloAntigo(s.ui),
      ordem: INTEL_ORDENS.includes(s.ordem) ? s.ordem : "score",
    }));
  intelDesenharSalvos();
}

function intelLigarSalvos() {
  intelPorId("salvos").addEventListener("change", evento => {
    const salvo = intelEstado.salvos[Number(evento.target.value)];
    if (evento.target.value === "" || !salvo) return;
    intelEstado.filtros = salvo.filtros;
    intelMudar({ aba: "criativos", ordem: salvo.ordem });
  });
  intelPorId("salvoGravar").addEventListener("click", async () => {
    const nome = intelPorId("salvoNome").value.trim().slice(0, 40);
    if (!nome) { intelToast("Escreva um nome para o filtro."); return; }
    const outros = intelEstado.salvos.filter(s => s.nome.toLowerCase() !== nome.toLowerCase());
    await intelGravarSalvos([...outros, { nome, filtros: intelEstado.filtros, ordem: intelEstado.ordem }]);
    intelPorId("salvoNome").value = "";
    intelToast(`Filtro salvo: ${nome}`);
  });
  intelPorId("salvoExcluir").addEventListener("click", async () => {
    const escolhido = intelPorId("salvos").value;
    if (escolhido === "") { intelToast("Escolha um filtro salvo para excluir."); return; }
    await intelGravarSalvos(intelEstado.salvos.filter((_, i) => i !== Number(escolhido)));
  });
}

// ── eventos ──────────────────────────────────────────────────────────────────────────────────────
function intelMenuGeral(ancora) {
  const info = intelEstado.info || {};
  const chavesDoFiltro = async () => intelBaixar(intelTelaApi, await intelEstado.fonte.chaves(intelEstado.filtros), "filtro");
  intelMenu(ancora, [
    { rotulo: "Baixar planilha deste filtro", fazer: () => chavesDoFiltro().catch(e => intelToast(teamFriendlyError(e), { erro: true })) },
    { rotulo: intelEstado.fonte.modo === "banco" ? "Baixar planilha do banco inteiro" : "Baixar planilha de tudo", fazer: intelBaixarTudo },
    { rotulo: `Ver descartados (${intelNumero(info.descartados)})`, fazer: () => intelMudar({ aba: "criativos", status: "descartada" }) },
    { rotulo: "Apagar descartados definitivamente", perigo: true, fazer: () => intelApagarTodosDescartados(intelTelaApi, info.descartados) },
    info.bloqueados ? { rotulo: `Liberar bloqueados (${intelNumero(info.bloqueados)})`, fazer: () => intelLiberarBloqueados(intelTelaApi) } : null,
    intelEstado.fonte.modo === "local" ? { rotulo: "Apagar acervo deste computador", perigo: true, fazer: () => intelLimparComputador(intelTelaApi) } : null,
  ]);
}

function intelLigarFiltros() {
  document.querySelectorAll("#abas button").forEach(b => b.addEventListener("click", () => intelMudar({ aba: b.dataset.aba })));
  document.querySelectorAll("#escala button").forEach(b => b.addEventListener("click", () => intelMudar({ escala: b.dataset.escala })));
  ["nicho", "dias", "formato", "termo", "quem", "status"].forEach(id => intelPorId(id).addEventListener("change", e => intelMudar({ [id]: e.target.value })));
  ["novos24", "subindo"].forEach(id => intelPorId(id).addEventListener("change", e => intelMudar({ [id]: e.target.checked })));
  let espera = null;
  ["busca", "copiasMin", "advMin"].forEach(id => intelPorId(id).addEventListener("input", e => {
    clearTimeout(espera);
    espera = setTimeout(() => intelMudar({ [id]: e.target.value }), 350);
  }));
  intelPorId("ordem").addEventListener("change", e => intelMudar({ ordem: e.target.value }));
  intelPorId("limpar").addEventListener("click", intelLimparFiltros);
  intelPorId("maisFiltros").addEventListener("click", () => {
    const painel = intelPorId("painelFiltros");
    painel.hidden = !painel.hidden;
    intelPorId("maisFiltros").setAttribute("aria-expanded", String(!painel.hidden));
  });
}

function intelLigarSelecao() {
  const alternar = ligado => {
    intelEstado.selecionando = ligado;
    intelEstado.selecionados = new Set();
    intelDesenharControles();
    intelDesenharGrade();
  };
  intelPorId("selecionar").addEventListener("click", () => alternar(!intelEstado.selecionando));
  intelPorId("selCancelar").addEventListener("click", () => { alternar(false); });
  intelPorId("selTodos").addEventListener("click", () => intelSelecionarTodos(intelTelaApi));
  intelPorId("selDescartar").addEventListener("click", async () => {
    const itens = intelTelaApi.selecionados().map(key => intelEstado.itens.find(i => i.key === key) || { key, status: "nova" });
    intelEstado.selecionados = new Set();
    await intelDescartar(intelTelaApi, itens);
  });
  intelPorId("selApagar").addEventListener("click", async () => {
    const keys = intelTelaApi.selecionados();
    intelEstado.selecionados = new Set();
    if (!(await intelApagar(intelTelaApi, keys))) intelTelaApi.definirSelecao(keys);
  });
  intelPorId("selBaixar").addEventListener("click", () => intelBaixar(intelTelaApi, intelTelaApi.selecionados(), "selecao"));
}

function intelLigarPagina() {
  intelPorId("voltar").addEventListener("click", () => chrome.runtime.sendMessage({ action: "INTEL_VOLTAR" }));
  intelPorId("opcoes").addEventListener("click", e => { e.stopPropagation(); intelMenuGeral(e.currentTarget); });
  const irPara = passo => { intelEstado.pagina = Math.max(0, intelEstado.pagina + passo); intelCarregar().then(() => window.scrollTo({ top: 0 })); };
  intelPorId("anterior").addEventListener("click", () => irPara(-1));
  intelPorId("proxima").addEventListener("click", () => irPara(1));
  document.addEventListener("click", e => { if (!e.target.closest("#menu, .mais, #opcoes")) intelFecharMenu(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { intelFecharMenu(); intelFecharPainel(); } });
  let espera = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !intelEstado.fonte) return;
    const local = intelEstado.fonte.modo === "local" && (changes[VIVA_ACERVO_KEY] || changes.viva_team_meta);
    if (local) { clearTimeout(espera); espera = setTimeout(intelCarregar, 800); }
    if (changes.viva_team_code) { intelIniciarFonte(); return; }
    if (changes.viva_vault_info && intelEstado.fonte.modo === "banco") intelEstado.info = { ...intelEstado.info, ...changes.viva_vault_info.newValue };
    if (changes.viva_vault_info || changes.viva_espaco || changes.viva_espaco_progresso || changes.viva_team_radar) intelDesenharTopo();
  });
}

async function intelDesenharOpcoes() {
  const { termos, quem } = await intelEstado.fonte.opcoes();
  [["termo", termos, "Todos"], ["quem", quem, "Todos"]].forEach(([id, valores, todos]) => {
    const select = intelPorId(id);
    select.textContent = "";
    [["", todos], ...(valores || []).map(v => [v, v])].forEach(([valor, texto]) => {
      const op = intelNo("option", null, texto);
      op.value = valor;
      select.appendChild(op);
    });
    select.value = intelEstado.filtros[id];
  });
}

async function intelIniciarFonte() {
  try {
    intelEstado.fonte = await intelCriarFonte();
    await Promise.all([intelDesenharOpcoes(), intelCarregar()]);
  } catch (error) {
    intelDesenharErro(error);
  }
}

async function intelIniciar() {
  INTEL_NICHOS.forEach(nicho => {
    const op = intelNo("option", null, nicho === "Outro" ? "Fora dos nichos" : nicho);
    op.value = nicho;
    intelPorId("nicho").appendChild(op);
  });
  intelLerEndereco();
  intelLigarFiltros();
  intelLigarSelecao();
  intelLigarSalvos();
  intelLigarPagina();
  intelDesenharControles();
  // "Abrir a extensão" conta como acesso: se passou de 150 mil, a planilha baixa agora.
  chrome.runtime.sendMessage({ action: "ESPACO_ACESSO" }).catch(() => {});
  await intelLerSalvos();
  await intelIniciarFonte();
}

intelIniciar().catch(intelDesenharErro);
