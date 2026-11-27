// Fila dos posts virais (carregada pelo background.js via importScripts). O popup só registra o
// pedido; o envio acontece aqui, sobrevive ao fechamento do popup e é repetido se falhar.

const VIRAL_JOBS_KEY = "viva_viral_jobs";
const VIRAL_ALARM = "viva-viral-outbox";
const VIRAL_API_PADRAO = "https://nutra-monitor.onrender.com";
const VIRAL_API_ANTIGA = "https://viva-labs-monitor.onrender.com"; // endereço padrão antigo, desativado
const VIRAL_TIMEOUT_MS = 25000;
const VIRAL_MAX_TENTATIVAS = 30;
const VIRAL_MAX_HISTORICO = 40;
const VIRAL_ATIVOS = ["pendente", "removendo"];

let viralLock = Promise.resolve();
let viralRunning = null;
let viralRunAgain = false;

async function viralRead() {
  const data = await chrome.storage.local.get(VIRAL_JOBS_KEY);
  return Array.isArray(data[VIRAL_JOBS_KEY]) ? data[VIRAL_JOBS_KEY] : [];
}

// Um escritor por vez. Só descarta do histórico o que já terminou.
function viralMutate(change) {
  const run = viralLock.then(async () => {
    let jobs = change(await viralRead());
    const sobra = jobs.length - VIRAL_MAX_HISTORICO;
    if (sobra > 0) {
      const velhos = jobs.filter(job => !VIRAL_ATIVOS.includes(job.status)).slice(0, sobra);
      jobs = jobs.filter(job => !velhos.includes(job));
    }
    await chrome.storage.local.set({ [VIRAL_JOBS_KEY]: jobs });
  });
  viralLock = run.catch(() => {});
  return run;
}

function viralPatch(id, patch) {
  return viralMutate(jobs => jobs.map(job => (job.id === id ? { ...job, ...patch } : job)));
}

async function viralGet(id) {
  return (await viralRead()).find(job => job.id === id) || null;
}

async function viralApiUrl() {
  const data = await chrome.storage.local.get("viva_monitor_api_url");
  const url = String(data.viva_monitor_api_url || "").replace(/\/+$/, "");
  return !url || url === VIRAL_API_ANTIGA ? VIRAL_API_PADRAO : url;
}

async function viralPost(url, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VIRAL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function viralEnqueue({ url, autor }) {
  const post = viralParseUrl(url);
  if (!post) throw new Error("Este link não é um post.");
  const apiUrl = await viralApiUrl();
  let id = null;
  await viralMutate(jobs => {
    const anterior = jobs.find(job => job.url === post.url && job.apiUrl === apiUrl);
    if (anterior && anterior.status === "pendente" && !anterior.cancelar) {
      id = anterior.id;
      return jobs;
    }
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const novo = {
      id, apiUrl, url: post.url, plataforma: post.plataforma, autor: post.autor || autor || null,
      status: "pendente", tentativas: 0, meuId: anterior?.podeDesfazer ? anterior.serverId : null,
    };
    return [...jobs.filter(job => job !== anterior), novo];
  });
  viralStart();
  return { ok: true, id };
}

async function viralUndo(id) {
  await viralMutate(jobs => jobs.map(job => {
    if (job.id !== id) return job;
    if (job.status === "salvo" && job.podeDesfazer) return { ...job, status: "removendo", tentativas: 0 };
    if (job.status === "pendente") return { ...job, cancelar: true };
    if (job.status === "falhou") return { ...job, status: "desfeito" };
    return job;
  }));
  viralStart();
  return { ok: true };
}

function viralStart() {
  if (chrome.alarms) chrome.alarms.create(VIRAL_ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
  viralProcess().catch(error => console.error("[BG] Fila de posts virais:", error.message));
}

function viralProcess() {
  if (viralRunning) {
    viralRunAgain = true;
    return viralRunning;
  }
  viralRunning = (async () => {
    do {
      viralRunAgain = false;
      for (const job of (await viralRead()).filter(item => VIRAL_ATIVOS.includes(item.status))) {
        if (!(await viralSend(job.id))) break;
      }
    } while (viralRunAgain);
    const restam = (await viralRead()).some(job => VIRAL_ATIVOS.includes(job.status));
    if (!restam && chrome.alarms) await chrome.alarms.clear(VIRAL_ALARM);
  })().finally(() => { viralRunning = null; });
  return viralRunning;
}

// Devolve false quando o servidor não respondeu (não adianta tentar os próximos agora).
async function viralSend(id) {
  const job = await viralGet(id);
  if (!job || !VIRAL_ATIVOS.includes(job.status)) return true;
  if (job.status === "pendente" && job.cancelar && job.tentativas === 0) {
    await viralPatch(id, { status: "desfeito" });
    return true;
  }
  try {
    return job.status === "removendo" ? await viralSendRemove(job) : await viralSendSave(job);
  } catch (error) {
    console.warn("[BG] Post viral adiado:", error.message);
    await viralRetryLater(job, "Servidor não respondeu.");
    return false;
  }
}

async function viralSendSave(job) {
  await viralPatch(job.id, { tentativas: job.tentativas + 1 });
  const response = await viralPost(`${job.apiUrl}/api/virais`, { url: job.url, autor: job.autor });
  if (response.ok && response.data?.id) {
    const podeDesfazer = response.data.criado || response.data.id === job.meuId;
    const atual = await viralGet(job.id); // o usuário pode ter pedido "Desfazer" durante o envio
    const status = !atual?.cancelar ? "salvo" : podeDesfazer ? "removendo" : "mantido";
    await viralPatch(job.id, { status, serverId: response.data.id, criado: response.data.criado, podeDesfazer, erro: null, tentativas: 0 });
    if (status === "removendo") viralRunAgain = true;
    return true;
  }
  const temporario = response.ok || response.status >= 500 || response.status === 408 || response.status === 429;
  if (temporario) {
    await viralRetryLater(job, `Servidor respondeu HTTP ${response.status}.`);
    return false;
  }
  const motivo = response.status === 404
    ? "O servidor ainda não tem a área de posts virais (HTTP 404)."
    : response.data?.error || `Servidor recusou (HTTP ${response.status}).`;
  await viralFail(job.id, motivo);
  return true;
}

async function viralSendRemove(job) {
  const response = await viralPost(`${job.apiUrl}/api/virais/remover`, { id: job.serverId });
  if (response.ok) {
    await viralPatch(job.id, { status: "desfeito", erro: null });
    return true;
  }
  await viralRetryLater(job, `Não foi possível apagar (HTTP ${response.status}).`);
  return false;
}

async function viralRetryLater(job, motivo) {
  const atual = await viralGet(job.id);
  if (!atual) return;
  const tentativas = Math.max(atual.tentativas, job.tentativas + 1);
  if (tentativas >= VIRAL_MAX_TENTATIVAS) return viralFail(job.id, motivo);
  await viralPatch(job.id, { tentativas, erro: motivo });
}

async function viralFail(id, motivo) {
  await viralPatch(id, { status: "falhou", erro: motivo });
  if (chrome.action?.setBadgeText) {
    await chrome.action.setBadgeBackgroundColor({ color: "#ff3b30" });
    await chrome.action.setBadgeText({ text: "!" });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message?.action === "VIRAL_SAVE" ? () => viralEnqueue(message)
    : message?.action === "VIRAL_UNDO" ? () => viralUndo(message.id)
    : null;
  if (!handler) return false;
  handler().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === VIRAL_ALARM) viralProcess().catch(error => console.error("[BG] Fila de posts virais:", error.message));
  });
}
// Ao reabrir o navegador ou atualizar a extensão, o que tinha falhado ganha nova chance.
for (const event of [chrome.runtime.onStartup, chrome.runtime.onInstalled]) {
  if (event) event.addListener(() => {
    viralMutate(jobs => jobs.map(job => (job.status === "falhou" ? { ...job, status: "pendente", tentativas: 0 } : job)))
      .then(viralProcess)
      .catch(error => console.error("[BG] Fila de posts virais:", error.message));
  });
}
