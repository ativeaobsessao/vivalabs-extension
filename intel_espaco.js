// Espaço do banco da equipe: confere o total, avisa a equipe e, passando de 150 mil anúncios, baixa
// no próximo acesso a planilha completa do banco. NADA é apagado aqui: a limpeza é manual, no Centro.
// Carregado pelo background.js (depois de intel_core.js, export_data.js, team_sync.js, notify.js e auto_export.js).

const ESPACO_STORE = {
  estado: "viva_espaco",              // { avisadoNivel, avisoErroEm, baixadoEm, baixadoTotal, arquivos, erro, erroEm }
  progresso: "viva_espaco_progresso", // { lidos, em } enquanto a planilha completa é gerada
};
const ESPACO_LINHAS_POR_ARQUIVO = 25000;   // o Chrome não passa arquivos gigantes de uma vez
const ESPACO_PAGINA_LEITURA = 1000;
const ESPACO_MAX_PAGINAS = 1000;
const ESPACO_RETRY_MS = 10 * 60 * 1000;
const ESPACO_SELO = "150k";
const ESPACO_PLANO_URL = "https://supabase.com/pricing";
const ESPACO_PESO = { "": 0, ok: 0, atencao: 1, estourou: 2 };

let _espacoBaixando = null;
let _espacoFila = Promise.resolve();
let espacoDeps = { now: () => Date.now(), linhasPorArquivo: ESPACO_LINHAS_POR_ARQUIVO };
function espacoInit(deps) { espacoDeps = { ...espacoDeps, ...(deps || {}) }; }

async function espacoLerEstado() {
  const data = await chrome.storage.local.get(ESPACO_STORE.estado);
  const e = data[ESPACO_STORE.estado];
  return e && typeof e === "object" ? e : {};
}

async function espacoGravar(mudanca) {
  const atual = await espacoLerEstado();
  await chrome.storage.local.set({ [ESPACO_STORE.estado]: { ...atual, ...mudanca } });
}

async function espacoBaixarParte(parte, numero, formato) {
  const acervo = parte.map(l => l.rec);
  const meta = Object.fromEntries(parte.map(l => [acervoKey(l.rec), { by: l.by, status: l.status }]));
  const arquivo = await exportGerar(formato, acervo, meta, {
    origem: "Banco da equipe (limite de 150 mil anúncios)",
    recorte: `Parte ${numero} — ${acervo.length} criativos`,
    versao: chrome.runtime.getManifest().version,
  }, `banco-equipe-parte-${numero}`, espacoDeps.now());
  await aexpBaixar(arquivo.dados, arquivo.mime, arquivo.nome);
}

// Lê o banco inteiro (inclusive descartados) e baixa em partes na pasta Downloads/VivaSpy.
async function espacoLerEBaixar(codigo, formato) {
  const porArquivo = espacoDeps.linhasPorArquivo;
  const vistos = new Set();
  let parte = [];
  let cursor = 0;
  let arquivos = 0;
  for (let pagina = 0; pagina < ESPACO_MAX_PAGINAS; pagina += 1) {
    const linhas = await teamRpc("viva_pull", { p_token: codigo, p_since: cursor, p_limit: ESPACO_PAGINA_LEITURA });
    if (!Array.isArray(linhas) || !linhas.length) break;
    cursor = linhas.reduce((max, l) => Math.max(max, Number(l.seq) || 0), cursor);
    const novas = linhas.filter(l => l && l.rec && !vistos.has(l.key));
    novas.forEach(l => vistos.add(l.key));
    parte = parte.concat(novas);
    await chrome.storage.local.set({ [ESPACO_STORE.progresso]: { lidos: vistos.size, em: espacoDeps.now() } });
    while (parte.length >= porArquivo) {
      arquivos += 1;
      await espacoBaixarParte(parte.slice(0, porArquivo), arquivos, formato);
      parte = parte.slice(porArquivo);
    }
    if (linhas.length < ESPACO_PAGINA_LEITURA) break;
  }
  if (parte.length) { arquivos += 1; await espacoBaixarParte(parte, arquivos, formato); }
  if (!arquivos) throw new Error("O banco da equipe está vazio — nada para baixar.");
  return { arquivos, linhas: vistos.size };
}

function espacoBaixarTudo() {
  if (_espacoBaixando) return _espacoBaixando;
  _espacoBaixando = (async () => {
    try {
      const cfg = await teamConfig();
      if (!cfg) throw new Error("Conecte o código da equipe no popup.");
      const { formato } = await aexpLerConfig();
      const r = await espacoLerEBaixar(cfg.code, formato);
      await espacoGravar({ baixadoEm: espacoDeps.now(), baixadoTotal: r.linhas, arquivos: r.arquivos, erro: "", erroEm: 0 });
      return { status: "ok", ...r };
    } catch (error) {
      const msg = teamFriendlyError(error);
      await espacoGravar({ erro: msg, erroEm: espacoDeps.now() });
      console.warn(`[BG][ESPACO] planilha do banco falhou: ${msg}`);
      return { status: "error", error: msg };
    } finally {
      await chrome.storage.local.remove(ESPACO_STORE.progresso);
      _espacoBaixando = null;
    }
  })();
  return _espacoBaixando;
}

// Botões "Baixar planilha" (popup e Centro).
async function espacoBaixarAgora() {
  const r = await espacoBaixarTudo();
  return r.status === "ok" ? { ...r, nome: `${r.arquivos} arquivo(s) em Downloads/VivaSpy` } : r;
}

function espacoTextoAviso(total, nivel) {
  const n = intelNumero(total);
  if (nivel === "estourou") {
    return `⚠️ Viva Spy: o banco da equipe chegou a ${n} anúncios (limite de 150 mil) e está ficando sem espaço.\n`
      + "Baixem a planilha e apaguem manualmente, no Centro de Inteligência, os anúncios que não fazem parte do nosso modelo de negócio — "
      + `ou assinem o plano pago do banco: ${ESPACO_PLANO_URL}`;
  }
  return `Viva Spy: o banco da equipe está com ${n} de 150 mil anúncios. O espaço está acabando — comecem a apagar o que não serve.`;
}

// Discord/Telegram (se configurado neste computador): uma mensagem por nível.
async function espacoAvisarEquipe(total, nivel) {
  const estado = await espacoLerEstado();
  if (ESPACO_PESO[nivel] <= ESPACO_PESO[estado.avisadoNivel || ""]) return;
  if (estado.avisoErroEm && espacoDeps.now() - estado.avisoErroEm < ESPACO_RETRY_MS) return;
  const cfg = await notifLerConfig();
  if (cfg.tipo === "off" || notifValidar(cfg)) return;
  try {
    await notifEnviarTexto(cfg, espacoTextoAviso(total, nivel));
    await espacoGravar({ avisadoNivel: nivel, avisoErroEm: 0 });
  } catch (error) {
    await espacoGravar({ avisoErroEm: espacoDeps.now() });
    console.warn(`[BG][ESPACO] aviso à equipe não enviado: ${error.message}`);
  }
}

// Depois de uma limpeza de verdade (abaixo de 97% do limite), os avisos voltam a valer.
async function espacoRearmar(total) {
  const estado = await espacoLerEstado();
  const mudanca = {};
  if (total < INTEL_LIMITE * INTEL_REARME) {
    if (estado.baixadoEm) mudanca.baixadoEm = 0;
    if (estado.avisadoNivel === "estourou") mudanca.avisadoNivel = "atencao";
  }
  if (total < INTEL_ATENCAO * INTEL_REARME && estado.avisadoNivel) mudanca.avisadoNivel = "";
  if (Object.keys(mudanca).length) await espacoGravar(mudanca);
}

// Selo vermelho no ícone da extensão. Só apaga o selo que ele mesmo colocou.
async function espacoSelo(nivel) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  if (nivel === "estourou") {
    await chrome.action.setBadgeBackgroundColor({ color: "#ff3b30" });
    await chrome.action.setBadgeText({ text: ESPACO_SELO });
  } else if ((await chrome.action.getBadgeText({})) === ESPACO_SELO) {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function espacoBaixarSeForHora(total) {
  if (total < INTEL_LIMITE || !(await aexpLerConfig()).auto) return;
  const estado = await espacoLerEstado();
  if (estado.baixadoEm || (estado.erroEm && espacoDeps.now() - estado.erroEm < ESPACO_RETRY_MS)) return;
  await espacoBaixarTudo();
}

// acesso = alguém abriu a extensão (popup, Centro ou Meta Ad Library). Só aí a planilha baixa sozinha.
async function _espacoVerificar(acesso) {
  const cfg = await teamConfig();
  let info = null;
  if (cfg) info = acesso ? await teamVaultInfo(cfg) : (await chrome.storage.local.get(TEAM_STORE.vault))[TEAM_STORE.vault];
  if (!info) { await espacoSelo("ok"); return { status: "local" }; }
  const nivel = intelNivelEspaco(info.total, info.bytes);
  await espacoRearmar(info.total);
  await espacoSelo(nivel);
  if (nivel !== "ok") await espacoAvisarEquipe(info.total, nivel);
  if (acesso) await espacoBaixarSeForHora(info.total);
  return { status: "ok", nivel, total: info.total };
}

// Uma verificação por vez (popup, Centro e sincronização podem pedir juntos).
function espacoVerificar(opcoes) {
  const acesso = Boolean(opcoes && opcoes.acesso);
  const run = _espacoFila.then(() => _espacoVerificar(acesso))
    .catch(error => ({ status: "error", error: teamFriendlyError(error) }));
  _espacoFila = run;
  return run;
}

function espacoRegistrarEventos() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[TEAM_STORE.vault]) espacoVerificar({ acesso: false });
    });
  } catch (error) {
    console.warn(`[BG][ESPACO] eventos indisponíveis: ${error.message}`);
  }
}
