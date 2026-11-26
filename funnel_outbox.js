// Fila de envio do "Salvar Funil" (carregada pelo background.js via importScripts).
// O content script só grava o funil aqui (milissegundos) e fecha o modal; o envio ao servidor, que
// pode levar dezenas de segundos (backend hibernado), acontece em segundo plano, sobrevive ao
// fechamento da aba e é reenviado sozinho se falhar. Nada sai da fila sem ter sido salvo.
// Depende de getNextFunilSequence() e incrementFunilSequence() do background.js.

const FUNNEL_OUTBOX_KEY = "viva_funnel_outbox";
const FUNNEL_RESULT_KEY = "viva_funnel_result";
const FUNNEL_ALARM = "viva-funnel-outbox";
const FUNNEL_TIMEOUT_MS = 25000; // abaixo dos 30s em que o Chrome encerra o service worker
const FUNNEL_MAX_ERROS_SERVIDOR = 5;
const FUNNEL_MAX_ERROS_REDE = 30;
const FUNNEL_MAX_FALHADOS = 20;

let funnelLock = Promise.resolve();
let funnelRunning = null;
let funnelRunAgain = false;

async function funnelRead() {
  const data = await chrome.storage.local.get(FUNNEL_OUTBOX_KEY);
  return Array.isArray(data[FUNNEL_OUTBOX_KEY]) ? data[FUNNEL_OUTBOX_KEY] : [];
}

// Um único escritor por vez: um funil enfileirado durante um envio nunca é sobrescrito.
function funnelMutate(change) {
  const run = funnelLock.then(async () => {
    await chrome.storage.local.set({ [FUNNEL_OUTBOX_KEY]: change(await funnelRead()) });
  });
  funnelLock = run.catch(() => {});
  return run;
}

function funnelUpdate(job) {
  return funnelMutate(list => list.map(item => (item.id === job.id ? job : item)));
}

function funnelScheduleRetry() {
  if (chrome.alarms) chrome.alarms.create(FUNNEL_ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
}

function funnelFingerprint(job) {
  return `${job.slug}|${job.etapas.map(etapa => etapa.url).join("|")}`;
}

async function funnelEnqueue(job) {
  const valid = job && job.id && job.apiUrl && job.nome && Array.isArray(job.etapas) && job.etapas.length > 0;
  if (!valid) throw new Error("Funil incompleto.");
  const novo = { ...job, status: "pendente", errosServidor: 0, errosRede: 0 };
  const chave = funnelFingerprint(novo);
  // Salvar de novo o mesmo funil substitui a versão que ainda estava na fila.
  await funnelMutate(list => [...list.filter(item => funnelFingerprint(item) !== chave), novo]);
  funnelScheduleRetry(); // rede de segurança caso o service worker morra no meio do envio
  funnelProcess().catch(error => console.error("[BG] Fila de funis:", error.message));
  return { ok: true, id: novo.id };
}

function funnelProcess() {
  if (funnelRunning) {
    funnelRunAgain = true;
    return funnelRunning;
  }
  funnelRunning = (async () => {
    do {
      funnelRunAgain = false;
      await funnelDrain();
    } while (funnelRunAgain);
  })().finally(() => { funnelRunning = null; });
  return funnelRunning;
}

async function funnelDrain() {
  const pendentes = (await funnelRead()).filter(job => job.status === "pendente");
  for (const job of pendentes) {
    const outcome = await funnelSend(job);
    if (outcome === "sem-rede") break;
  }
  const restam = (await funnelRead()).some(job => job.status === "pendente");
  if (restam) funnelScheduleRetry();
  else if (chrome.alarms) await chrome.alarms.clear(FUNNEL_ALARM);
}

async function funnelFetch(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FUNNEL_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timeoutId);
  }
}

function funnelPost(url, body) {
  return funnelFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function funnelIsTemporary(status) {
  return status >= 500 || status === 408 || status === 429;
}

function funnelParseJson(text) {
  try { return JSON.parse(text); } catch (error) { return null; }
}

// Se o anunciante já era monitorado, as etapas vão para o slug dele (autoridade do servidor).
async function funnelResolveSlug(job, saveResponse) {
  const saved = saveResponse.ok ? funnelParseJson(saveResponse.text) : null;
  const slug = saved?.slug || saved?.player?.slug || job.slug;
  try {
    const response = await funnelFetch(`${job.apiUrl}/api/paginas`, { cache: "no-store" });
    const pages = response.ok ? funnelParseJson(response.text) : null;
    if (!Array.isArray(pages)) return slug;
    const nome = job.nome.toLowerCase().trim();
    const match = job.pageId
      ? pages.find(p => p?.tipo === "pagina" && p.url && p.url.includes(job.pageId))
      : pages.find(p => p && p.tipo === job.registro.tipo && (
        (p.nome || "").toLowerCase().trim() === nome
        || (p.slug && (p.slug === slug || p.slug === job.slug))
        || Boolean(job.urlPageId && p.url && p.url.includes(job.urlPageId))
      ));
    return match?.slug || slug;
  } catch (error) {
    console.warn("[BG] Lista de monitorados indisponível:", error.message);
    return slug;
  }
}

async function funnelRegister(job) {
  const response = await funnelPost(`${job.apiUrl}/api/salvar`, { nome: job.nome, ...job.registro });
  if (funnelIsTemporary(response.status)) {
    return { error: `HTTP ${response.status} ao cadastrar o anunciante` };
  }
  job.slugFinal = await funnelResolveSlug(job, response);
  await funnelUpdate(job);
  return { error: null };
}

async function funnelApplyAutoLabel(job) {
  if (!job.autoLabel) return;
  try {
    const sequence = await getNextFunilSequence(job.pageId);
    if (sequence?.proximo) job.etapas[0].rotulo = sequence.proximo;
  } catch (error) {
    console.warn("[BG] Sequencial indisponível; mantendo rótulo local:", error.message);
  }
  job.autoLabel = false;
  await funnelUpdate(job);
}

async function funnelSaveSteps(job) {
  let temporaryError = null;
  for (let i = 0; i < job.etapas.length; i++) {
    const etapa = job.etapas[i];
    if (etapa.salva || etapa.erro) continue;
    const response = await funnelPost(`${job.apiUrl}/api/funis/salvar-node`, {
      slug: job.slugFinal,
      tipo: etapa.tipo,
      rotulo: etapa.rotulo,
      url: etapa.url,
      checkout_url: job.etapas[i + 1] ? job.etapas[i + 1].url : null,
    });
    const detail = `${etapa.rotulo}: HTTP ${response.status} ${response.text.slice(0, 120)}`;
    if (response.ok) {
      etapa.salva = true;
      await funnelUpdate(job);
      if (etapa.tipo === "ads" && job.pageId) {
        await incrementFunilSequence(job.pageId, 1, job.registro.ads_count_inicial, [etapa.rotulo])
          .catch(error => console.warn("[BG] Sequencial local não atualizado:", error.message));
      }
    } else if (funnelIsTemporary(response.status)) {
      temporaryError = detail;
    } else {
      etapa.erro = detail;
      await funnelUpdate(job);
    }
  }
  return temporaryError;
}

function funnelPublish(job, status, message) {
  return chrome.storage.local.set({
    [FUNNEL_RESULT_KEY]: { id: job.id, nome: job.nome, status, message, ts: Date.now() },
  });
}

async function funnelFail(job, reason) {
  job.status = "falhou";
  await funnelMutate(list => {
    const next = list.map(item => (item.id === job.id ? job : item));
    const excess = next.filter(item => item.status === "falhou").slice(0, -FUNNEL_MAX_FALHADOS);
    return next.filter(item => !excess.includes(item));
  });
  const salvas = job.etapas.filter(etapa => etapa.salva).length;
  await funnelPublish(job, "falhou", `${salvas} de ${job.etapas.length} etapa(s) no servidor. ${reason}`);
  return "falhou";
}

async function funnelRetryLater(job, kind, reason) {
  const field = kind === "sem-rede" ? "errosRede" : "errosServidor";
  const limit = kind === "sem-rede" ? FUNNEL_MAX_ERROS_REDE : FUNNEL_MAX_ERROS_SERVIDOR;
  job[field] += 1;
  if (job[field] >= limit) return funnelFail(job, reason);
  await funnelUpdate(job);
  if (job[field] === 1) await funnelPublish(job, "tentando", reason);
  return kind;
}

async function funnelSend(job) {
  try {
    if (!job.slugFinal) {
      const { error } = await funnelRegister(job);
      if (error) return await funnelRetryLater(job, "servidor", error);
    }
    await funnelApplyAutoLabel(job);
    const temporaryError = await funnelSaveSteps(job);
    if (temporaryError) return await funnelRetryLater(job, "servidor", temporaryError);

    const rejected = job.etapas.find(etapa => etapa.erro);
    if (rejected) return await funnelFail(job, rejected.erro);

    await funnelMutate(list => list.filter(item => item.id !== job.id));
    await funnelPublish(job, "ok", `${job.etapas.length} etapa(s) · ${job.etapas[0].rotulo}`);
    return "ok";
  } catch (error) {
    console.warn("[BG] Envio de funil adiado:", error.message);
    return funnelRetryLater(job, "sem-rede", "Servidor não respondeu.");
  }
}

// Ao reabrir o navegador ou atualizar a extensão, o que tinha falhado ganha nova chance.
async function funnelRevive() {
  await funnelMutate(list => list.map(job => ({
    ...job,
    status: "pendente",
    errosServidor: 0,
    errosRede: 0,
    etapas: job.etapas.map(({ erro, ...etapa }) => etapa),
  })));
  await funnelProcess();
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === FUNNEL_ALARM) funnelProcess().catch(error => console.error("[BG] Fila de funis:", error.message));
  });
}
for (const event of [chrome.runtime.onStartup, chrome.runtime.onInstalled]) {
  if (event) event.addListener(() => funnelRevive().catch(error => console.error("[BG] Fila de funis:", error.message)));
}
