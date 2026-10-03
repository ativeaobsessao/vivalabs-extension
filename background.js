// VIVA Labs Helper - Background Service Worker

importScripts("intelligent_parser.js", "ranking_engine.js");
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
const INTELIGENTE_TAB_DURATION_MS = 18_000;
const INTELIGENTE_SEARCH_DELAY_MS = 10_000;
let isMinerando = false;

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
      index: state.index,
      total: state.total,
      error: state.error || null,
      updatedAt: new Date().toISOString(),
    },
  });
}

function notifyInteligente(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No listener is required: durable state is also exposed in chrome.storage.local.
  });
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

async function registrarResultadoMineracao(message, sender) {
  const state = await getInteligenteState();
  if (
    !state
    || state.status !== "running"
    || !state.active
    || sender.tab?.id !== state.active.tabId
    || message.runId !== state.runId
    || message.planId !== state.active.planId
  ) {
    return { status: "ignored" };
  }

  if (!Array.isArray(message.paginas)) return { status: "ignored" };
  const currentPlan = (await getInteligenteQueue())[state.index];
  if (!currentPlan || currentPlan.planId !== message.planId) return { status: "ignored" };
  try {
    const resultUrl = new URL(message.url);
    if (
      !/(^|\.)facebook\.com$/i.test(resultUrl.hostname)
      || resultUrl.searchParams.get("q") !== currentPlan.q
      || resultUrl.searchParams.get("viva_miner_run") !== state.runId
      || resultUrl.searchParams.get("viva_miner_plan") !== currentPlan.planId
    ) {
      return { status: "ignored" };
    }
  } catch {
    return { status: "ignored" };
  }
  const results = await getInteligenteResultados();

  for (const page of message.paginas) {
    if (!page || !/^\d{10,20}$/.test(String(page.page_id || ""))) continue;
    const pageId = String(page.page_id);
    const record = results[pageId] || {
      nome: page.nome || "Desconhecido",
      page_id: pageId,
      aparicoes: 0,
      qtd_ads: 0,
      dias_ativo: 0,
      escala: "",
      searchHits: {},
      metricasPorBusca: {},
    };
    if (!record.searchHits || typeof record.searchHits !== "object") record.searchHits = {};
    if (!record.metricasPorBusca || typeof record.metricasPorBusca !== "object") {
      record.metricasPorBusca = {};
    }
    const lineHits = new Set(record.searchHits[currentPlan.lineId] || []);
    lineHits.add(currentPlan.planId);
    record.searchHits[currentPlan.lineId] = Array.from(lineHits);
    record.nome = page.nome || record.nome;
    record.qtd_ads = Math.max(record.qtd_ads || 0, Number(page.qtd_ads) || 0);
    record.dias_ativo = Math.max(record.dias_ativo || 0, Number(page.dias_ativo) || 0);
    record.metricasPorBusca[currentPlan.planId] = {
      media_dias: Number(page.media_dias ?? page.dias_ativo) || 0,
      tem_recente: Boolean(page.tem_recente),
      escala_tipo: page.escala_tipo || page.escala || "",
      qtd_ads: Number(page.qtd_ads) || 1,
      qtd_duplicados: Number(page.qtd_duplicados) || 0,
    };
    const scale = page.escala || "";
    const scaleRank = { "ESCALA BRUTA": 3, "POTENCIAL ESCALA": 2, "CAMPANHA NORMAL": 1 };
    if ((scaleRank[scale] || 0) > (scaleRank[record.escala] || 0)) record.escala = scale;
    record.aparicoes = new Set(
      Object.values(record.searchHits).flat(),
    ).size;
    results[pageId] = record;
  }

  await setInteligenteResultados(results);
  return { status: "resultado_salvo" };
}

async function salvarTopRankingNoMonitor(ranking) {
  const apiData = await chrome.storage.local.get("viva_monitor_api_url");
  const apiUrl = (apiData.viva_monitor_api_url || "https://viva-labs-monitor.onrender.com").replace(/\/+$/, "");
  for (const page of ranking.slice(0, 20)) {
    try {
      const response = await fetch(`${apiUrl}/api/salvar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: page.nome,
          url: `https://www.facebook.com/ads/library/?view_all_page_id=${encodeURIComponent(page.page_id)}`,
          tipo: "pagina",
          ads_count_inicial: page.qtd_ads,
        }),
      });
      if (!response.ok) {
        console.error(`[BG] Cadastro no monitor falhou para ${page.page_id}: HTTP ${response.status}`);
      }
    } catch (err) {
      console.error(`[BG] Cadastro no monitor falhou para ${page.page_id}: ${err.message}`);
    }
  }
}

async function finalizarMineracao(queue, results, state) {
  const plansByLine = new Map();
  for (const item of queue) {
    if (!plansByLine.has(item.lineId)) plansByLine.set(item.lineId, new Map());
    plansByLine.get(item.lineId).set(item.planId, item.linhaOriginal);
  }

  const matched = new Map();
  for (const page of Object.values(results)) {
    const matchedLines = [];
    const matchedPlanIds = new Set();
    for (const [lineId, plans] of plansByLine) {
      const hits = new Set(page.searchHits?.[lineId] || []);
      if (Array.from(plans.keys()).every(planId => hits.has(planId))) {
        const originalLine = plans.values().next().value;
        if (originalLine && !matchedLines.includes(originalLine)) matchedLines.push(originalLine);
        for (const planId of plans.keys()) matchedPlanIds.add(planId);
      }
    }
    if (matchedLines.length > 0) {
      const metrics = Array.from(matchedPlanIds)
        .map(planId => page.metricasPorBusca?.[planId])
        .filter(Boolean);
      const averageDays = metrics.length
        ? metrics.reduce((total, metric) => total + (Number(metric.media_dias) || 0), 0) / metrics.length
        : Number(page.dias_ativo) || 0;
      const scaleRank = { "ESCALA BRUTA": 3, "POTENCIAL ESCALA": 2, "CAMPANHA NORMAL": 1 };
      const allLowVolume = metrics.length > 0
        && metrics.every(metric => metric.escala_tipo === "BAIXO VOLUME");
      const escalaTipo = allLowVolume ? "BAIXO VOLUME" : metrics.reduce((best, metric) => {
        const candidate = metric.escala_tipo || "CAMPANHA NORMAL";
        if (candidate === "BAIXO VOLUME") return best;
        return (scaleRank[candidate] || 0) > (scaleRank[best] || 0) ? candidate : best;
      }, "CAMPANHA NORMAL");
      const qtdAds = metrics.reduce(
        (maximum, metric) => Math.max(maximum, Number(metric.qtd_ads) || 1),
        Number(page.qtd_ads) || 1,
      );
      const qtdDuplicados = metrics.reduce(
        (maximum, metric) => Math.max(maximum, Number(metric.qtd_duplicados) || 0),
        0,
      );
      matched.set(page.page_id, {
        ...page,
        linhas: matchedLines,
        linhas_distintas: matchedLines.length,
        media_dias: averageDays,
        tem_recente: metrics.some(metric => metric.tem_recente),
        escala_tipo: escalaTipo,
        qtd_ads: qtdAds,
        qtd_duplicados: qtdDuplicados,
      });
    }
  }

  const ranking = gerarRankingFinal(matched);
  await chrome.storage.local.set({ viva_ultimo_ranking: ranking });
  await setInteligenteState({ ...state, status: "finalizing", active: null, index: queue.length });
  notifyInteligente({ action: "RANKING_FINAL", ranking });
  await salvarTopRankingNoMonitor(ranking);
  const completedState = { ...state, status: "completed", active: null, index: queue.length };
  await setInteligenteState(completedState);
  await setInteligenteQueue([]);
  await setInteligenteIdx(0);
  await setInteligenteResultados({});
  notifyInteligente({ action: "PROGRESSO_INTELIGENTE", texto: "Mineração finalizada", ranking: ranking.length });
}

async function processarFilaInteligente() {
  if (isMinerando) return;
  isMinerando = true;
  try {
    let state = await getInteligenteState();
    if (!state || !["running", "finalizing"].includes(state.status)) return;
    const queue = await getInteligenteQueue();

    if (state.status === "finalizing") {
      const results = await getInteligenteResultados();
      await finalizarMineracao(queue, results, state);
      return;
    }

    while (true) {
      let index = await getInteligenteIdx();
      state = await getInteligenteState();
      if (!state || state.status !== "running") return;
      if (index >= queue.length) {
        await finalizarMineracao(queue, await getInteligenteResultados(), state);
        break;
      }

      if (state.nextAt && state.nextAt > Date.now()) {
        await sleep(state.nextAt - Date.now());
        state = { ...state, nextAt: null };
        await setInteligenteState(state);
      }

      const item = queue[index];
      let active = state.active;
      let tab;
      if (active && active.index === index && active.planId === item.planId) {
        try {
          tab = await chrome.tabs.get(active.tabId);
        } catch {
          tab = null;
        }
      }

      if (!tab) {
        const searchUrl = new URL(item.url);
        searchUrl.searchParams.set("viva_miner_run", state.runId);
        searchUrl.searchParams.set("viva_miner_plan", item.planId);
        tab = await chrome.tabs.create({ url: searchUrl.toString(), active: false });
        active = { index, planId: item.planId, tabId: tab.id, startedAt: Date.now() };
        state = { ...state, active };
        await setInteligenteState(state);
      }

      notifyInteligente({
        action: "PROGRESSO_INTELIGENTE",
        texto: `Buscando ${index + 1}/${queue.length}: ${item.q}`,
      });
      const elapsed = Date.now() - active.startedAt;
      await sleep(Math.max(0, INTELIGENTE_TAB_DURATION_MS - elapsed));
      try {
        await chrome.tabs.remove(active.tabId);
      } catch (err) {
        console.warn(`[BG] Não foi possível fechar a aba da busca ${item.planId}: ${err.message}`);
      }

      index += 1;
      await setInteligenteIdx(index);
      state = { ...state, index, active: null, nextAt: Date.now() + INTELIGENTE_SEARCH_DELAY_MS };
      await setInteligenteState(state);
      if (index < queue.length) {
        await sleep(INTELIGENTE_SEARCH_DELAY_MS);
        state = { ...state, nextAt: null };
        await setInteligenteState(state);
      }
    }
  } catch (err) {
    const state = await getInteligenteState();
    if (state) await setInteligenteState({ ...state, status: "failed", error: err.message });
    console.error(`[BG] Falha na mineração inteligente: ${err.message}`);
    notifyInteligente({ action: "PROGRESSO_INTELIGENTE", texto: `Falha: ${err.message}` });
  } finally {
    isMinerando = false;
  }
}

async function iniciarMineracaoInteligente(linhas, options) {
  if (isMinerando) throw new Error("Já existe uma mineração inteligente em andamento.");
  isMinerando = true;
  let response;
  try {
    if (!Array.isArray(linhas)) throw new Error("Envie uma lista de termos para pesquisar.");
    const currentState = await getInteligenteState();
    if (currentState && ["running", "finalizing"].includes(currentState.status)) {
      throw new Error("Já existe uma mineração inteligente em andamento.");
    }
    const queue = gerarFilaInteligente(linhas, options);
    if (queue.length === 0) throw new Error("Nenhuma consulta válida foi informada.");

    await chrome.storage.local.remove("viva_ultimo_ranking");
    const runId = crypto.randomUUID();
    const state = {
      runId,
      status: "running",
      index: 0,
      total: queue.length,
      active: null,
      nextAt: null,
      startedAt: new Date().toISOString(),
    };
    await setInteligenteQueue(queue);
    await setInteligenteIdx(0);
    await setInteligenteResultados({});
    await setInteligenteState(state);
    console.log(`[BG] Fila inteligente iniciada com ${queue.length} itens`);
    response = { status: "fila_iniciada", total: queue.length, runId };
  } finally {
    isMinerando = false;
  }
  processarFilaInteligente();
  return response;
}

// Escutar mensagens do content script e popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_NEXT_FUNIL_SEQ") {
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
  }

  else if (message.action === "INICIAR_MINERACAO_INTELIGENTE") {
    iniciarMineracaoInteligente(message.linhas, message.options).then(sendResponse).catch((err) => {
      console.error(`[BG] Não foi possível iniciar a mineração: ${err.message}`);
      sendResponse({ status: "error", error: err.message });
    });
    return true;
  }

  else if (message.action === "RESULTADO_PAGINA_MINERADA") {
    registrarResultadoMineracao(message, sender).then(sendResponse).catch((err) => {
      console.error(`[BG] Não foi possível salvar resultados minerados: ${err.message}`);
      sendResponse({ status: "error", error: err.message });
    });
    return true;
  }
  
  return true; // Mantém canal de comunicação aberto para responses assíncronos
});

// FIX ITEM 9: retoma automaticamente qualquer fila deixada pendente por uma suspensão anterior
// do service worker — roda toda vez que este script acorda, seja por qual evento for.
processQueue();
getInteligenteState()
  .then(state => {
    if (state && ["running", "finalizing"].includes(state.status)) processarFilaInteligente();
  })
  .catch(err => console.error(`[BG] Não foi possível recuperar fila inteligente: ${err.message}`));