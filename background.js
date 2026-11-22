// Viva Spy - Background Service Worker

importScripts("intelligent_parser.js", "ranking_engine.js", "export_data.js", "team_sync.js", "notify.js", "auto_export.js", "radar.js");
console.info("[VIVA] Infra inteligente instalada - parser + fila + ranking");

// Regra dinâmica ID para declarativeNetRequest (Mobile User-Agent)
const MOBILE_RULE_ID = 2468;

// Configurar regra para emular iPhone em abas com "?viva_mobile=true" ou "&viva_mobile=true"
async function setupMobileUserAgentRule() {
  try {
    const rule = {
      id: MOBILE_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "User-Agent",
            operation: "set",
            value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"
          }
        ]
      },
      condition: {
        urlFilter: "*viva_mobile=true*",
        resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "xmlhttprequest"]
      }
    };

    // Remove regra anterior se houver, e adiciona a nova
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [MOBILE_RULE_ID],
      addRules: [rule]
    });
    console.log("[BG] Regra de emulação Mobile registrada com sucesso.");
  } catch (err) {
    console.error("[BG] Erro ao registrar regra de User-Agent:", err);
  }
}

// Inicializa no startup
chrome.runtime.onInstalled.addListener(() => {
  setupMobileUserAgentRule();
});
chrome.runtime.onStartup.addListener(() => {
  setupMobileUserAgentRule();
});

// ─── FIX ITEM 9 (2026-08): Fila de downloads persistida (sobrevive à suspensão do SW) ───────
// Antes, downloadQueue/isDownloading eram variáveis de módulo — memória viva só enquanto o
// service worker está de pé. Manifest V3 pode suspender o service worker a qualquer momento de
// inatividade (não existe garantia de "ficar vivo até terminar o lote"); se isso acontecesse no
// meio de um lote de downloads, a fila em RAM sumia com o worker e os itens restantes nunca
// eram baixados — silenciosamente, sem erro nem log, porque não havia mais nada rodando para
// reclamar.
//
// A correção: a fila em si mora em chrome.storage.local (sobrevive a qualquer suspensão/
// reinício do worker), e o processamento é retomado automaticamente sempre que o worker
// acorda — o que, em MV3, acontece de novo a cada evento recebido (mensagem, startup, install),
// já que o script inteiro é reexecutado do zero a cada wake-up. Por isso um único
// processQueue() no fim deste arquivo (module scope) já cobre todos os pontos de entrada, sem
// precisar duplicar a chamada em cada listener.
const DOWNLOAD_QUEUE_KEY = "viva_download_queue";
let isDownloading = false; // lock só para não iniciar 2 loops concorrentes NESTA vida do worker

async function getQueue() {
  const data = await chrome.storage.local.get(DOWNLOAD_QUEUE_KEY);
  return Array.isArray(data[DOWNLOAD_QUEUE_KEY]) ? data[DOWNLOAD_QUEUE_KEY] : [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [DOWNLOAD_QUEUE_KEY]: queue });
}

async function enqueueDownload(task) {
  const queue = await getQueue();
  queue.push(task);
  await setQueue(queue);
}

function downloadOne(task) {
  return new Promise((resolve) => {
    chrome.downloads.download({
      url: task.url,
      filename: task.filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("[BG] Download falhou:", chrome.runtime.lastError.message);
      } else {
        console.log("[BG] Download iniciado ID:", downloadId);
      }
      resolve();
    });
  });
}

async function processQueue() {
  if (isDownloading) return; // já tem um loop rodando nesta vida do worker
  isDownloading = true;
  try {
    // Loop lê a fila persistida a cada volta — se o worker for suspenso e acordar de novo no
    // meio do lote, o próximo processQueue() (disparado pelo wake-up) simplesmente continua
    // de onde a fila em storage indicar, sem precisar de nenhum estado em memória sobrevivente.
    while (true) {
      const queue = await getQueue();
      if (queue.length === 0) break;

      const task = queue[0];
      await downloadOne(task);

      // Remove o item recém-processado (sempre o primeiro, fila FIFO) — reconsulta a fila
      // antes de gravar para não perder itens que tenham sido enfileirados nesse meio-tempo.
      const freshQueue = await getQueue();
      freshQueue.shift();
      await setQueue(freshQueue);

      // Throttle de 500ms entre downloads, igual ao comportamento original.
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    isDownloading = false;
  }
}

// ─── Fila persistida da mineração inteligente ────────────────────────────────
const INTELIGENTE_QUEUE_KEY = "viva_inteligente_queue";
const INTELIGENTE_RESULTADOS_KEY = "viva_inteligente_resultados";
const INTELIGENTE_IDX_KEY = "viva_inteligente_idx";
const INTELIGENTE_STATE_KEY = "viva_inteligente_state";
const INTELIGENTE_STATUS_KEY = "viva_inteligente_status";
let isMinerando = false;
const MINER_MAX_PARALLEL = 2;

async function getInteligenteQueue() {
  const data = await chrome.storage.local.get(INTELIGENTE_QUEUE_KEY);
  return Array.isArray(data[INTELIGENTE_QUEUE_KEY]) ? data[INTELIGENTE_QUEUE_KEY] : [];
}

async function setInteligenteQueue(queue) {
  await chrome.storage.local.set({ [INTELIGENTE_QUEUE_KEY]: queue });
}

async function getInteligenteResultados() {
  const data = await chrome.storage.local.get(INTELIGENTE_RESULTADOS_KEY);
  return data[INTELIGENTE_RESULTADOS_KEY] && typeof data[INTELIGENTE_RESULTADOS_KEY] === "object"
    ? data[INTELIGENTE_RESULTADOS_KEY]
    : {};
}

async function setInteligenteResultados(results) {
  await chrome.storage.local.set({ [INTELIGENTE_RESULTADOS_KEY]: results });
}

async function getInteligenteIdx() {
  const data = await chrome.storage.local.get(INTELIGENTE_IDX_KEY);
  return Number.isInteger(data[INTELIGENTE_IDX_KEY]) ? data[INTELIGENTE_IDX_KEY] : 0;
}

async function setInteligenteIdx(index) {
  await chrome.storage.local.set({ [INTELIGENTE_IDX_KEY]: index });
}

async function getInteligenteState() {
  const data = await chrome.storage.local.get(INTELIGENTE_STATE_KEY);
  return data[INTELIGENTE_STATE_KEY] || null;
}

async function setInteligenteState(state) {
  await chrome.storage.local.set({ [INTELIGENTE_STATE_KEY]: state });
  await chrome.storage.local.set({
    [INTELIGENTE_STATUS_KEY]: {
      status: state.status,
      runId: state.runId,
      index: Number(state.idx ?? state.index) || 0,
      total: state.total,
      paused: Boolean(state.paused),
      nextIndex: Number(state.nextIndex) || 0,
      error: state.error || null,
      updatedAt: new Date().toISOString(),
    },
  });
}

// IMPORTANTE: chrome.runtime.sendMessage disparado do service worker NÃO chega nos content
// scripts (só em popup/páginas da extensão) — por isso progresso/ranking nunca apareciam na tela.
// O canal que funciona é o storage: o content script escuta chrome.storage.onChanged.
function notifyInteligente(message) {
  chrome.storage.local
    .set({ viva_inteligente_progress: { ...message, ts: Date.now() } })
    .catch(error => console.warn("[BG] Não foi possível publicar o progresso:", error.message));
}

const FUNIL_SEQUENCE_API_BASE = "https://app.vivalabs.com.br";

function countAdsStages(funis) {
  const adsLabels = [];
  for (const funil of Array.isArray(funis) ? funis : []) {
    for (const etapa of Array.isArray(funil.etapas) ? funil.etapas : []) {
      const tipo = String(etapa.tipo || "").toUpperCase();
      const rotulo = String(etapa.rotulo || "");
      if (tipo === "ADS" || /^ads\d+$/i.test(rotulo)) adsLabels.push(rotulo);
    }
  }
  return {
    count: adsLabels.length,
    maxNumber: adsLabels.reduce((max, label) => {
      const match = label.match(/^ads(\d+)$/i);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0),
  };
}

async function getNextFunilSequence(pageId) {
  if (!/^\d{1,20}$/.test(String(pageId || ""))) {
    throw new Error("Identificador de biblioteca inválido para sequência de funil.");
  }

  const storageKey = `viva_seq_${pageId}`;
  const stored = await chrome.storage.local.get(storageKey);
  const localCount = Math.max(0, Number(stored[storageKey]?.count) || 0);
  let backendSequence = null;
  let totalAtivos = Number(stored[storageKey]?.total) || 0;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const authData = await chrome.storage.local.get("viva_auth_token");
    const headers = {};
    if (authData.viva_auth_token) {
      headers.Authorization = `Bearer ${authData.viva_auth_token}`;
    }
    const response = await fetch(
      `${FUNIL_SEQUENCE_API_BASE}/api/funis-operacionais/biblioteca/${encodeURIComponent(pageId)}`,
      { cache: "no-store", headers, signal: controller.signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const funis = Array.isArray(data) ? data : (Array.isArray(data.funis) ? data.funis : []);
    const { count, maxNumber } = countAdsStages(funis);
    backendSequence = Math.max(count, maxNumber);
    totalAtivos = Number(data.total_criativos_ativos) || totalAtivos;
  } catch (error) {
    console.warn(`[BG] Sequencial de funil do backend indisponível para ${pageId}; usando contador local:`, error.message);
  } finally {
    clearTimeout(timeoutId);
  }

  const currentCount = Math.max(localCount, backendSequence || 0);
  return {
    proximo: `ads${String(currentCount + 1).padStart(2, "0")}`,
    total_ativos: totalAtivos,
    source: backendSequence === null ? "local" : "backend",
  };
}

async function incrementFunilSequence(pageId, incrementBy = 1, total = 0, labels = []) {
  if (!/^\d{1,20}$/.test(String(pageId || ""))) {
    throw new Error("Identificador de biblioteca inválido para incrementar sequência.");
  }
  const key = `viva_seq_${pageId}`;
  const stored = await chrome.storage.local.get(key);
  const current = stored[key] && typeof stored[key] === "object" ? stored[key] : {};
  const amount = Math.max(1, Math.floor(Number(incrementBy) || 1));
  const maxLabel = (Array.isArray(labels) ? labels : []).reduce((max, label) => {
    const match = String(label).match(/^ads(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const count = Math.max((Number(current.count) || 0) + amount, maxLabel);
  await chrome.storage.local.set({
    [key]: {
      count,
      total: Math.max(Number(total) || 0, Number(current.total) || 0),
    },
  });
  return { count };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEscalaMineracao(stage) {
  if (stage === "bruta") return "ESCALA BRUTA";
  if (stage === "potencial") return "POTENCIAL ESCALA";
  if (stage === "teste") return "CAMPANHA NORMAL";
  return "";
}

// ─── Mineração: janelas, contexto por aba, acervo ───────────────────────────────────────────
const MINER_GRACE_MS = 25000; // folga além do tempo por busca (carregamento da página + flush final)
let acervoWriteChain = Promise.resolve();

function listarTarefasAtivas(state) {
  if (Array.isArray(state?.active)) return state.active;
  return state?.active ? [state.active] : [];
}

// Abre a busca numa JANELA pequena (não numa aba oculta): abas em segundo plano têm o render
// pausado pelo Chrome, então a Meta nunca carregava mais que o primeiro lote de anúncios.
async function criarJanelaMineracao(url, slot) {
  try {
    const win = await chrome.windows.create({
      url,
      type: "popup",
      focused: false,
      width: 1100,
      height: 820,
      left: 30 + slot * 70,
      top: 50 + slot * 50,
    });
    const tab = win.tabs && win.tabs[0];
    if (tab) return { tabId: tab.id, windowId: win.id };
  } catch (error) {
    console.warn(`[BG] Janela de mineração indisponível, usando aba: ${error.message}`);
  }
  const tab = await chrome.tabs.create({ url, active: false });
  return { tabId: tab.id, windowId: null };
}

async function fecharTarefaMineracao(task) {
  if (!task) return;
  if (task.windowId) {
    try {
      await chrome.windows.remove(task.windowId);
      return;
    } catch (error) {
      console.warn(`[BG] Janela ${task.windowId} já fechada: ${error.message}`);
    }
  }
  try {
    await chrome.tabs.remove(task.tabId);
  } catch (error) {
    console.warn(`[BG] Aba ${task.tabId} já fechada: ${error.message}`);
  }
}

// O content script da aba de mineração pergunta "sou uma aba de mineração?" — a resposta vem do
// tabId (confiável), não de parâmetros na URL, que a Meta pode reescrever durante a navegação.
async function obterContextoMineracao(sender) {
  const state = await getInteligenteState();
  if (!state || state.status !== "running") return null;
  const tabId = sender.tab && sender.tab.id;
  const task = listarTarefasAtivas(state).find(item => item.tabId === tabId);
  if (!task) return null;
  const queue = await getInteligenteQueue();
  const plan = queue[task.index];
  if (!plan) return null;
  return {
    runId: state.runId,
    planId: task.planId,
    q: plan.q,
    tempoPorBusca: Math.max(20, Number(state.tempoPorBusca) || 60),
    modoRapido: Boolean(state.modoRapido),
  };
}

async function marcarMineracaoConcluida(message, sender) {
  const state = await getInteligenteState();
  if (!state || state.status !== "running" || message.runId !== state.runId) return { status: "ignored" };
  const active = listarTarefasAtivas(state).map(task => ({ ...task }));
  const task = active.find(item => item.tabId === (sender.tab && sender.tab.id) && item.planId === message.planId);
  if (!task) return { status: "ignored" };
  task.done = true;
  console.log(`[BG][DIAG-M3] busca ${task.planId} concluída pela aba (${message.motivo || "?"}, ${message.cards || 0} anúncios)`);
  await setInteligenteState({ ...state, active });
  return { status: "ok" };
}

async function relatarProgressoMineracao(message, sender) {
  const state = await getInteligenteState();
  if (!state || state.status !== "running" || message.runId !== state.runId) return { status: "ignored" };
  const task = listarTarefasAtivas(state).find(item => item.tabId === (sender.tab && sender.tab.id));
  if (!task) return { status: "ignored" };
  const queue = await getInteligenteQueue();
  const plan = queue[task.index];
  notifyInteligente({
    action: "PROGRESSO_INTELIGENTE",
    texto: `${Number(state.idx) || 0}/${queue.length} concluídas · lendo "${plan ? plan.q : "?"}": ${Number(message.cards) || 0} anúncios · ${Number(message.escala) || 0} em escala`,
    status: "running",
  });
  return { status: "ok" };
}

// Escrita serializada: vários content scripts (aba do operador + janelas de mineração) enviam
// criativos ao mesmo tempo — sem a fila, um sobrescreveria o outro.
function upsertAcervo(creatives) {
  const run = acervoWriteChain.then(async () => {
    const data = await chrome.storage.local.get([VIVA_ACERVO_KEY, VIVA_LIXEIRA_KEY]);
    const lixeira = lixeiraNormalizar(data[VIVA_LIXEIRA_KEY]);
    const bloqueio = lixeiraConjuntos(lixeira);
    const resultado = mesclarAcervo(data[VIVA_ACERVO_KEY], creatives, Date.now(), undefined, lixeira);
    await chrome.storage.local.set({ [VIVA_ACERVO_KEY]: resultado.acervo });
    // Cofre da equipe: marca o que mudou para ser enviado no próximo ciclo (só se a equipe estiver configurada).
    try {
      if (await teamConfig()) {
        const chaves = (Array.isArray(creatives) ? creatives : []).map(sanitizarCriativo).filter(c => c && !lixeiraBloqueia(bloqueio, c)).map(acervoKey).filter(Boolean);
        await teamMarkDirtyRaw(chaves);
        teamAgendarSync();
      }
    } catch (error) {
      console.warn(`[BG][TEAM] não foi possível marcar para sincronizar: ${error.message}`);
    }
    console.log(`[BG][DIAG-A2] acervo: +${resultado.adicionados} novos, ${resultado.atualizados} atualizados, total ${resultado.acervo.length}`);
    return { status: "ok", total: resultado.acervo.length, adicionados: resultado.adicionados };
  });
  acervoWriteChain = run.catch(() => {});
  return run;
}

function limparAcervo() {
  const run = acervoWriteChain.then(async () => {
    // Limpa só a visão LOCAL (acervo, fila de envio e etiquetas). O cofre da equipe não é apagado.
    await chrome.storage.local.remove([VIVA_ACERVO_KEY, TEAM_STORE.dirty, TEAM_STORE.dirtyStatus, TEAM_STORE.meta]);
    return { status: "ok" };
  });
  acervoWriteChain = run.catch(() => {});
  return run;
}

// Apaga criativos / bibliotecas / ofertas (por domínio) do acervo LOCAL. Com `bloquear`, guarda o
// que foi apagado na lixeira para o motor e a sincronização da equipe não trazerem de volta.
// O cofre da equipe não é alterado (o lixo de um minerador pode ser ouro de outro).
function apagarDoAcervo(pedido) {
  const alvo = {
    chaves: Array.isArray(pedido && pedido.chaves) ? pedido.chaves.map(String).slice(0, 20000) : [],
    paginas: Array.isArray(pedido && pedido.paginas) ? pedido.paginas.map(String).slice(0, 5000) : [],
    dominios: Array.isArray(pedido && pedido.dominios) ? pedido.dominios.map(String).slice(0, 3000) : [],
  };
  const bloquear = !pedido || pedido.bloquear !== false;
  const run = acervoWriteChain.then(async () => {
    const data = await chrome.storage.local.get([VIVA_ACERVO_KEY, VIVA_LIXEIRA_KEY, TEAM_STORE.dirty, TEAM_STORE.dirtyStatus, TEAM_STORE.meta]);
    const acervo = Array.isArray(data[VIVA_ACERVO_KEY]) ? data[VIVA_ACERVO_KEY] : [];
    const { acervo: restante, removidos } = acervoRemover(acervo, alvo);
    const gone = new Set(removidos);
    const escrita = { [VIVA_ACERVO_KEY]: restante };
    let lixeira = lixeiraNormalizar(data[VIVA_LIXEIRA_KEY]);
    if (bloquear) {
      lixeira = lixeiraAdicionar(lixeira, alvo, Date.now());
      escrita[VIVA_LIXEIRA_KEY] = lixeira;
    }
    if (gone.size) {
      if (Array.isArray(data[TEAM_STORE.dirty])) escrita[TEAM_STORE.dirty] = data[TEAM_STORE.dirty].filter(k => !gone.has(k));
      if (Array.isArray(data[TEAM_STORE.dirtyStatus])) escrita[TEAM_STORE.dirtyStatus] = data[TEAM_STORE.dirtyStatus].filter(k => !gone.has(k));
      if (data[TEAM_STORE.meta] && typeof data[TEAM_STORE.meta] === "object") {
        const meta = { ...data[TEAM_STORE.meta] };
        gone.forEach(k => { delete meta[k]; });
        escrita[TEAM_STORE.meta] = meta;
      }
    }
    await chrome.storage.local.set(escrita);
    return { status: "ok", removidos: removidos.length, total: restante.length, bloqueados: lixeira.chaves.length + lixeira.paginas.length + lixeira.dominios.length };
  });
  acervoWriteChain = run.catch(() => {});
  return run;
}

// Esvazia a lista de bloqueio (o que foi apagado volta a ser coletado normalmente).
function limparLixeira() {
  const run = acervoWriteChain.then(async () => {
    await chrome.storage.local.remove(VIVA_LIXEIRA_KEY);
    return { status: "ok" };
  });
  acervoWriteChain = run.catch(() => {});
  return run;
}

// Mapa de Instagram por biblioteca (gravação serializada: várias abas detectam ao mesmo tempo).
let igMapWriteChain = Promise.resolve();
function igMapSet(entrada) {
  const run = igMapWriteChain.then(async () => {
    const data = await chrome.storage.local.get(VIVA_IG_MAP_KEY);
    const atual = data[VIVA_IG_MAP_KEY];
    const novo = igMapGravar(atual, entrada || {}, Date.now());
    if (novo !== atual) await chrome.storage.local.set({ [VIVA_IG_MAP_KEY]: novo });
    return { status: "ok", salvo: novo !== atual };
  });
  igMapWriteChain = run.catch(() => {});
  return run;
}

async function finalizarMineracao(queue, state) {
  if (state.janela) await fecharTarefaMineracao(state.janela);
  await acervoWriteChain;
  const data = await chrome.storage.local.get(VIVA_ACERVO_KEY);
  const acervo = Array.isArray(data[VIVA_ACERVO_KEY]) ? data[VIVA_ACERVO_KEY] : [];
  const inicio = Date.parse(state.startedAt) || 0;
  const fontes = new Set(queue.map(item => item.q));
  const daRodada = acervo.filter(c => (c.lastSeen || 0) >= inicio && (c.fontes || []).some(f => fontes.has(f)));
  const bibliotecas = new Set(daRodada.map(c => c.pid || c.nome)).size;
  const emEscala = daRodada.filter(c => c.emEscala).length;
  const resumo = { runId: state.runId, criativos: daRodada.length, emEscala, bibliotecas, finalizadoEm: Date.now() };
  await chrome.storage.local.set({ viva_ultimo_resumo: resumo });
  console.log(`[BG][DIAG-M4] mineração finalizada: ${daRodada.length} criativos, ${emEscala} em escala, ${bibliotecas} bibliotecas`);

  await setInteligenteState({
    ...state,
    status: "completed",
    active: [],
    idx: queue.length,
    nextIndex: queue.length,
  });
  await setInteligenteQueue([]);
  await setInteligenteIdx(0);
  if (state.origem === "radar") {
    await radarAposRodada(state, resumo).catch(error => console.warn(`[BG][RADAR] ${error.message}`));
  }
  notifyInteligente({
    action: "PROGRESSO_INTELIGENTE",
    texto: `Mineração finalizada · ${daRodada.length} criativos escalados · ${bibliotecas} bibliotecas`,
    status: "completed",
    resumo,
  });
}

async function processarFilaInteligente() {
  if (isMinerando) return;
  isMinerando = true;
  try {
    let state = await getInteligenteState();
    if (!state || !["running", "finalizing"].includes(state.status)) return;
    const queue = await getInteligenteQueue();

    if (state.status === "finalizing") {
      await finalizarMineracao(queue, state);
      return;
    }

    while (true) {
      state = await getInteligenteState();
      if (!state || state.status !== "running") return;
      if (state.paused) return;

      let active = listarTarefasAtivas(state).map(task => ({ ...task }));
      let completedCount = Number(state.idx) || 0;
      const durationMs = Math.max(20, Number(state.tempoPorBusca) || 60) * 1000 + MINER_GRACE_MS;
      let changed = false;
      const completedTabIds = [];
      let janelaLivre = null;

      for (const task of active) {
        let tabExists = true;
        try {
          await chrome.tabs.get(task.tabId);
        } catch (error) {
          tabExists = false;
          console.warn(`[BG] Aba da busca ${task.planId} não está mais disponível: ${error.message}`);
        }

        // Termina quando: a aba avisou que acabou (MINER_DONE), o tempo estourou ou a aba sumiu.
        if (!tabExists || task.done || Date.now() - task.startedAt >= durationMs) {
          const haMais = Number(state.nextIndex) < queue.length;
          if (tabExists && state.reutilizarJanela && haMais) {
            janelaLivre = { tabId: task.tabId, windowId: task.windowId };   // fica aberta para a próxima busca
          } else if (tabExists) {
            await fecharTarefaMineracao(task);
          }
          active = active.filter(item => item.tabId !== task.tabId);
          completedTabIds.push(task.tabId);
          completedCount += 1;
          changed = true;
        }
      }

      if (changed) {
        const latestState = await getInteligenteState();
        if (!latestState || latestState.status !== "running") return;
        const latestActive = listarTarefasAtivas(latestState);
        const completedNow = latestActive.filter(task => completedTabIds.includes(task.tabId)).length;
        state = {
          ...latestState,
          active: latestActive.filter(task => !completedTabIds.includes(task.tabId)),
          idx: (Number(latestState.idx) || 0) + completedNow,
          janela: janelaLivre || latestState.janela || null,
        };
        completedCount = state.idx;
        active = state.active;
        // Radar: pausa de ritmo humano antes de abrir a próxima busca.
        if (state.pausaMaxMs > 0) {
          const faixa = Math.max(0, state.pausaMaxMs - state.pausaMinMs);
          state = { ...state, proximaAbertura: Date.now() + state.pausaMinMs + Math.random() * faixa };
        }
        await setInteligenteState(state);
        notifyInteligente({
          action: "PROGRESSO_INTELIGENTE",
          texto: `${completedCount}/${queue.length} buscas concluídas`,
          status: "running",
        });
      }

      if (completedCount >= queue.length && active.length === 0) {
        await finalizarMineracao(queue, state);
        break;
      }

      let nextIndex = Math.max(Number(state.nextIndex) || 0, completedCount + active.length);
      const limiteParalelo = Math.max(1, Math.min(MINER_MAX_PARALLEL, Number(state.maxParallel) || MINER_MAX_PARALLEL));
      while (active.length < limiteParalelo && nextIndex < queue.length) {
        const beforeCreate = await getInteligenteState();
        if (!beforeCreate || beforeCreate.status !== "running") return;
        if (beforeCreate.paused) return;
        if (Date.now() < (Number(beforeCreate.proximaAbertura) || 0)) break; // ainda na pausa entre buscas
        const index = nextIndex;
        const item = queue[index];
        const searchUrl = new URL(item.url);
        searchUrl.searchParams.set("viva_miner", "1"); // só uma dica; a identidade real vem do tabId
        const usedSlots = new Set(active.map(task => task.slot));
        let slot = 0;
        while (usedSlots.has(slot)) slot += 1;
        let handle = null;
        if (beforeCreate.janela) {
          try {
            await chrome.tabs.get(beforeCreate.janela.tabId);
            await chrome.tabs.update(beforeCreate.janela.tabId, { url: searchUrl.toString() });
            handle = beforeCreate.janela;
          } catch (error) {
            console.warn(`[BG] Janela da sessão não está mais disponível, abrindo outra: ${error.message}`);
          }
        }
        if (!handle) handle = await criarJanelaMineracao(searchUrl.toString(), slot);

        const latestState = await getInteligenteState();
        if (!latestState || latestState.runId !== state.runId || latestState.status !== "running" || latestState.paused) {
          await fecharTarefaMineracao({ tabId: handle.tabId, windowId: handle.windowId });
          return;
        }

        active = listarTarefasAtivas(latestState).map(task => ({ ...task }));
        const task = { index, planId: item.planId, tabId: handle.tabId, windowId: handle.windowId, slot, startedAt: Date.now() };
        active.push(task);
        nextIndex = index + 1;
        state = {
          ...latestState,
          active,
          nextIndex,
          janela: null,
          tempoPorBusca: Math.max(20, Number(latestState.tempoPorBusca) || 60),
        };
        await setInteligenteState(state);
        console.log(`[BG][DIAG-M1] busca ${item.planId} "${item.q}" aberta (aba ${handle.tabId}, janela ${handle.windowId})`);
        notifyInteligente({
          action: "PROGRESSO_INTELIGENTE",
          texto: `${completedCount}/${queue.length} concluídas · ${active.length}/${MINER_MAX_PARALLEL} janelas · ${item.q}`,
          status: "running",
        });
      }

      const emPausa = Date.now() < (Number(state.proximaAbertura) || 0) && nextIndex < queue.length;
      if (active.length > 0 || emPausa) await sleep(emPausa ? 1000 : 500);
    }
  } catch (err) {
    const state = await getInteligenteState();
    if (state && state.status !== "cancelled") {
      for (const task of listarTarefasAtivas(state)) {
        await fecharTarefaMineracao(task);
      }
      if (state.janela) await fecharTarefaMineracao(state.janela);
      await setInteligenteState({ ...state, status: "failed", active: [], janela: null, error: err.message });
      if (state.origem === "radar") await radarRodadaInterrompida("failed").catch(() => {});
    }
    console.error(`[BG] Falha na mineração inteligente: ${err.message}`);
    notifyInteligente({ action: "PROGRESSO_INTELIGENTE", texto: `Falha: ${err.message}`, status: "failed" });
  } finally {
    isMinerando = false;
  }
}

async function iniciarMineracaoInteligente(linhas, options, consentGranted) {
  if (consentGranted !== true) {
    throw new Error("Confirmação explícita obrigatória antes de abrir abas de busca.");
  }
  if (isMinerando) throw new Error("Já existe uma mineração inteligente em andamento.");
  isMinerando = true;
  let response;
  try {
    if (!Array.isArray(linhas)) throw new Error("Envie uma lista de termos para pesquisar.");
    const currentState = await getInteligenteState();
    if (currentState && ["running", "finalizing"].includes(currentState.status)) {
      throw new Error("Já existe uma mineração inteligente em andamento.");
    }
    const origemRadar = options?.origem === "radar";
    if (!origemRadar) {
      const inputState = parseBuscaInput(linhas.join("\n"));
      if (inputState.modo !== "turbo") {
        throw new Error("A mineração em segundo plano exige pelo menos duas linhas. Use a busca normal para uma linha.");
      }
    }
    const queue = origemRadar
      ? gerarFilaRadar(linhas.join("\n"), { country: options?.country, language: options?.language, maximo: options?.maximo })
      : gerarFilaInteligente(linhas, options);
    if (queue.length === 0) throw new Error("Nenhuma consulta válida foi informada.");

    await chrome.storage.local.remove(["viva_ultimo_ranking", INTELIGENTE_RESULTADOS_KEY, "viva_ultimo_resumo"]);
    const runId = crypto.randomUUID();
    const state = {
      runId,
      status: "running",
      index: 0,
      nextIndex: 0,
      total: queue.length,
      active: [],
      paused: false,
      pausedAt: null,
      tempoPorBusca: Math.max(20, Math.min(180, Number(options?.tempoPorBusca) || 60)),
      modoRapido: Boolean(options?.modoRapido),
      consentGranted: true,
      startedAt: new Date().toISOString(),
      origem: origemRadar ? "radar" : "manual",
      // Sessão única: uma janela só, reaproveitada termo a termo (nunca uma janela por linha).
      maxParallel: 1,
      reutilizarJanela: true,
      janela: null,
      pausaMinMs: Math.max(0, Number(options?.pausaMinMs) || (origemRadar ? 0 : 3000)),
      pausaMaxMs: Math.max(0, Number(options?.pausaMaxMs) || (origemRadar ? 0 : 7000)),
      proximaAbertura: 0,
    };
    await setInteligenteQueue(queue);
    await setInteligenteIdx(0);
    await setInteligenteState(state);
    console.log(`[BG] Fila inteligente iniciada com ${queue.length} itens`);
    response = { status: "fila_iniciada", total: queue.length, runId };
  } finally {
    isMinerando = false;
  }
  processarFilaInteligente();
  return response;
}

async function pausarMineracaoInteligente(runId, paused) {
  const state = await getInteligenteState();
  if (!state || state.status !== "running" || (runId && state.runId !== runId)) {
    return { error: "Não há mineração ativa para atualizar." };
  }
  if (Boolean(state.paused) === paused) return { ok: true, paused };

  const now = Date.now();
  let active = Array.isArray(state.active) ? state.active : (state.active ? [state.active] : []);
  let pausedAt = null;
  if (paused) {
    pausedAt = now;
  } else {
    const pausedDuration = Math.max(0, now - (Number(state.pausedAt) || now));
    active = active.map(task => ({ ...task, startedAt: task.startedAt + pausedDuration }));
  }

  const updated = { ...state, active, paused, pausedAt };
  await setInteligenteState(updated);
  notifyInteligente({
    action: "PROGRESSO_INTELIGENTE",
    texto: paused ? "Mineração pausada · abas abertas preservadas" : "Mineração retomada",
    status: paused ? "paused" : "running",
  });
  if (!paused) processarFilaInteligente();
  return { ok: true, paused };
}

async function cancelarMineracaoInteligente(runId) {
  const state = await getInteligenteState();
  if (!state || state.status !== "running" || (runId && state.runId !== runId)) {
    return { error: "Não há mineração ativa para cancelar." };
  }

  const active = listarTarefasAtivas(state);
  await setInteligenteState({ ...state, status: "cancelled", active: [], paused: false, janela: null });
  for (const task of active) {
    await fecharTarefaMineracao(task);
  }
  if (state.janela) await fecharTarefaMineracao(state.janela);
  await setInteligenteQueue([]);
  await setInteligenteIdx(0);
  if (state.origem === "radar") await radarRodadaInterrompida("cancelled").catch(() => {});
  notifyInteligente({
    action: "PROGRESSO_INTELIGENTE",
    texto: "Mineração cancelada · abas encerradas",
    status: "cancelled",
  });
  return { ok: true, status: "cancelled" };
}

// Escutar mensagens do content script e popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_INTELIGENTE_STATE") {
    getInteligenteState()
      .then(state => sendResponse(state ? {
        status: state.status,
        runId: state.runId,
        index: state.idx || 0,
        total: state.total || 0,
        paused: Boolean(state.paused),
        modoRapido: Boolean(state.modoRapido),
      } : null))
      .catch(error => {
        console.error("[BG] Não foi possível recuperar estado da mineração:", error);
        sendResponse({ error: error.message });
      });
    return true;
  }

  else if (message.action === "GET_NEXT_FUNIL_SEQ") {
    getNextFunilSequence(message.page_id)
      .then(sendResponse)
      .catch(error => {
        console.error("[BG] Não foi possível consultar o próximo rótulo de funil:", error.message);
        sendResponse({ error: error.message });
      });
    return true;
  }

  else if (message.action === "INCREMENT_FUNIL_SEQ") {
    incrementFunilSequence(message.page_id, message.count, message.total, message.labels)
      .then(sendResponse)
      .catch(error => {
        console.error("[BG] Não foi possível atualizar o sequencial local do funil:", error.message);
        sendResponse({ error: error.message });
      });
    return true;
  }

  else if (message.action === "download") {
    enqueueDownload({
      url: message.url,
      filename: message.filename
    }).then(() => {
      processQueue();
      sendResponse({ status: "queued" });
    });
    return true; // resposta assíncrona
  }

  else if (message.action === "open_mobile_tab") {
    // Adiciona o parâmetro de controle de User-Agent
    const originalUrl = message.url;
    const separator = originalUrl.includes("?") ? "&" : "?";
    const mobileUrl = `${originalUrl}${separator}viva_mobile=true`;
    
    chrome.tabs.create({ url: mobileUrl });
    sendResponse({ status: "opened" });
    return false;
  }

  else if (message.action === "INICIAR_MINERACAO_INTELIGENTE") {
    iniciarMineracaoInteligente(message.linhas, message.options, message.consentGranted).then(sendResponse).catch((err) => {
      console.error(`[BG] Não foi possível iniciar a mineração: ${err.message}`);
      sendResponse({ status: "error", error: err.message });
    });
    return true;
  }

  else if (message.action === "PAUSAR_MINERACAO_INTELIGENTE" || message.action === "RETOMAR_MINERACAO_INTELIGENTE") {
    const paused = message.action === "PAUSAR_MINERACAO_INTELIGENTE";
    pausarMineracaoInteligente(message.runId, paused)
      .then(sendResponse)
      .catch(error => {
        console.error("[BG] Não foi possível alterar estado da mineração:", error);
        sendResponse({ error: error.message });
      });
    return true;
  }

  else if (message.action === "CANCELAR_MINERACAO_INTELIGENTE") {
    cancelarMineracaoInteligente(message.runId)
      .then(sendResponse)
      .catch(error => {
        console.error("[BG] Não foi possível cancelar a mineração:", error);
        sendResponse({ error: error.message });
      });
    return true;
  }

  else if (message.action === "GET_MINER_CONTEXT") {
    obterContextoMineracao(sender)
      .then(sendResponse)
      .catch(error => {
        console.error("[BG] Não foi possível obter o contexto de mineração:", error);
        sendResponse(null);
      });
    return true;
  }

  else if (message.action === "MINER_DONE") {
    marcarMineracaoConcluida(message, sender)
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "MINER_PROGRESS") {
    relatarProgressoMineracao(message, sender)
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "ACERVO_UPSERT") {
    upsertAcervo(message.creatives)
      .then(sendResponse)
      .catch(error => {
        console.error(`[BG] Não foi possível gravar no acervo: ${error.message}`);
        sendResponse({ status: "error", error: error.message });
      });
    return true;
  }

  else if (message.action === "ACERVO_CLEAR") {
    limparAcervo()
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "ACERVO_DELETE") {
    apagarDoAcervo(message)
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "LIXEIRA_CLEAR") {
    limparLixeira()
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "IG_MAP_SET") {
    igMapSet({ pid: message.pid, nome: message.nome, url: message.url })
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "RADAR_CONFIG_CHANGED") {
    radarConfigChanged()
      .then(state => sendResponse({ status: "ok", state }))
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "EXPORT_NOW") {
    aexpBaixarAgora()
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "NOTIFY_TEST") {
    notifTestar()
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "RADAR_RUN_NOW") {
    radarTick({ force: true })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "RADAR_STOP_RUN") {
    getInteligenteState()
      .then(async state => {
        if (!state || state.origem !== "radar" || state.status !== "running") return { status: "idle" };
        const r = await cancelarMineracaoInteligente(state.runId);
        await radarRodadaInterrompida("cancelled");
        return r;
      })
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "TEAM_SYNC_NOW") {
    teamSyncNow({ force: true })
      .then(state => sendResponse({ status: "ok", state }))
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "TEAM_CONFIG_CHANGED") {
    teamConfigChanged()
      .then(state => sendResponse({ status: "ok", state }))
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "TEAM_SET_STATUS") {
    teamSetStatus(message.key, message.novoStatus)
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  else if (message.action === "TEAM_SET_STATUS_LOTE") {
    teamSetStatusLote(message.keys, message.novoStatus)
      .then(sendResponse)
      .catch(error => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  // Mensagem desconhecida: não mantém o canal aberto à toa.
  return false;
});

// Cofre da equipe: liga a fila de escrita do acervo ao módulo, cria o ciclo de sincronização e
// sincroniza ao acordar (com intervalo mínimo, para não repetir a cada mensagem recebida).
teamSyncInit({
  serial: fn => {
    const run = acervoWriteChain.then(fn);
    acervoWriteChain = run.catch(() => {});
    return run;
  },
});
try {
  if (chrome.alarms && chrome.alarms.onAlarm) chrome.alarms.onAlarm.addListener(teamHandleAlarm);
  teamEnsureAlarms();
  teamSyncNow({ force: false }).catch(() => {});
} catch (error) {
  console.warn(`[BG][TEAM] sincronização indisponível: ${error.message}`);
}

// Radar diário: agenda + ganchos de reinício do Chrome.
radarInit({
  serial: fn => {
    const run = acervoWriteChain.then(fn);
    acervoWriteChain = run.catch(() => {});
    return run;
  },
  iniciar: iniciarMineracaoInteligente,
  ocupado: () => isMinerando,
  marcarSujos: async chaves => {
    if (await teamConfig()) {
      await teamMarkDirtyRaw(chaves);
      teamAgendarSync();
    }
  },
  ping: info => teamPing({ ...info, v: chrome.runtime.getManifest().version }),
  notificar: dados => notifRadarRodada(dados),
});
radarRegistrarEventos();
aexpRegistrarEventos();
aexpAgendarVerificacao();   // ao acordar, confere se já está na hora do download automático

// FIX ITEM 9: retoma automaticamente qualquer fila deixada pendente por uma suspensão anterior
// do service worker — roda toda vez que este script acorda, seja por qual evento for.
processQueue();
getInteligenteState()
  .then(async state => {
    if (!state || !["running", "finalizing"].includes(state.status)) return;
    if (state.consentGranted !== true) {
      for (const task of listarTarefasAtivas(state)) {
        await fecharTarefaMineracao(task);
      }
      await setInteligenteState({
        ...state,
        status: "cancelled",
        active: [],
        paused: false,
        error: "Execução anterior sem consentimento explícito foi cancelada.",
      });
      await setInteligenteQueue([]);
      await setInteligenteIdx(0);
      return;
    }
    if (state.status === "finalizing" || (state.status === "running" && !state.paused)) {
      processarFilaInteligente();
    }
  })
  .catch(err => console.error(`[BG] Não foi possível recuperar fila inteligente: ${err.message}`));