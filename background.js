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

// Fila de downloads controlada (throttle de 500ms)
let downloadQueue = [];
let isDownloading = false;

function processQueue() {
  if (downloadQueue.length === 0) {
    isDownloading = false;
    return;
  }
  isDownloading = true;
  const task = downloadQueue.shift();

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
    // Aguarda 500ms e processa o próximo da fila
    setTimeout(processQueue, 500);
  });
}

// Escutar mensagens do content script e popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "download") {
    downloadQueue.push({
      url: message.url,
      filename: message.filename
    });
    if (!isDownloading) {
      processQueue();
    }
    sendResponse({ status: "queued" });
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