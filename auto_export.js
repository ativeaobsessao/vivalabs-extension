// Planilha automática: quando o acervo chega ao teto (10.000 criativos), o Viva Spy baixa sozinho um
// XLSX (ou CSV) com tudo, na pasta Downloads/VivaSpy. Depois repete a cada 5.000 criativos NOVOS.
// Também atende o botão "Baixar planilha agora" do popup.
// Carregado pelo background.js via importScripts (depende de ranking_engine.js e export_data.js).

const AEXP_STORE = {
  config: "viva_export_config",   // { auto: boolean (padrão: true), formato: "xlsx" | "csv" }
  state: "viva_export_state",     // { lastAt, lastCount, lastNome, lastFormato, lastOrigem, lastError, lastErrorAt }
};
const AEXP_LIMITE = VIVA_ACERVO_MAX;           // 10.000
const AEXP_REPETIR_APOS_NOVOS = 5000;
const AEXP_DEBOUNCE_MS = 6000;
const AEXP_RETRY_ERRO_MS = 10 * 60 * 1000;
const AEXP_PASTA = "VivaSpy";

let _aexpTimer = null;
let _aexpRodando = null;
let aexpDeps = { now: () => Date.now() };
function aexpInit(deps) { aexpDeps = { ...aexpDeps, ...(deps || {}) }; }

async function aexpLerConfig() {
  const data = await chrome.storage.local.get(AEXP_STORE.config);
  const c = data[AEXP_STORE.config] && typeof data[AEXP_STORE.config] === "object" ? data[AEXP_STORE.config] : {};
  return { auto: c.auto !== false, formato: c.formato === "csv" ? "csv" : "xlsx" };
}

async function aexpLerEstado() {
  const data = await chrome.storage.local.get(AEXP_STORE.state);
  return data[AEXP_STORE.state] && typeof data[AEXP_STORE.state] === "object" ? data[AEXP_STORE.state] : {};
}

function aexpBase64(bytes) {
  let bin = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
  return btoa(bin);
}

async function aexpGarantirOffscreen() {
  const contexts = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }) : [];
  if (contexts && contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Criar o arquivo da planilha (blob) para o download automático.",
  });
}

// Baixa os bytes como arquivo em Downloads/VivaSpy/<nome>. Devolve o id do download.
async function aexpBaixar(dados, mime, nome) {
  await aexpGarantirOffscreen();
  const resp = await chrome.runtime.sendMessage({ target: "offscreen", action: "BLOB_URL", base64: aexpBase64(dados), mime });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "Não consegui preparar o arquivo.");
  try {
    const id = await chrome.downloads.download({ url: resp.url, filename: `${AEXP_PASTA}/${nome}`, saveAs: false, conflictAction: "uniquify" });
    // libera o blob depois de um tempo (o Chrome já copiou para o disco); fecha o documento auxiliar
    setTimeout(() => {
      chrome.runtime.sendMessage({ target: "offscreen", action: "REVOKE", url: resp.url }).catch(() => {})
        .finally(() => { try { chrome.offscreen.closeDocument().catch(() => {}); } catch (_) { /* nada */ } });
    }, 3 * 60 * 1000);
    return id;
  } catch (error) {
    chrome.runtime.sendMessage({ target: "offscreen", action: "REVOKE", url: resp.url }).catch(() => {});
    throw error;
  }
}

async function aexpGerarEBaixar(origem, rotulo) {
  const cfg = await aexpLerConfig();
  const dados = await chrome.storage.local.get([VIVA_ACERVO_KEY, "viva_team_meta"]);
  const acervo = Array.isArray(dados[VIVA_ACERVO_KEY]) ? dados[VIVA_ACERVO_KEY] : [];
  if (acervo.length === 0) throw new Error("O acervo está vazio — nada para baixar.");
  const agora = aexpDeps.now();
  const arquivo = await exportGerar(cfg.formato, acervo, dados.viva_team_meta, {
    origem,
    recorte: `Acervo inteiro (${acervo.length} criativos)`,
    versao: chrome.runtime.getManifest().version,
  }, rotulo, agora);
  await aexpBaixar(arquivo.dados, arquivo.mime, arquivo.nome);
  return { nome: arquivo.nome, linhas: arquivo.linhas, formato: cfg.formato, at: agora };
}

// Verifica se é hora do download automático. Seguro para chamar à vontade (não roda duas vezes ao mesmo tempo).
function aexpVerificar() {
  if (_aexpRodando) return _aexpRodando;
  _aexpRodando = (async () => {
    try {
      const cfg = await aexpLerConfig();
      if (!cfg.auto) return { status: "off" };
      const dados = await chrome.storage.local.get(VIVA_ACERVO_KEY);
      const acervo = Array.isArray(dados[VIVA_ACERVO_KEY]) ? dados[VIVA_ACERVO_KEY] : [];
      if (acervo.length < AEXP_LIMITE) return { status: "abaixo", total: acervo.length };
      const estado = await aexpLerEstado();
      const agora = aexpDeps.now();
      if (estado.lastErrorAt && agora - estado.lastErrorAt < AEXP_RETRY_ERRO_MS) return { status: "aguardando" };
      if (estado.lastAt) {
        const novos = acervo.filter(c => (Number(c.firstSeen) || 0) > estado.lastAt).length;
        if (novos < AEXP_REPETIR_APOS_NOVOS) return { status: "ja-baixado", novos };
      }
      try {
        const r = await aexpGerarEBaixar(`Download automático (acervo chegou a ${AEXP_LIMITE.toLocaleString("pt-BR")} criativos)`, "acervo-completo");
        await chrome.storage.local.set({ [AEXP_STORE.state]: { lastAt: r.at, lastCount: r.linhas, lastNome: r.nome, lastFormato: r.formato, lastOrigem: "auto", lastError: "", lastErrorAt: 0 } });
        console.log(`[BG][EXPORT] planilha automática baixada: ${r.nome}`);
        return { status: "baixado", ...r };
      } catch (error) {
        await chrome.storage.local.set({ [AEXP_STORE.state]: { ...estado, lastError: error.message, lastErrorAt: agora } });
        console.warn(`[BG][EXPORT] download automático falhou: ${error.message}`);
        return { status: "error", error: error.message };
      }
    } finally {
      _aexpRodando = null;
    }
  })();
  return _aexpRodando;
}

// Botão "Baixar planilha agora" (popup): baixa o acervo inteiro na hora.
async function aexpBaixarAgora() {
  try {
    const r = await aexpGerarEBaixar("Download manual (popup)", "acervo-completo");
    const estado = await aexpLerEstado();
    await chrome.storage.local.set({ [AEXP_STORE.state]: { ...estado, lastAt: r.at, lastCount: r.linhas, lastNome: r.nome, lastFormato: r.formato, lastOrigem: "manual", lastError: "", lastErrorAt: 0 } });
    return { status: "ok", nome: r.nome, linhas: r.linhas };
  } catch (error) {
    return { status: "error", error: error.message };
  }
}

function aexpAgendarVerificacao() {
  clearTimeout(_aexpTimer);
  _aexpTimer = setTimeout(() => { aexpVerificar().catch(error => console.warn(`[BG][EXPORT] ${error.message}`)); }, AEXP_DEBOUNCE_MS);
}

function aexpRegistrarEventos() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[VIVA_ACERVO_KEY]) aexpAgendarVerificacao();
    });
  } catch (error) {
    console.warn(`[BG][EXPORT] eventos indisponíveis: ${error.message}`);
  }
}
