// VIVA Labs Helper - Background Service Worker

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

// Escutar mensagens do content script e popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "download") {
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
  
  return true; // Mantém canal de comunicação aberto para responses assíncronos
});

// FIX ITEM 9: retoma automaticamente qualquer fila deixada pendente por uma suspensão anterior
// do service worker — roda toda vez que este script acorda, seja por qual evento for.
processQueue();