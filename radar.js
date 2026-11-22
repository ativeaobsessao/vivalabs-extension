// Radar diário: o "robozinho" que pesquisa sozinho as palavras-chave que você programa, em horários
// fixos, e joga o resultado no Centro de Inteligência (e no cofre da equipe).
// Reaproveita o motor do Turbo (janelas pequenas, uma por vez) — aqui só entram: agenda, ritmo humano,
// histórico por biblioteca (para detectar "subindo") e o resumo da rodada.
// Carregado pelo background.js via importScripts (depende de ranking_engine.js e intelligent_parser.js).

const RADAR_STORE = {
  config: "viva_radar_config",   // { on, keywords, country, everyH, tempoPorBusca }
  state: "viva_radar_state",     // { status, nextRunAt, lastRunAt, lastError, lastSummary, runs }
};
const RADAR_ALARM = "viva_radar_tick";
const RADAR_TICK_MIN = 5;                 // verifica a agenda a cada 5 min
const RADAR_INTERVALOS_H = [2, 4, 6, 12, 24];
const RADAR_MAX_KEYWORDS = 40;
const RADAR_TRAVA_MS = 4 * 3600 * 1000;
const RADAR_PAUSA_MIN_MS = 8000;          // pausa entre uma busca e a próxima (ritmo humano)
const RADAR_PAUSA_MAX_MS = 25000;

let radarDeps = {
  serial: fn => Promise.resolve().then(fn),
  iniciar: null,        // iniciarMineracaoInteligente
  ocupado: () => false, // há mineração em andamento?
  marcarSujos: async () => {},
  now: () => Date.now(),
};

function radarInit(deps) {
  radarDeps = { ...radarDeps, ...(deps || {}) };
}

function radarNormalizarConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const everyH = RADAR_INTERVALOS_H.includes(Number(c.everyH)) ? Number(c.everyH) : 6;
  const country = /^[A-Za-z]{2}$|^ALL$/i.test(String(c.country || "")) ? String(c.country).toUpperCase() : "US";
  const tempo = Math.max(20, Math.min(120, Number(c.tempoPorBusca) || 50));
  return {
    on: c.on === true,
    keywords: String(c.keywords || "").slice(0, 6000),
    country,
    everyH,
    tempoPorBusca: tempo,
  };
}

async function radarLerConfig() {
  const data = await chrome.storage.local.get(RADAR_STORE.config);
  return radarNormalizarConfig(data[RADAR_STORE.config]);
}

async function radarLerEstado() {
  const data = await chrome.storage.local.get(RADAR_STORE.state);
  const s = data[RADAR_STORE.state];
  return s && typeof s === "object" ? s : { status: "off", runs: [] };
}

async function radarGravarEstado(patch) {
  const atual = await radarLerEstado();
  const novo = { ...atual, ...patch };
  await chrome.storage.local.set({ [RADAR_STORE.state]: novo });
  return novo;
}

function radarFila(config) {
  return gerarFilaRadar(config.keywords, { country: config.country, maximo: RADAR_MAX_KEYWORDS });
}

// Liga/desliga o alarme conforme a configuração. Chamado ao acordar, ao instalar e ao salvar.
async function radarEnsureAlarm() {
  if (!chrome.alarms) return;
  const config = await radarLerConfig();
  if (config.on) {
    const existente = await chrome.alarms.get(RADAR_ALARM);
    if (!existente) chrome.alarms.create(RADAR_ALARM, { delayInMinutes: 1, periodInMinutes: RADAR_TICK_MIN });
  } else {
    await chrome.alarms.clear(RADAR_ALARM);
  }
}

// Mudou a configuração (popup): normaliza, grava o estado visível e agenda.
async function radarConfigChanged() {
  const config = await radarLerConfig();
  const estado = await radarLerEstado();
  if (!config.on) {
    await radarGravarEstado({ status: estado.status === "running" ? "running" : "off", nextRunAt: 0 });
  } else {
    const fila = radarFila(config);
    if (fila.length === 0) {
      await radarGravarEstado({ status: "error", lastError: "Coloque pelo menos uma palavra-chave (uma por linha)." });
    } else {
      const proxima = Number(estado.nextRunAt) > 0 ? estado.nextRunAt : radarDeps.now() + 60 * 1000;
      await radarGravarEstado({
        status: estado.status === "running" ? "running" : "waiting",
        nextRunAt: proxima,
        lastError: "",
      });
    }
  }
  await radarEnsureAlarm();
  if (config.on) radarTick({ force: false }).catch(() => {});
  return radarLerEstado();
}

// Chamado pelo alarme (e por "Rodar agora"): se for hora e nada estiver rodando, abre a rodada.
async function radarTick({ force = false } = {}) {
  const config = await radarLerConfig();
  if (!config.on) return { status: "off" };
  const estado = await radarLerEstado();
  // "running" há mais de 4h = rodada travada (navegador fechou no meio): libera para recomeçar.
  const travado = estado.status === "running" && radarDeps.now() - (Number(estado.startedAt) || 0) > RADAR_TRAVA_MS;
  if (estado.status === "running" && !travado) return { status: "running" };
  if (!force && radarDeps.now() < (Number(estado.nextRunAt) || 0)) return { status: "waiting" };
  if (radarDeps.ocupado()) return { status: "busy" };
  const fila = radarFila(config);
  if (fila.length === 0) {
    await radarGravarEstado({ status: "error", lastError: "Coloque pelo menos uma palavra-chave (uma por linha)." });
    return { status: "error" };
  }
  const agora = radarDeps.now();
  // Já agenda a próxima rodada: se esta falhar, o radar não fica tentando de 5 em 5 minutos.
  await radarGravarEstado({ status: "running", startedAt: agora, nextRunAt: agora + config.everyH * 3600 * 1000, lastError: "" });
  try {
    const resposta = await radarDeps.iniciar(
      config.keywords.split(/\r?\n/),
      {
        origem: "radar",
        country: config.country,
        maximo: RADAR_MAX_KEYWORDS,
        tempoPorBusca: config.tempoPorBusca,
        modoRapido: false,
        maxParallel: 1,
        pausaMinMs: RADAR_PAUSA_MIN_MS,
        pausaMaxMs: RADAR_PAUSA_MAX_MS,
      },
      true // o botão "Ligar radar" é a confirmação explícita
    );
    await radarGravarEstado({ runId: resposta && resposta.runId, total: resposta && resposta.total });
    return { status: "started", total: resposta && resposta.total };
  } catch (error) {
    await radarGravarEstado({ status: "error", lastError: error.message, nextRunAt: agora + 10 * 60 * 1000 });
    return { status: "error", error: error.message };
  }
}

// Consolida a rodada: atualiza o histórico por biblioteca, marca "subindo" e guarda o resumo.
// Roda dentro da fila serial do acervo (não corre contra gravações de outras abas).
async function radarConsolidar(agora = radarDeps.now()) {
  return radarDeps.serial(async () => {
    const dados = await chrome.storage.local.get(["viva_acervo", VIVA_HIST_KEY]);
    const acervo = Array.isArray(dados.viva_acervo) ? dados.viva_acervo : [];
    const hist = histRegistrar(dados[VIVA_HIST_KEY], acervo.filter(c => (agora - (Number(c.lastSeen) || 0)) < 36 * 3600 * 1000), agora);
    const { acervo: novoAcervo, mudou } = aplicarTendencias(acervo, hist, agora);
    await chrome.storage.local.set({ viva_acervo: novoAcervo, [VIVA_HIST_KEY]: hist });
    if (mudou.length) await radarDeps.marcarSujos(mudou);
    return { acervo: novoAcervo, mudou: mudou.length };
  });
}

// Fim da rodada do radar (chamado pelo finalizarMineracao quando origem === "radar").
async function radarAposRodada(state, resumo) {
  const agora = radarDeps.now();
  let subindo = 0;
  let novos = 0;
  try {
    const { acervo } = await radarConsolidar(agora);
    const inicio = Date.parse(state.startedAt) || 0;
    const daRodada = acervo.filter(c => (Number(c.lastSeen) || 0) >= inicio);
    subindo = daRodada.filter(c => tendenciaCriativo(c, agora).sobe).length;
    novos = daRodada.filter(c => (Number(c.firstSeen) || 0) >= inicio).length;
  } catch (error) {
    console.warn(`[BG][RADAR] consolidação falhou: ${error.message}`);
  }
  const config = await radarLerConfig();
  const estado = await radarLerEstado();
  const linha = {
    at: agora,
    criativos: resumo.criativos,
    emEscala: resumo.emEscala,
    bibliotecas: resumo.bibliotecas,
    novos,
    subindo,
    cancelada: state.status === "cancelled",
  };
  await radarGravarEstado({
    status: config.on ? "waiting" : "off",
    lastRunAt: agora,
    nextRunAt: config.on ? agora + config.everyH * 3600 * 1000 : 0,
    lastSummary: linha,
    lastError: "",
    runs: [linha, ...(Array.isArray(estado.runs) ? estado.runs : [])].slice(0, 10),
  });
  console.log(`[BG][RADAR] rodada concluída: ${resumo.criativos} criativos, ${resumo.emEscala} em escala, ${novos} novos, ${subindo} subindo`);
}

// Rodada interrompida (cancelada ou falhou) — só devolve o radar ao modo de espera.
async function radarRodadaInterrompida(motivo) {
  const config = await radarLerConfig();
  const estado = await radarLerEstado();
  if (estado.status !== "running") return;
  await radarGravarEstado({
    status: config.on ? (motivo === "failed" ? "error" : "waiting") : "off",
    lastError: motivo === "failed" ? "A última rodada falhou; vou tentar de novo no próximo horário." : "",
  });
}

function radarHandleAlarm(alarm) {
  if (alarm && alarm.name === RADAR_ALARM) radarTick({ force: false }).catch(error => console.warn(`[BG][RADAR] ${error.message}`));
}

function radarRegistrarEventos() {
  try {
    if (chrome.alarms && chrome.alarms.onAlarm) chrome.alarms.onAlarm.addListener(radarHandleAlarm);
    // O Chrome zera os alarmes ao reiniciar: sem estes ganchos o radar ficaria parado depois de um reboot.
    if (chrome.runtime && chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => radarEnsureAlarm().catch(() => {}));
    if (chrome.runtime && chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => radarEnsureAlarm().catch(() => {}));
    radarEnsureAlarm().catch(() => {});
  } catch (error) {
    console.warn(`[BG][RADAR] agenda indisponível: ${error.message}`);
  }
}
