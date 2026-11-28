// Abas do Centro de Inteligência: abre o Centro em uma aba própria (reaproveitando a que já existir)
// e leva de volta para a aba da biblioteca de onde a pessoa veio. Carregado pelo background.js.

const INTEL_ORIGEM_KEY = "viva_intel_origem"; // { tabId, windowId }
const INTEL_BIBLIOTECA_URL = "https://www.facebook.com/ads/library/?active_status=active";

function intelEhBiblioteca(url) {
  return /^https:\/\/www\.facebook\.com\/ads\/library/.test(String(url || "")) && !/[?&]viva_miner=/.test(String(url));
}

async function intelFocarAba(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (chrome.windows && tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

async function abrirCentro(sender) {
  const paginaCentro = chrome.runtime.getURL("intel.html");
  const origem = sender && sender.tab && intelEhBiblioteca(sender.tab.url) ? sender.tab : null;
  if (origem) await chrome.storage.local.set({ [INTEL_ORIGEM_KEY]: { tabId: origem.id, windowId: origem.windowId } });
  const abertas = await chrome.tabs.query({ url: `${paginaCentro}*` });
  if (abertas.length) {
    await intelFocarAba(abertas[0]);
    return { status: "ok", reaproveitada: true };
  }
  await chrome.tabs.create(origem
    ? { url: paginaCentro, windowId: origem.windowId, index: origem.index + 1 }
    : { url: paginaCentro });
  return { status: "ok", reaproveitada: false };
}

async function intelAcharBiblioteca() {
  const data = await chrome.storage.local.get(INTEL_ORIGEM_KEY);
  const salva = data[INTEL_ORIGEM_KEY];
  if (salva && salva.tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(salva.tabId);
      if (intelEhBiblioteca(tab.url)) return tab;
    } catch (_) { /* a aba de origem já foi fechada */ }
  }
  const abertas = await chrome.tabs.query({ url: "https://www.facebook.com/ads/library*" });
  return abertas.find(tab => intelEhBiblioteca(tab.url)) || null;
}

// "← Voltar à Biblioteca": volta para a aba de origem; sem ela, abre a biblioteca na própria aba.
async function voltarParaBiblioteca(sender) {
  const alvo = await intelAcharBiblioteca();
  if (alvo) {
    await intelFocarAba(alvo);
    return { status: "ok", nova: false };
  }
  if (sender && sender.tab) await chrome.tabs.update(sender.tab.id, { url: INTEL_BIBLIOTECA_URL });
  else await chrome.tabs.create({ url: INTEL_BIBLIOTECA_URL });
  return { status: "ok", nova: true };
}
