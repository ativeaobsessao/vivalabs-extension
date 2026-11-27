// Fila dos posts virais (carregada pelo background.js via importScripts). O cartão da página só
// registra o pedido; o envio acontece aqui, sobrevive ao fechamento da aba e é repetido se falhar.

const VIRAL_JOBS_KEY = "viva_viral_jobs";
const VIRAL_ALARM = "viva-viral-outbox";
const VIRAL_TIMEOUT_MS = 25000;
const VIRAL_MAX_TENTATIVAS = 30;
const VIRAL_MAX_HISTORICO = 40;
const VIRAL_ATIVOS = ["pendente", "removendo"];
const VIRAL_NICHOS_KEY = "viva_viral_nichos";
const VIRAL_NICHOS_VALIDADE_MS = 60000;
const VIRAL_NICHOS_PADRAO = ["Emagrecimento", "Diabetes", "Menopausa", "Renda extra", "Rejuvenescimento", "Relacionamento"];
const VIRAL_ETIQUETAS = ["nicho", "idioma", "geo", "legenda"];

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
  return vivaMonitorUrl(data.viva_monitor_api_url);
}

async function viralFetch(url, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VIRAL_TIMEOUT_MS);
  try {
    const response = await fetch(url, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }
      : { signal: controller.signal });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Lista de nichos vem do servidor; sem rede, usa a última cópia (ou a lista inicial).
async function viralNichos() {
  const apiUrl = await viralApiUrl();
  const guardado = (await chrome.storage.local.get(VIRAL_NICHOS_KEY))[VIRAL_NICHOS_KEY];
  const cache = guardado?.apiUrl === apiUrl ? guardado : null;
  if (cache && Date.now() - cache.em < VIRAL_NICHOS_VALIDADE_MS) return { ok: true, nomes: cache.nomes };
  try {
    const response = await viralFetch(`${apiUrl}/api/nichos`);
    if (response.ok && Array.isArray(response.data?.nichos)) {
      const nomes = response.data.nichos.map(nicho => String(nicho.nome));
      await chrome.storage.local.set({ [VIRAL_NICHOS_KEY]: { apiUrl, nomes, em: Date.now() } });
      return { ok: true, nomes };
    }
  } catch (error) {
    console.warn("[BG] Nichos indisponíveis:", error.message);
  }
  return { ok: true, nomes: cache?.nomes || VIRAL_NICHOS_PADRAO };
}

// Nicho recém-criado já vira pílula, sem esperar a próxima consulta.
async function viralLembrarNicho(apiUrl, nome) {
  const guardado = (await chrome.storage.local.get(VIRAL_NICHOS_KEY))[VIRAL_NICHOS_KEY];
  if (!nome || guardado?.apiUrl !== apiUrl || guardado.nomes.includes(nome)) return;
  await chrome.storage.local.set({ [VIRAL_NICHOS_KEY]: { ...guardado, nomes: [...guardado.nomes, nome] } });
}

// "Esse post já está salvo?"
async function viralStatus(url) {
  const post = viralParseUrl(url);
  if (!post) return { ok: false };
  try {
    const apiUrl = await viralApiUrl();
    const response = await viralFetch(`${apiUrl}/api/virais/consulta?url=${encodeURIComponent(post.url)}`);
    if (!response.ok || !response.data) return { ok: false };
    const { salvo, nicho, idioma, geo } = response.data;
    return { ok: true, salvo: Boolean(salvo), nicho: nicho || null, idioma: idioma || null, geo: geo || null };
  } catch (error) {
    console.warn("[BG] Consulta de post viral falhou:", error.message);
    return { ok: false };
  }
}

function viralMesmoPost(a, b) {
  return a.url === b.url && a.apiUrl === b.apiUrl;
}

async function viralEnqueue(pedido) {
  const post = viralParseUrl(pedido.url);
  if (!post) throw new Error("Este link não é um post.");
  const apiUrl = await viralApiUrl();
  const etiquetas = Object.fromEntries(VIRAL_ETIQUETAS.filter(nome => pedido[nome]).map(nome => [nome, String(pedido[nome])]));
  let id = null;
  await viralMutate(jobs => {
    const igual = jobs.find(job => job.status === "pendente" && !job.cancelar && viralMesmoPost(job, { url: post.url, apiUrl })
      && VIRAL_ETIQUETAS.every(nome => (job[nome] || "") === (etiquetas[nome] || "")));
    if (igual) {
      id = igual.id;
      return jobs;
    }
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return [...jobs, {
      id, apiUrl, url: post.url, plataforma: post.plataforma, autor: post.autor || pedido.autor || null,
      ...etiquetas, status: "pendente", tentativas: 0,
    }];
  });
  viralStart();
  return { ok: true, id };
}

// "Desfazer" tira o post que EU salvei, junto com correções que ainda estejam na fila.
async function viralUndo(id) {
  await viralMutate(jobs => {
    const alvo = jobs.find(job => job.id === id);
    if (!alvo) return jobs;
    const criado = jobs.find(job => viralMesmoPost(job, alvo) && job.status === "salvo" && job.podeDesfazer);
    return jobs.map(job => {
      if (job.id === id) {
        if (job.status === "salvo" && job.podeDesfazer) return { ...job, status: "removendo", tentativas: 0 };
        if (criado && (job.status === "pendente" || job.status === "falhou")) {
          return { ...job, status: "removendo", serverId: criado.serverId, cancelar: true, tentativas: 0 };
        }
        if (job.status === "pendente") return { ...job, cancelar: true };
        if (job.status === "falhou") return { ...job, status: "desfeito" };
        return job;
      }
      return viralMesmoPost(job, alvo) && job.status === "pendente" ? { ...job, cancelar: true } : job;
    });
  });
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
  const corpo = { url: job.url, autor: job.autor };
  for (const nome of VIRAL_ETIQUETAS) if (job[nome]) corpo[nome] = job[nome];
  const response = await viralFetch(`${job.apiUrl}/api/virais`, corpo);
  if (response.ok && response.data?.id) {
    const meu = (await viralRead()).some(outro => outro.apiUrl === job.apiUrl && outro.serverId === response.data.id && outro.criado);
    const podeDesfazer = Boolean(response.data.criado || meu);
    const atual = await viralGet(job.id); // o usuário pode ter pedido "Desfazer" durante o envio
    const status = !atual?.cancelar ? "salvo" : podeDesfazer ? "removendo" : "mantido";
    const nicho = response.data.nicho || atual?.nicho || null;
    await viralPatch(job.id, { status, serverId: response.data.id, criado: response.data.criado, podeDesfazer, nicho, erro: null, tentativas: 0 });
    await viralLembrarNicho(job.apiUrl, response.data.nicho);
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
  const response = await viralFetch(`${job.apiUrl}/api/virais/remover`, { id: job.serverId });
  if (response.ok) {
    // O post não existe mais: nenhum registro antigo pode continuar dizendo que o criou.
    await viralMutate(jobs => jobs.map(outro => {
      if (outro.id === job.id) return { ...outro, status: "desfeito", criado: false, erro: null };
      return outro.apiUrl === job.apiUrl && outro.serverId === job.serverId
        ? { ...outro, status: "desfeito", criado: false, podeDesfazer: false }
        : outro;
    }));
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
    : message?.action === "VIRAL_NICHOS" ? () => viralNichos()
    : message?.action === "VIRAL_STATUS" ? () => viralStatus(message.url)
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
