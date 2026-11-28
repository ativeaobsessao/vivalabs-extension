// Ações do Centro: descartar (com "Desfazer"), apagar de verdade, bloquear, planilha e seleção.
// Todas recebem `tela` = { fonte, recarregar(), filtros(), selecionados(), definirSelecao(keys) }.
// Depende de intel_core.js, export_data.js, intel_source.js, intel_view.js e intel_panel.js.

const INTEL_LINHAS_POR_ARQUIVO = 25000;

function intelPlural(n, um, varios) {
  return `${intelNumero(n)} ${n === 1 ? um : varios}`;
}

// Executa, recarrega a tela e mostra o erro (sem sumir com ele) se algo falhar.
async function intelExecutar(tela, tarefa) {
  try {
    await tarefa();
    return true;
  } catch (error) {
    intelToast(`Não deu certo: ${teamFriendlyError(error)}`, { erro: true });
    return false;
  } finally {
    await tela.recarregar();
  }
}

async function intelDesfazerStatus(tela, anteriores) {
  await intelExecutar(tela, async () => {
    const porStatus = new Map();
    anteriores.forEach(({ key, status }) => porStatus.set(status, [...(porStatus.get(status) || []), key]));
    for (const [status, keys] of porStatus) await tela.fonte.marcar(keys, status);
  });
}

// itens = [{ key, status }]
async function intelDescartar(tela, itens) {
  const anteriores = itens.map(i => ({ key: i.key, status: i.status || "nova" }));
  const ok = await intelExecutar(tela, () => tela.fonte.marcar(anteriores.map(i => i.key), "descartada"));
  if (ok) intelToast(intelPlural(itens.length, "anúncio descartado", "anúncios descartados"), { desfazer: () => intelDesfazerStatus(tela, anteriores) });
}

async function intelMudarStatus(tela, key, status) {
  const ok = await intelExecutar(tela, () => tela.fonte.marcar([key], status));
  if (ok) intelToast(`Status: ${INTEL_STATUS_ROTULOS[status]}`);
}

async function intelMudarNicho(tela, key, nicho) {
  const ok = await intelExecutar(tela, () => tela.fonte.definirNicho(key, nicho));
  if (ok) intelToast(`Nicho: ${nicho}`);
}

function intelOndeApaga(tela) {
  return tela.fonte.modo === "banco" ? "Sai do banco para a equipe inteira" : "Sai deste computador";
}

async function intelApagar(tela, keys) {
  if (!keys.length) return false;
  const confirmou = await intelConfirmarPagina({
    titulo: `Apagar ${intelPlural(keys.length, "anúncio", "anúncios")}?`,
    mensagem: `${intelOndeApaga(tela)}, libera espaço e não volta a ser coletado.\nNão dá para desfazer.`,
    confirmar: "Apagar definitivamente", perigo: true,
  });
  if (!confirmou) return false;
  return intelExecutar(tela, async () => {
    await tela.fonte.apagar(keys);
    intelToast(intelPlural(keys.length, "anúncio apagado", "anúncios apagados"));
  });
}

async function intelApagarTodosDescartados(tela, quantos) {
  if (!quantos) { intelToast("Não há descartados para apagar."); return; }
  const confirmou = await intelConfirmarPagina({
    titulo: `Apagar ${intelPlural(quantos, "descartado", "descartados")}?`,
    mensagem: `${intelOndeApaga(tela)}, libera espaço e não volta a ser coletado.\nNão dá para desfazer.`,
    confirmar: "Apagar definitivamente", perigo: true,
  });
  if (!confirmou) return;
  await intelExecutar(tela, async () => {
    const n = await tela.fonte.apagarDescartados((feitos, restam) => intelToast(`Apagando… ${intelNumero(feitos)} (faltam ${intelNumero(restam)})`));
    intelToast(intelPlural(n, "anúncio apagado", "anúncios apagados"));
  });
}

async function intelBloquear(tela, alvo, nome) {
  if (!alvo) return false;
  const confirmou = await intelConfirmarPagina({
    titulo: `Bloquear “${nome}”?`,
    mensagem: `${intelOndeApaga(tela)} tudo o que é dele, e nada dele volta a ser coletado.\nDá para liberar depois em ⋯ → Liberar bloqueados (o que foi apagado não volta sozinho).`,
    confirmar: "Bloquear e apagar", perigo: true,
  });
  if (!confirmou) return false;
  return intelExecutar(tela, async () => {
    const n = await tela.fonte.bloquear(alvo);
    intelToast(`Bloqueado · ${intelPlural(n, "anúncio apagado", "anúncios apagados")}`);
  });
}

async function intelLiberarBloqueados(tela) {
  const ok = await intelExecutar(tela, () => tela.fonte.desbloquear());
  if (ok) intelToast("Bloqueados liberados: podem voltar a ser coletados.");
}

async function intelLimparComputador(tela) {
  const confirmou = await intelConfirmarPagina({
    titulo: "Apagar os anúncios deste computador?",
    mensagem: "Limpa só o que está guardado neste computador. O banco da equipe não é apagado.",
    confirmar: "Apagar deste computador", perigo: true,
  });
  if (!confirmou) return;
  await intelExecutar(tela, () => chrome.runtime.sendMessage({ action: "ACERVO_CLEAR" }));
}

// registros = [{ rec, by, status }]
async function intelBaixarRegistros(registros, rotulo, recorte) {
  const cfg = await intelLerLocal("viva_export_config", {});
  const formato = cfg.formato === "csv" ? "csv" : "xlsx";
  const partes = intelLotes(registros, INTEL_LINHAS_POR_ARQUIVO);
  for (let i = 0; i < partes.length; i += 1) {
    const acervo = partes[i].map(r => r.rec);
    const meta = Object.fromEntries(partes[i].map(r => [acervoKey(r.rec), { by: r.by, status: r.status }]));
    const arquivo = await exportGerar(formato, acervo, meta, {
      origem: "Download manual (Centro de Inteligência)", recorte, versao: chrome.runtime.getManifest().version,
    }, partes.length > 1 ? `${rotulo}-parte-${i + 1}` : rotulo);
    const url = URL.createObjectURL(new Blob([arquivo.dados], { type: arquivo.mime }));
    await chrome.downloads.download({ url, filename: `VivaSpy/${arquivo.nome}`, saveAs: false, conflictAction: "uniquify" });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function intelBaixar(tela, keys, rotulo) {
  if (!keys.length) { intelToast("Não há anúncios para baixar."); return; }
  intelToast(`Preparando a planilha de ${intelPlural(keys.length, "anúncio", "anúncios")}…`);
  try {
    await intelBaixarRegistros(await tela.fonte.registros(keys), rotulo, `${keys.length} anúncios escolhidos no Centro`);
    intelToast("Planilha salva em Downloads/VivaSpy.");
  } catch (error) {
    intelToast(`Não consegui baixar: ${teamFriendlyError(error)}`, { erro: true });
  }
}

// Banco inteiro (ou o acervo do computador): quem gera é o background, em partes.
async function intelBaixarTudo() {
  intelToast("Preparando a planilha completa… pode levar alguns minutos.");
  try {
    const r = await chrome.runtime.sendMessage({ action: "EXPORT_NOW" });
    if (!r || r.status !== "ok") throw new Error((r && r.error) || "sem resposta da extensão");
    intelToast("Planilha salva em Downloads/VivaSpy.");
  } catch (error) {
    intelToast(`Não consegui baixar: ${error.message}`, { erro: true });
  }
}

async function intelSelecionarTodos(tela) {
  try {
    const keys = await tela.fonte.chaves(tela.filtros());
    tela.definirSelecao(keys);
    if (keys.length >= 20000) intelToast("Selecionados os 20.000 primeiros do filtro (limite por vez).");
  } catch (error) {
    intelToast(`Não consegui selecionar: ${teamFriendlyError(error)}`, { erro: true });
  }
}
