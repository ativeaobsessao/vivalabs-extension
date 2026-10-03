// VIVA Labs Helper - Main Content Script (Meta Ad Library)

// Limpa um id residual de modal após navegação do histórico. Não executar no carregamento
// inicial: links salvos usam id intencionalmente para abrir o anúncio, e a Meta pode remover
// o fragmento viva_pin antes deste content script rodar em document_idle.
const initialAdLinkIntent = (() => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  return id ? { id, pageId: params.get("view_all_page_id") || params.get("page_id") || "" } : null;
})();

function checkAndCleanAdModalUrl() {
  try {
    console.log("[VIVA-DEBUG] checkAndCleanAdModalUrl rodou. href atual:", window.location.href);
    if (!window.location.search.includes("search_type=page") || !window.location.search.includes("view_all_page_id=")) return;
    if (window.location.hash.includes("viva_pin=1")) {
      console.log("[VIVA-DEBUG] viva_pin detectado no hash — saindo sem limpar o id=.");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const pageId = params.get("view_all_page_id") || params.get("page_id") || "";
    if (initialAdLinkIntent && params.get("id") === initialAdLinkIntent.id && (!initialAdLinkIntent.pageId || pageId === initialAdLinkIntent.pageId)) return;
    if (params.get("search_type") === "page" && params.has("id") && params.has("view_all_page_id")) {
      console.log("[VIVA-DEBUG] APAGANDO id= agora! hash no momento da decisão:", window.location.hash);
      params.delete("id");
      const cleanUrl = window.location.pathname + "?" + params.toString();
      window.location.replace(cleanUrl);
    }
  } catch (e) {}
}
window.addEventListener("popstate", checkAndCleanAdModalUrl);

// ─── Variáveis Globais de Estado ──────────────────────────────────────────────
let API_URL = "https://viva-labs-monitor.onrender.com";
let monitoredPages = [];
let cardSignatures = {};
let isAutoScrollRunning = false;
let autoScrollTimer = null;
let autoScrollInterval = 7000;
let lastUrl = window.location.href;
let activeCardData = [];
let globalDropdownListenerAdded = false;
let vivaMonitorMasterEnabled = true;
let rankingOverlayPaused = false;
let latestIntelligentRanking = [];
let _vivaRankingOverlayState = null;
let _vivaRankingFeatureLogShown = false;
let _vivaIntelligentMessageListener = null;
let motorStats = { count: 0, time: 0, lastUpdate: 0 };
let lastSweepTime = 0;
let lastMotorUpdate = 0;
let motorUpdateScheduled = false;

function updateMotorVivaLeve(count, timeMs) {
  motorStats = { count, time: timeMs, lastUpdate: Date.now() };
  if (motorUpdateScheduled) return;
  motorUpdateScheduled = true;
  requestAnimationFrame(() => {
    motorUpdateScheduled = false;
    const text = `⚡ O(1) · ${motorStats.time.toFixed(1)}ms (${motorStats.count} ads)`;
    const status = document.getElementById("viva-motor-status");
    if (status) status.textContent = text;
    const health = document.getElementById("viva-engine-health");
    if (health) health.textContent = text;

    const now = Date.now();
    if (now - lastMotorUpdate >= 1000) {
      lastMotorUpdate = now;
      console.info(`[VIVA] Motor cycle ${motorStats.time.toFixed(1)}ms (${motorStats.count} ads)`);
    }
  });
}

// FIX ITEM 12 (2026-08): cachedContingencyStatus/cachedContingencyChecked removidos junto com
// checkContingencyStatus() (ver nota mais abaixo) — existiam só para essa função nunca chamada.

// FIX DE ESCALA (buscas com dezenas de milhares de resultados): fila de nós recém-adicionados
// detectados pelo MutationObserver principal. getAdCards() consome esta fila para restringir
// sua varredura de "botões/links" a apenas o que mudou, em vez de escanear a página inteira
// a cada ciclo — o gargalo real de performance em buscas grandes com rolagem longa.
let pendingScanRoots = [];

// FIX PERF (2026-08) — causa raiz da demora ao clicar em "Ações" após rolar bastante: quando
// pendingScanRoots está vazia (o caso comum de um scroll puro, sem conteúdo novo carregando),
// getAdCards() caía num fallback que escaneava document.querySelectorAll("[role='button'],
// button, a") — A PÁGINA INTEIRA — em TODO ciclo de processCards() (todo scroll parado, cada
// ~300ms de debounce). Em telas com centenas/milhares de ads, isso sozinho já respondia pela
// maior fatia do tempo de ciclo (103ms+ observados com 630 ads), e como JS é single-thread,
// se esse ciclo estiver rodando bem na hora do clique em "Ações", a resposta visual do menu
// fica visivelmente atrasada. O MutationObserver principal já é 100% responsável por alimentar
// pendingScanRoots com qualquer nó genuinamente novo — não há necessidade de repetir a
// varredura cara em todo ciclo sem novidade; ela agora roda no máximo 1x a cada
// FULL_SCAN_MIN_INTERVAL_MS, como rede de segurança, não como caminho comum.
let lastFullScanTime = 0;
const FULL_SCAN_MIN_INTERVAL_MS = 15000;

// ─── VIVA Lifecycle Management (Cleanup Architecture) ───────────────────────
// Cada referência aqui é limpa pelo teardownVivaMonitor() para zero listeners órfãos.
let _vivaMainObserver = null;      // MutationObserver principal
let _vivaSidebarIntervalId = null; // setInterval de polling de nome/Instagram
let _vivaUrlIntervalId = null;     // setInterval de detecção de mudança de URL
let _vivaScrollHandler = null;     // Handler de scroll (processCards debounced)
let _vivaScrollTopHandler = null;  // Handler de scroll do botão "ir ao topo"
let _vivaFastScrollHandler = null; // Handler de scroll do detector de velocidade (Fast-Scroll Bypass)
let _vivaInitialized = false;      // Guard contra múltiplas inicializações

// AUDITORIA #13: a antiga declaração de módulo `const VIVA_SEARCH_ROOTS = new WeakSet();` foi
// removida daqui. Ela nunca era lida nem escrita em lugar nenhum do arquivo — a variável de
// mesmo nome declarada dentro de init() (ver mais abaixo) sombreava (shadow) esta a cada
// execução, e é aquela versão local que indexSearchContainers() e o MutationObserver principal
// de fato usam. O comentário original dizia "escopo de módulo para acesso no teardown", mas
// nenhum código de teardown jamais a referenciou — código morto puro, sem efeito no
// comportamento real da extensão. Mantida apenas a declaração local dentro de init().

// ─── VIVA Eco-RAM Shield: Cache WeakMap & Virtualizador de Mídia ───
const cardDataMap = new WeakMap();

// FIX 4.4 (dirty-check do reflow — ver processCards): rastreia containers de grade que já
// receberam a configuração flex-wrap nesta sessão, para nunca reescrever as mesmas propriedades
// !important no mesmo nó repetidamente a cada ciclo.
const _vivaConfiguredFlexParents = new WeakSet();

// ─── VIVA Fast-Scroll Velocity Bypass Engine ───
let isFastScrolling = false;
let fastScrollTimeout = null;
let lastScrollY = window.scrollY || 0;
let lastScrollTime = Date.now();
let batchingWatchdogTimeout = null;
let lastCycleDurationMs = 0;

// AUDITORIA #08: antes este listener era uma função anônima passada direto para
// addEventListener — sem nenhuma referência salva em variável, era estruturalmente impossível
// removê-lo via removeEventListener (não existe forma de "desregistrar uma função que você
// nunca guardou"). Nomeada e guardada em _vivaFastScrollHandler, no mesmo padrão de lifecycle
// já usado para _vivaScrollHandler/_vivaScrollTopHandler — agora pode ser removido em
// teardownVivaMonitor(true) (desligamento real via toggle) e reconectado em
// ensureVivaBackgroundServicesRunning() ao religar.
_vivaFastScrollHandler = () => {
  const currentScrollY = window.scrollY || 0;
  const now = Date.now();
  const timeDelta = Math.max(1, now - lastScrollTime);
  const distDelta = Math.abs(currentScrollY - lastScrollY);
  const velocity = (distDelta / timeDelta) * 1000; // pixels per second

  lastScrollY = currentScrollY;
  lastScrollTime = now;

  if (velocity > 1400) {
    isFastScrolling = true;
    clearTimeout(fastScrollTimeout);
    fastScrollTimeout = setTimeout(() => {
      isFastScrolling = false;
      processCards();
    }, 180);
  }
};
window.addEventListener("scroll", _vivaFastScrollHandler, { passive: true });

// ─── VIVA Interaction Bypass: Zero-Lag nos filtros nativos da Meta (GEO/Tipo/Palavra-chave) ───
// Problema original: os menus de GEO, Tipo de Anúncio e a caixa de busca por palavra-chave da
// própria Meta são portais que o React re-renderiza a cada tecla digitada ou item filtrado.
// O MutationObserver principal via essas mutações e rodava toda a lógica pesada de detecção de
// cards a cada keystroke, fazendo o clique/digitação nesses campos parecer travado. Esta blindagem
// usa 'focusin' em captura (funciona em QUALQUER elemento, onde quer que a Meta o renderize no DOM,
// sem depender de sua posição na árvore) para saber que o usuário está interagindo com um controle
// nativo, e libera o observer principal para pular o processamento pesado enquanto isso.
let isInteractingWithNativeControl = false;
let nativeInteractionTimeout = null;

document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (!t || (t.closest && (t.closest("#viva-sidebar") || t.closest(".viva-processed")))) return;
  const tag = t.tagName;
  const role = t.getAttribute ? t.getAttribute("role") : null;
  if (tag === "INPUT" || tag === "TEXTAREA" || role === "combobox" || role === "searchbox" || role === "textbox") {
    isInteractingWithNativeControl = true;
  }
}, true);

document.addEventListener("focusout", () => {
  clearTimeout(nativeInteractionTimeout);
  nativeInteractionTimeout = setTimeout(() => {
    isInteractingWithNativeControl = false;
  }, 250);
}, true);

const mediaPruningObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const card = entry.target;
    if (!card.isConnected) {
      mediaPruningObserver.unobserve(card);
      return;
    }
    const videos = card.querySelectorAll("video");
    const images = card.querySelectorAll("img");

    if (!entry.isIntersecting) {
      videos.forEach(video => {
        // Zero-Lag Apple Media Shield: Apenas pausa o vídeo se estiver rodando e não tiver sido acionado ativamente pelo operador.
        // NUNCA remove o atributo 'src' nem força 'video.load()', evitando colisão com os buffers MSE nativos do Facebook.
        if (!video.paused && !video.dataset.vivaInteracted) {
          try { video.pause(); } catch(e) {}
        }
      });
      // Zero-Lag & Instant Media: NUNCA removemos o src de imagens! Mantemos no cache da GPU/RAM para exibição instantânea na rolagem.
    } else {
      // Quando o card entra na tela, se não estiver rolando freneticamente (Fast-Scroll Bypass), pré-aquece o buffer
      if (!isFastScrolling) {
        videos.forEach(video => {
          if (!video.getAttribute("preload") || video.getAttribute("preload") === "none") {
            video.setAttribute("preload", "metadata");
          }
          if (!video.hasAttribute("playsinline")) {
            video.setAttribute("playsinline", "");
          }
        });
        images.forEach(img => {
          if (!img.getAttribute("decoding")) {
            img.setAttribute("decoding", "async");
          }
        });
      }
    }
    setupAdModalObserver();
  });
}, { rootMargin: "400px 0px 400px 0px" });

// FIX 4.3: gate de proximidade da viewport para a injeção PESADA de badges/rodapé (criação de
// nós DOM, templates de innerHTML). O filtro show/hide (reflow) continua rodando para TODOS os
// cards descobertos, perto ou não da tela — só a criação em si dos badges/rodapé é adiada até o
// card estar perto o bastante pra valer a pena gastar o ciclo com ele. Em buscas com dezenas de
// milhares de resultados, a própria Meta pré-renderiza um buffer de cards no DOM muito além do
// que o usuário está vendo agora; sem este gate, todos eles ganhavam badges imediatamente.
const nearViewportCards = new WeakSet();
const viewportProximityObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const card = entry.target;
    if (!card.isConnected) {
      viewportProximityObserver.unobserve(card);
      return;
    }
    if (entry.isIntersecting) {
      nearViewportCards.add(card);
    } else {
      nearViewportCards.delete(card);
    }
  });
}, { rootMargin: "1500px 0px 1500px 0px" });

// Adiciona ouvinte global para proteger vídeos onde o operador clicou no Play
window.addEventListener("play", (e) => {
  if (e.target && e.target.nodeName === "VIDEO") {
    e.target.dataset.vivaInteracted = "true";
  }
}, true);

// Filtros Globais
// FIX ITEM 11 (2026-08): hideRecent/hideNonScaled removidos — eram declarados e lidos na
// lógica de shouldShow, mas nenhum controle de UI (sidebar ou dock) jamais os ligava; sempre
// false, então as duas condições que os usavam nunca tinham efeito algum. Código morto puro,
// sem mudança de comportamento ao remover.
let filterOnlyRecent = false;
let minPageAds = 0; 
let minDupAds = 0;

// AUDITORIA #06 (crítico — XSS): nenhuma função de escape de HTML existia nesta arquitetura de
// card-frame (o backend index.js tem escAttr() para o mesmo propósito, e uma versão anterior
// desta extensão já havia adotado vivaEscapeHtml() — reintroduzida aqui). Nome do anunciante,
// nome da página, domínio/slug de destino e link do Instagram são todos extraídos do DOM da
// própria Meta Ad Library — texto que qualquer anunciante controla ao configurar seu
// anúncio/página — e vários desses valores são interpolados direto em innerHTML sem nenhuma
// sanitização, permitindo injeção de markup/atributos arbitrários que executariam no contexto
// do content script (com acesso a chrome.storage, ao DOM da página e à API do backend). Escapa
// & < > " ' — seguro tanto em texto quanto dentro de atributos entre aspas (todo uso neste
// arquivo delimita atributos com aspas duplas ou simples).
function vivaEscapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Helper: Extração de Metadados Globais do DOM da Meta ───────────────────

function getRootDomain(url) {
  try {
    let hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length > 2) {
      if (parts[parts.length - 2] === "com" || parts[parts.length - 2] === "net" || parts[parts.length - 2] === "org") {
        return parts.slice(-3).join(".");
      }
      return parts.slice(-2).join(".");
    }
    return hostname;
  } catch (e) {
    return "";
  }
}

function extractCleanDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    let clean = url.replace(/^(https?:\/\/)?(www\.)?/, "");
    clean = clean.split("/")[0].split("?")[0];
    return clean;
  }
}

// FIX LINK (2026-08): "mesmo link" = hostname (com subdomínio) + primeiro segmento do path
// (slug), quando existir. Mais preciso que agrupar só por domínio — antes, duas ofertas
// completamente diferentes no mesmo site (ex: site.com/oferta-a e site.com/oferta-b) caíam
// no mesmo grupo só por dividirem o hostname. Agora só agrupa quando é literalmente a mesma
// página de destino.
function extractDestinationLinkKey(url) {
  try {
    const u = new URL(url);
    const firstSegment = u.pathname.split("/").filter(Boolean)[0] || "";
    return firstSegment ? `${u.hostname}/${firstSegment}` : u.hostname;
  } catch (e) {
    return extractCleanDomain(url);
  }
}

function cleanInstagramUrl(url) {
  if (!url) return "";
  try {
    let clean = url.trim();
    // Desencapsula redirecionadores do Facebook (l.facebook.com, lm.facebook.com, facebook.com/l.php)
    if (clean.includes("facebook.com/l.php") || clean.includes("l.facebook.com") || clean.includes("lm.facebook.com")) {
      const urlObj = new URL(clean.startsWith("http") ? clean : `https://${clean}`);
      const target = urlObj.searchParams.get("u");
      if (target) {
        clean = decodeURIComponent(target);
      }
    }

    if (/^@[a-zA-Z0-9_.]+$/.test(clean)) {
      return `https://www.instagram.com/${clean.substring(1)}`;
    }
    if (clean.startsWith("instagram.com") || clean.startsWith("www.instagram.com")) {
      clean = `https://${clean}`;
    }
    if (clean.includes("instagram.com")) {
      const uObj = new URL(clean.startsWith("http") ? clean : `https://${clean}`);
      return `${uObj.origin}${uObj.pathname}`.replace(/\/+$/, "");
    }
    return clean;
  } catch (e) {
    return url;
  }
}

// FIX 4.1 (gargalo de inicialização): esta função só lê chrome.storage.local — é 100% local,
// sem rede, e resolve quase instantaneamente. Antes, loadConfig() também esperava
// fetchMonitoredPages() terminar antes de devolver o controle para init(), o que travava a
// sidebar/observer/processCards inteiros caso o backend (Render.com, plano free) estivesse
// hibernado. Agora só carrega a URL da API salva; a chamada de rede roda separada e em paralelo.
async function loadLocalApiUrl() {
  const data = await chrome.storage.local.get("viva_monitor_api_url");
  if (data.viva_monitor_api_url) {
    API_URL = data.viva_monitor_api_url;
  }
}

// FIX 4.1: fire-and-forget, nunca bloqueia a UI. Usa AbortController porque fetch() nativo não
// tem timeout embutido — sem isso, um backend hibernado podia travar a chamada por dezenas de
// segundos. A extensão assume "ainda não sei se está monitorado" (monitoredPages = []) até a
// resposta chegar (ou nunca chegar), e nunca espera por isso pra renderizar o painel.
async function fetchMonitoredPages() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${API_URL}/api/paginas`, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = await res.json();
    if (!Array.isArray(records)) throw new Error("Resposta inválida ao consultar monitorados.");
    monitoredPages = records;
    // A resposta pode chegar depois do painel já estar na tela — atualiza o botão
    // "Monitorar no VIVA Labs" / "✓ Monitorado" retroativamente, se o painel já existir.
    if (document.getElementById("viva-sidebar")) {
      const pageTitle = getPageNameFromHeader();
      if (pageTitle) checkMonitoredStatus(pageTitle);
      checkKeywordMonitoredStatus();
    }
  } catch (e) {
    console.warn("[VIVA] Monitorados indisponíveis agora (timeout ou backend hibernado):", e.message);
  } finally {
    clearTimeout(timeoutId);
  }
}

function getPageNameFromHeader() {
  // 1. Tenta extrair direto do primeiro card renderizado (100% à prova de falhas se o card existir)
  const firstCard = document.querySelector(".viva-processed");
  if (firstCard) {
    const allTextEls = firstCard.querySelectorAll("span, div[dir='auto'], h4");
    for (let i = 0; i < allTextEls.length; i++) {
      const text = allTextEls[i].textContent.trim();
      if (text.toLowerCase() === "patrocinado" || text.toLowerCase() === "sponsored") {
        // O nome do anunciante é o elemento de texto imediatamente anterior
        for (let j = i - 1; j >= 0; j--) {
          const prevText = allTextEls[j].textContent.trim();
          if (prevText && prevText.length > 2 && prevText !== "Ativo" && prevText !== "Inativo" && !prevText.includes("anúncios usam")) {
            return prevText;
          }
        }
      }
    }
  }

  // 2. Fallback para buscas por palavra-chave na URL
  const params = new URLSearchParams(window.location.search);
  const searchQuery = params.get("q");
  if (searchQuery) return searchQuery;

  return "";
}

function getInstagramUrlFromHeader() {
  // 1. Prioridade: detecção via React Fiber ou Network Interceptor (MAIN world)
  if (document.documentElement.dataset && document.documentElement.dataset.vivaDetectedInstagram) {
    return cleanInstagramUrl(document.documentElement.dataset.vivaDetectedInstagram);
  }

  // 2. Busca direta O(1) em links do DOM com desencapsulamento de l.facebook.com
  const igLinks = document.querySelectorAll("a[href*='instagram.com'], a[href*='l.facebook.com/l.php?u=']");
  for (const a of igLinks) {
    const rawHref = a.getAttribute("href") || a.href || "";
    const lynx = a.getAttribute("data-lynx-uri") || "";
    const cleaned = cleanInstagramUrl(rawHref) || cleanInstagramUrl(lynx);
    if (cleaned && cleaned.includes("instagram.com") && !cleaned.includes("facebook.com/ads/library")) {
      return cleaned;
    }
  }

  // 3. Fallback: botões e links com aria-label ou title
  const igElements = document.querySelectorAll("[aria-label*='Instagram' i], [aria-label*='instagram' i], [title*='Instagram' i], [title*='instagram' i]");
  for (const el of igElements) {
    const href = el.getAttribute("href") || el.getAttribute("data-href") || "";
    if (href) {
      const cleaned = cleanInstagramUrl(href);
      if (cleaned && cleaned.includes("instagram.com")) return cleaned;
    }
    const text = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
    const handleMatch = text.match(/@([a-zA-Z0-9_.]+)/);
    if (handleMatch && handleMatch[1]) {
      return `https://www.instagram.com/${handleMatch[1]}`;
    }
  }

  // 4. Fallback no container de transparência da página / diálogo "Sobre esta Página"
  const dialogs = document.querySelectorAll("[role='dialog'], [aria-label*='Sobre' i], [aria-label*='About' i], [role='tabpanel']");
  for (const dialog of dialogs) {
    const link = dialog.querySelector("a[href*='instagram.com'], a[href*='facebook.com/l.php']");
    if (link) {
      const cleaned = cleanInstagramUrl(link.getAttribute("href") || link.href);
      if (cleaned && cleaned.includes("instagram.com")) return cleaned;
    }
    const text = dialog.textContent || "";
    const match = text.match(/(?:instagram\.com\/|@)([a-zA-Z0-9_.]+)/i);
    if (match && match[1] && !["facebook", "meta", "about", "ads", "instagram"].includes(match[1].toLowerCase())) {
      return `https://www.instagram.com/${match[1]}`;
    }
  }

  return "";
}

function toSlug(nome) {
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getAdCards(scanRoots) {
  // 1. Coleta instantânea de cartões já carimbados (O(1) no cache do DOM sem subir a árvore)
  const processed = Array.from(document.querySelectorAll(".viva-processed")).filter(el => el.isConnected);

  // 1.5. Coleta prioritária dos cartões identificados em memória pelo nosso react_sniffer (React Fiber)
  const byFiber = Array.from(document.querySelectorAll("[data-viva-page-id]:not(.viva-processed)")).filter(el => {
    if (!el.isConnected || !el.querySelector("img, video")) return false;
    const txt = el.textContent || "";
    return txt.includes("Patrocinado") || txt.includes("Sponsored");
  });

  // 2. Coleta direcionada para botões de resumo/detalhes de novos cartões não processados
  // FIX DE ESCALA: se o MutationObserver já sabe exatamente quais nós foram adicionados
  // (scanRoots), restringe a busca a eles em vez de escanear TODO o documento a cada ciclo.
  // Em buscas com dezenas de milhares de resultados, escanear a página inteira a cada
  // mutação (rolagem infinita) é o que trava a aba — isso reduz o custo de O(página toda)
  // para O(apenas o que mudou desde o último ciclo).
  const useScoped = Array.isArray(scanRoots) && scanRoots.length > 0;
  const candidateSet = new Set();
  if (useScoped) {
    scanRoots.forEach(root => {
      if (!root || root.nodeType !== 1 || !root.isConnected) return;
      if (root.matches && root.matches("[role='button'], button, a")) candidateSet.add(root);
      if (root.querySelectorAll) {
        root.querySelectorAll("[role='button'], button, a").forEach(el => candidateSet.add(el));
      }
    });
  } else {
    // FIX PERF: ver nota de arquitetura junto de lastFullScanTime/FULL_SCAN_MIN_INTERVAL_MS no
    // topo do arquivo. Sem scanRoots (scroll puro, sem novidade) NÃO significa mais "escaneia a
    // página inteira agora" — só faz isso se já faz tempo que não confirmamos que nada escapou
    // do MutationObserver. Na prática, a esmagadora maioria dos ciclos passa direto por aqui
    // sem tocar em document.querySelectorAll("[role='button'], button, a") nunca mais.
    const now = Date.now();
    if (now - lastFullScanTime > FULL_SCAN_MIN_INTERVAL_MS) {
      lastFullScanTime = now;
      document.querySelectorAll("[role='button'], button, a").forEach(el => candidateSet.add(el));
    }
  }

  const rawButtons = Array.from(candidateSet).filter(el => {
    if (el.children.length > 2) return false;
    if (el.closest && (el.closest(".viva-processed") || el.closest("header") || el.closest("#viva-sidebar") || el.closest("form") || el.closest("[role='combobox']") || el.closest("[role='listbox']") || el.closest("[role='dialog']"))) {
      return false;
    }
    const text = el.textContent || "";
    if (text.length > 45 || text.length < 10) return false;
    return /^(Ver detalhes do anúncio|View ad details|Ver resumo|View summary|Ver detalhes|View details)$/i.test(text.trim());
  });

  const newCards = [];
  for (const btn of rawButtons) {
    let parent = btn;
    for (let i = 0; i < 15; i++) {
      if (!parent.parentElement) break;
      parent = parent.parentElement;
      if (parent.classList.contains("viva-processed") || parent.getAttribute("data-viva-id")) {
        break;
      }
      if (parent.querySelector("img, video") && (parent.textContent.includes("Patrocinado") || parent.textContent.includes("Sponsored"))) {
        const sponsoredMatches = (parent.textContent.match(/Patrocinado|Sponsored/g) || []).length;
        if (sponsoredMatches === 1) {
          parent.querySelectorAll("img").forEach(img => {
            if (!img.getAttribute("decoding")) img.setAttribute("decoding", "async");
          });
          parent.querySelectorAll("video").forEach(vid => {
            if (!vid.getAttribute("preload")) vid.setAttribute("preload", "metadata");
          });
          newCards.push(parent);
          break;
        }
      }
    }
  }

  return [...processed, ...byFiber, ...newCards].filter((v, i, a) => v && a.indexOf(v) === i);
}

// ─── VIVA O(1) Static Compiled RegExp & Set Pool ───
const REGEX_META_DATE_PT = /(?:veicular em|iniciada em|Veiculação iniciada em)\s+(\d+)\s+de\s+([a-zç\.]+)(?:\s+de)?\s+(\d+)/i;
const REGEX_META_DATE_EN = /(?:running on|on)\s+([a-z]+)\s+(\d+),\s+(\d+)/i;
const REGEX_PID_HTML = /(?:view_all_page_id=|page_id=|[?&](?:amp;)?id=|"pageID":\s*"|"pageId":\s*"|"advertiserID":\s*")(\d{10,20})/i;
const REGEX_AD_ARCHIVE_TEXT = /(?:Identifica[cç][aã]o da biblioteca|Library ID|ID)[:\s]+(\d{13,18})/i;
const REGEX_AD_ARCHIVE_LINK = /[?&](?:amp;)?id=(\d{13,18})/i;
// FIX ITEM 12: REGEX_CREATED_DATE removida junto com checkContingencyStatus() (única
// consumidora, nunca chamada em lugar nenhum — ver nota mais abaixo).
const REGEX_META_AD_COUNT = /(\d+)\s+(?:an[uú]ncios\s+usam|ads\s+use)/i;
const REGEX_SIMPLE_DOMAIN = /^[a-z0-9\-\.]+\.[a-z]{2,4}(\/.*)?$/i;
const REGEX_ONLY_DOMAIN = /^[a-z0-9\-\.]+\.[a-z]{2,4}$/i;
const REGEX_ONLY_DIGITS = /^\d{10,20}$/;

const WP_PATTERNS = [
  "api.whatsapp.com", "wa.me", "web.whatsapp.com", "chat.whatsapp.com",
  "wanalink", "wana.cm", "wanazap", "convertzap", "cvtzap",
  "zaplink", "linkzap", "superzap", "joinzap", "grupozap"
];

// Fases exclusivas: baixo volume tem prioridade; em seguida dias ativos e contagem oficial Meta
// determinam escala. A duplicação do DOM permanece apenas um sinal separado para os badges.
const STAGE_RANK = { teste: 0, validando: 1, potencial: 2, bruta: 3, monstro: 4, baixo: -1 };
const STAGE_INFO = {
  teste: { label: "🧪 EM TESTE", chipClass: "viva-escala-chip-teste", color: "#8E8E93" },
  validando: { label: "🔍 VALIDANDO", chipClass: "viva-escala-chip-validando", color: "#007AFF" },
  potencial: { label: "📈 POTENCIAL ESCALA", chipClass: "viva-escala-chip-potencial", color: "#FF9500" },
  bruta: { label: "🔥 ESCALA BRUTA", chipClass: "viva-escala-chip-bruta", color: "#FF3B30" },
  monstro: { label: "💎 ESCALA MONSTRO", chipClass: "viva-escala-chip-monstro", color: "#AF52DE" },
  baixo: { label: "⚫ BAIXO VOLUME", chipClass: "viva-escala-chip-baixo", color: "#000000" },
};

function resolveStageV2(adAgeDays, metaAdCount, temRecente, baixoVolume) {
  if (baixoVolume) return "baixo";
  if (adAgeDays === null) return "teste";
  if (adAgeDays >= 30) return "monstro";
  if (adAgeDays >= 15 || (metaAdCount && metaAdCount >= 3)) return "bruta";
  if (adAgeDays >= 7) return "potencial";
  if (adAgeDays >= 3) return "validando";
  return "teste";
}

function aplicarBrilhoThumb(frame, stage) {
  if (frame.dataset.vivaVisualStage === stage && frame.querySelector(".viva-escala-bar")) return;

  frame.dataset.vivaVisualStage = stage;
  const destaque = ["monstro", "bruta", "validando", "potencial"].includes(stage);
  frame.querySelectorAll("img, video").forEach(media => {
    media.classList.toggle("viva-thumb-viva", destaque);
  });

  let bar = frame.querySelector(".viva-escala-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "viva-escala-bar viva-el";
    frame.appendChild(bar);
  }
  bar.hidden = !destaque;
}

console.info("[VIVA] Visual Boost Completo - brilho intenso + thumbs vivas brightness/saturate + shimmer + elevation");

function isBaixoVolumeCard(card) {
  const text = (card.textContent || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return text.includes("baixo volume de impress") ||
    text.includes("baixo volume") ||
    (text.includes("volume de impress") && text.includes("baixo")) ||
    text.includes("low volume of impressions") ||
    text.includes("low volume") ||
    text.includes("low impressions") ||
    text.includes("baixo alcance de impress");
}

function syncBaixoVolumeDecoration(frame, card, baixoVolume) {
  card.classList.toggle("viva-baixo-volume", baixoVolume);
  frame.classList.toggle("viva-baixo-volume-frame", baixoVolume);

  const badgeContainer = frame.querySelector(".viva-card-badge-container");
  if (!badgeContainer) return;

  let badge = badgeContainer.querySelector(".viva-badge-black");
  if (!baixoVolume) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "viva-badge-black viva-el";
    badge.textContent = "⚫ BAIXO VOLUME";
    badge.title = "Este anúncio tem baixo volume de impressões - não está performando bem apesar de ter dias ativo";
    badgeContainer.insertBefore(badge, badgeContainer.firstChild);
  }
}

// ─── Single-Pass DOM Collector (Memoized per card instance) ───
const domElementsCache = new WeakMap();
let _vivaIntelligentReportSignature = "";
let _vivaBuscaOutsideClickHandler = null;
let _vivaBuscaEscapeHandler = null;

function reportParaMineracaoInteligente() {
  const params = new URLSearchParams(window.location.search);
  const runId = params.get("viva_miner_run");
  const planId = params.get("viva_miner_plan");
  if (!runId || !planId || params.get("search_type") !== "keyword_unordered") return;

  const pagesById = new Map();
  const stageRank = STAGE_RANK;
  for (const item of activeCardData) {
    const pageId = item.data.pageId;
    if (!pageId) continue;
    let page = pagesById.get(pageId);
    if (!page) {
      page = {
        page_id: pageId,
        nome: item.data.advertiserName || "Desconhecido",
        qtd_ads: 1,
        qtd_duplicados: 0,
        ages: [],
        tem_recente: false,
        scale: item.stage,
        scaleRank: stageRank[item.stage] || 0,
        baixaVolumeCount: 0,
        cardCount: 0,
      };
      pagesById.set(pageId, page);
    }
    page.cardCount += 1;
    page.qtd_ads = Math.max(page.qtd_ads, Number(item.data.metaAdCount) || 1);
    page.qtd_duplicados = Math.max(page.qtd_duplicados, (Number(item.effectiveDupCount) || 1) - 1);
    const age = item.data.adAgeDays === null ? NaN : Number(item.data.adAgeDays);
    if (Number.isFinite(age) && age >= 0) {
      page.ages.push(age);
      if (age <= 3) page.tem_recente = true;
    }
    if ((stageRank[item.stage] || 0) > page.scaleRank) {
      page.scale = item.stage;
      page.scaleRank = stageRank[item.stage] || 0;
    }
    if (isBaixoVolumeCard(item.card)) page.baixaVolumeCount += 1;
  }
  const paginas = Array.from(pagesById.values()).map(page => {
    const escala = page.baixaVolumeCount === page.cardCount
      ? "BAIXO VOLUME"
      : page.scale === "bruta" || page.scale === "monstro"
        ? "ESCALA BRUTA"
        : page.scale === "potencial"
          ? "POTENCIAL ESCALA"
          : "CAMPANHA NORMAL";
    const mediaDias = page.ages.length
      ? page.ages.reduce((sum, value) => sum + value, 0) / page.ages.length
      : 0;
    return {
      page_id: page.page_id,
      nome: page.nome,
      qtd_ads: page.qtd_ads,
      qtd_duplicados: page.qtd_duplicados,
      media_dias: mediaDias,
      dias_ativo: mediaDias,
      tem_recente: page.tem_recente,
      escala,
      escala_tipo: escala,
    };
  });
  if (paginas.length === 0) return;

  const signature = JSON.stringify(paginas
    .map(page => [page.page_id, page.qtd_ads, page.media_dias, page.tem_recente, page.escala, page.qtd_duplicados])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const reportSignature = `${runId}:${planId}:${signature}`;
  if (reportSignature === _vivaIntelligentReportSignature) return;
  _vivaIntelligentReportSignature = reportSignature;

  chrome.runtime.sendMessage({
    action: "RESULTADO_PAGINA_MINERADA",
    runId,
    planId,
    paginas,
    url: window.location.href,
  }).catch(err => {
    console.warn("[VIVA] Não foi possível reportar resultados da mineração:", err.message);
  });
}

function getCardDomElements(card) {
  const identitySignal = getCardIdentitySignal(card);
  if (domElementsCache.has(card)) {
    const cached = domElementsCache.get(card);
    if (cached.cardRoot === card && card.isConnected && cached.identitySignal === identitySignal) {
      return cached;
    }
    domElementsCache.delete(card);
  }

  const allDivs = card.querySelectorAll("div, span, p, h3, h4");
  const leafNodes = [];
  const textNodes = [];
  for (const el of allDivs) {
    if (el.children.length !== 0 || !el.textContent) continue;
    const txt = el.textContent.trim();
    if (txt.length <= 3 || txt.length > 500) continue;
    if (/ver detalhes|view details|ver resumo|abrir menu|active|ativo/i.test(txt) && txt.length < 30) continue;
    leafNodes.push(el);
    textNodes.push({ el, txt, len: txt.length });
  }

  const links = Array.from(card.querySelectorAll("a[href]"));
  const video = card.querySelector("video");
  const imgs = Array.from(card.querySelectorAll("img")).filter(img => {
    const width = img.width || 0;
    return width === 0 || width >= 60;
  });
  const img = imgs.find(image => (image.naturalWidth || image.width || 0) > 100) || imgs[0] || null;
  const cache = { links, leafNodes, textNodes, video, imgs, img, cardRoot: card, identitySignal };
  domElementsCache.set(card, cache);
  return cache;
}

function refreshCardData(card) {
  domElementsCache.delete(card);
  cardDataMap.delete(card);
  delete card._vivaData;
  return extractCardData(card);
}

// AUDITORIA #02 (crítico — O(n²) -> O(n)): getAdCount(advertiserName) foi removida. Fazia
// activeCardData.filter() completo (O(n)) a cada chamada, e era chamada uma vez por item dentro
// de outro loop O(n) em processCards() — O(n²) por ciclo de processCards(). A contagem por anunciante
// agora é acumulada em O(n) único, no mesmo passe que já monta cardSignatures/mediaSignatures/
// linkSignatures (ver `advertiserCounts` dentro de processCards()).

function extractAdvertiserName(card) {
  const dom = getCardDomElements(card);
  const sponsorEl = dom.leafNodes.find(el => {
    const text = el.textContent || "";
    return text === "Patrocinado" || text === "Sponsored";
  });
  if (sponsorEl) {
    let parent = sponsorEl.parentElement;
    if (parent) {
      const nameEl = parent.querySelector("a, div[style*='font-weight: bold'], span[style*='font-weight: bold']");
      if (nameEl && nameEl.textContent.trim()) return nameEl.textContent.trim().split(" / ")[0];
      for (const child of parent.children) {
        if (child !== sponsorEl && child.textContent.trim()) return child.textContent.trim().split(" / ")[0];
      }
    }
  }
  for (const a of dom.links) {
    if (a.href.includes("facebook.com/") && a.textContent.trim()) return a.textContent.trim();
  }
  return "Anunciante";
}

function extractDestinationUrl(card) {
  const { links } = getCardDomElements(card);
  const externalHosts = ["facebook.com", "fb.com", "instagram.com"];
  const normalizeDestination = (href, redirectDepth = 0) => {
    if (!href) return null;
    if (redirectDepth > 2) return null;
    try {
      const url = new URL(href, window.location.origin);
      if (url.hostname === "l.facebook.com" && url.pathname === "/l.php") {
        const redirected = url.searchParams.get("u") || url.searchParams.get("url");
        if (redirected) return normalizeDestination(redirected, redirectDepth + 1);
      }
      if (url.hostname === "api.whatsapp.com" || url.hostname === "wa.me") return url.href;
      if (externalHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (error) {
      console.debug("[VIVA] Ignorando URL de destino inválida:", error);
      return null;
    }
  };

  for (const a of links) {
    const href = a.getAttribute("href") || a.href;
    const destination = normalizeDestination(href);
    if (destination && /(?:api\.whatsapp\.com|wa\.me)/i.test(destination)) return destination;
  }

  for (const a of links) {
    const href = a.getAttribute("href") || a.href;
    const destination = normalizeDestination(href);
    if (destination) return destination;
  }

  if (/api\.whatsapp\.com/i.test(card.textContent || "")) return "https://api.whatsapp.com";
  if (/\bwa\.me\b/i.test(card.textContent || "")) return "https://wa.me";
  return null;
}

function extractMediaUrl(card) {
  const { video, imgs } = getCardDomElements(card);

  // Vídeo tem prioridade
  if (video && video.src && !video.src.startsWith("blob:")) {
    return video.src;
  }

  if (!imgs || imgs.length === 0) {
    // Fallback: Meta às vezes usa div com background-image para criativo
    const bgDiv = card.querySelector('div[style*="background-image"]');
    if (bgDiv) {
      const match = bgDiv.style.backgroundImage.match(/url\("?([^")]+)"?\)/);
      if (match) return match[1];
    }
    return null;
  }

  // Filtra fotos de perfil: pequenas, no topo, perto de Patrocinado
  const creativeCandidates = imgs.filter(img => {
    const src = img.src || "";
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return false;

    // Foto de perfil: width < 100 ou natural < 150
    const w = img.width || img.clientWidth || 0;
    const nw = img.naturalWidth || 0;
    if (w > 0 && w < 100) return false;
    if (nw > 0 && nw < 150) return false;

    // Foto de perfil costuma estar dentro de link de perfil ou avatar
    const isAvatar = img.closest('a[href*="facebook.com/"][href*="/"]') && w < 120;
    if (isAvatar) return false;

    // Criativo real: scontent, fbcdn grande, ou natural grande
    return true;
  });

  if (creativeCandidates.length > 0) {
    // Pega a maior imagem por área - o criativo sempre é o maior
    creativeCandidates.sort((a, b) => {
      const areaA = (a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0);
      const areaB = (b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0);
      return areaB - areaA;
    });
    return creativeCandidates[0].src;
  }

  // Tenta a última imagem utilizável, sem aceitar um avatar identificável como fallback.
  const fallbackImage = [...imgs].reverse().find(img => {
    const src = img.src || "";
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return false;
    const w = img.width || img.clientWidth || 0;
    const nw = img.naturalWidth || 0;
    if ((w > 0 && w < 100) || (nw > 0 && nw < 150)) return false;
    return !(img.closest('a[href*="facebook.com/"][href*="/"]') && w < 120);
  });

  return fallbackImage?.src || null;
}

console.info("[VIVA] Hotfix Baixar Mídia aplicado - pega maior imagem, não perfil");

function parseMetaDate(text) {
  const monthsPt = { jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5, jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11 };
  const monthsEn = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const matchPt = text.match(REGEX_META_DATE_PT);
  if (matchPt) return new Date(parseInt(matchPt[3]), monthsPt[matchPt[2].toLowerCase().replace(".", "").substring(0, 3)] || 0, parseInt(matchPt[1]));
  const matchEn = text.match(REGEX_META_DATE_EN);
  if (matchEn) return new Date(parseInt(matchEn[3]), monthsEn[matchEn[1].toLowerCase().substring(0, 3)] || 0, parseInt(matchEn[2]));
  return null;
}

function normalizeCopyText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function expandTextoPrincipal(card) {
  const moreLabels = /^(?:ver mais|see more)(?:\s*[.…]{1,3})?$/i;
  const candidates = Array.from(card.querySelectorAll('div[role="button"], span, button'))
    .filter(element => moreLabels.test(normalizeCopyText(element.textContent)))
    .sort((a, b) => normalizeCopyText(a.textContent).length - normalizeCopyText(b.textContent).length);
  if (!candidates.length) return false;

  candidates[0].click();
  return true;
}

function isCopyInterfaceText(text) {
  const normalized = normalizeCopyText(text);
  return !normalized ||
    /^(?:patrocinado|sponsored|ver mais|see more|ver detalhes|view details|ver resumo|abrir menu suspenso|ativo|active|enviar mensagem|send message|saiba mais|learn more|assistir mais|converse conosco|baixar|comprar agora|inscreva-se|fale conosco)$/i.test(normalized) ||
    /identificação da biblioteca|veiculação iniciada|veiculando desde|running on|plataformas|anúncios usam|dias ativo|escala potencial|campanha normal|funil whatsapp|copiar copies|biblioteca de anúncios/i.test(normalized);
}

function extractTextoPrincipalCompleto(card, advertiserName = "") {
  const advertiser = normalizeCopyText(advertiserName).toLowerCase();
  const media = Array.from(card.querySelectorAll("video, img")).find(element => {
    if (element.nodeName === "VIDEO") return true;
    return Math.max(element.naturalWidth || 0, element.width || 0, element.offsetWidth || 0) >= 150;
  }) || null;
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  const fragments = [];
  let node;

  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest("button, input, textarea, [role='button'], .viva-escala-strip, .viva-card-badge-container, .viva-card-footer")) continue;
    if (media && (media.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) === 0) continue;

    const text = normalizeCopyText(node.textContent);
    if (text.length < 2 || text.length > 1000 || isCopyInterfaceText(text)) continue;
    if (advertiser && text.toLowerCase() === advertiser) continue;
    if (/^(?:https?:\/\/|www\.)/i.test(text) || REGEX_SIMPLE_DOMAIN.test(text)) continue;
    fragments.push(text);
  }

  const uniqueFragments = [];
  for (const fragment of fragments) {
    if (uniqueFragments.some(existing => existing === fragment || existing.includes(fragment) || fragment.includes(existing))) continue;
    uniqueFragments.push(fragment);
  }

  let complete = uniqueFragments.join(" ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/g, "$1\n")
    .trim();

  if (complete.length < 40) {
    const candidates = Array.from(card.querySelectorAll("div, p, span"))
      .map(element => normalizeCopyText(element.innerText || element.textContent))
      .filter(text =>
        text.length >= 40 &&
        text.length <= 1200 &&
        !isCopyInterfaceText(text) &&
        !/identificação da biblioteca|veiculação|plataformas|ver detalhes/i.test(text)
      )
      .sort((a, b) => b.length - a.length);
    if (candidates[0]) complete = candidates[0].replace(/(?:ver mais|see more)\s*$/i, "").trim();
  }

  return complete || "Texto principal não detectado";
}

function extractHeadlineCTA(card) {
  const ctaPatterns = [
    { pattern: /^enviar mens(?:agem)?(?:\s*[.…]{1,3})?$/i, label: "Enviar mensagem" },
    { pattern: /^send message(?:\s*[.…]{1,3})?$/i, label: "Send message" },
    { pattern: /^saiba mais(?:\s*[.…]{1,3})?$/i, label: "Saiba mais" },
    { pattern: /^learn more(?:\s*[.…]{1,3})?$/i, label: "Learn more" },
    { pattern: /^assistir mais(?:\s*[.…]{1,3})?$/i, label: "Assistir mais" },
    { pattern: /^converse conosco(?:\s*[.…]{1,3})?$/i, label: "Converse conosco" },
    { pattern: /^baixar(?:\s*[.…]{1,3})?$/i, label: "Baixar" },
    { pattern: /^comprar agora(?:\s*[.…]{1,3})?$/i, label: "Comprar agora" },
    { pattern: /^inscreva-se(?:\s*[.…]{1,3})?$/i, label: "Inscreva-se" },
    { pattern: /^fale conosco(?:\s*[.…]{1,3})?$/i, label: "Fale conosco" },
  ];
  const candidates = Array.from(card.querySelectorAll("a[href], button, [role='button'], span, div"))
    .map(element => normalizeCopyText(element.textContent))
    .filter(text => text.length > 0 && text.length < 45);

  for (const { pattern, label } of ctaPatterns) {
    if (candidates.some(text => pattern.test(text))) return label;
  }
  return "Sem headline - anúncio focado em texto principal";
}

function extractDescricaoLink(card, destinationUrl = null) {
  const texts = Array.from(card.querySelectorAll("div, span, p"))
    .map(element => normalizeCopyText(element.textContent))
    .filter(text => text.length > 0 && text.length < 70);
  const whatsappDomain = texts.find(text => /^api\.whatsapp\.com$/i.test(text));
  const whatsappPrompt = texts.find(text => /^converse conosco$/i.test(text));

  let hostname = whatsappDomain ? "API.WHATSAPP.COM" : "";
  if (!hostname && destinationUrl) {
    try {
      hostname = new URL(destinationUrl).hostname.toUpperCase();
    } catch (error) {
      console.debug("[VIVA] URL de destino não pôde ser usada como descrição:", error);
    }
  }

  const parts = [hostname, whatsappPrompt].filter(Boolean);
  return parts.join("\n") || "Link não exibido no card";
}

function extractCardTexts(card, destinationUrl = null, advertiserName = extractAdvertiserName(card)) {
  return {
    primaryText: extractTextoPrincipalCompleto(card, advertiserName),
    title: extractHeadlineCTA(card),
    description: extractDescricaoLink(card, destinationUrl),
  };
}

function showAppleToast(titulo, subtitulo, tipo = "success") {
  document.querySelectorAll(".viva-apple-toast").forEach(toast => toast.remove());

  const toast = document.createElement("div");
  toast.className = `viva-apple-toast viva-toast-${tipo} viva-el`;
  const icon = document.createElement("div");
  icon.className = "viva-toast-icon";
  icon.textContent = tipo === "success" ? "✓" : "!";
  const content = document.createElement("div");
  content.className = "viva-toast-content";
  const title = document.createElement("div");
  title.className = "viva-toast-title";
  title.textContent = titulo;
  const subtitle = document.createElement("div");
  subtitle.className = "viva-toast-subtitle";
  subtitle.textContent = subtitulo;
  content.append(title, subtitle);
  toast.append(icon, content);
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.setProperty("transform", "translateX(-50%) translateY(0) scale(1)", "important");
    toast.style.setProperty("opacity", "1", "important");
  });

  setTimeout(() => {
    toast.style.setProperty("transform", "translateX(-50%) translateY(10px) scale(0.95)", "important");
    toast.style.setProperty("opacity", "0", "important");
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

async function handleCopiarCopies(card) {
  if (expandTextoPrincipal(card)) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  const data = refreshCardData(card);
  const texts = extractCardTexts(card, data.destUrl, data.advertiserName);
  const libraryId = extractAdArchiveId(card);
  const formatado = `TÍTULO / HEADLINE
${texts.title}

TEXTO PRINCIPAL
${texts.primaryText}

DESCRIÇÃO / LINK
${texts.description}

URL: ${data.destUrl || "Não detectada"}
Página: ${data.advertiserName || ""} | ${data.adAgeDays ? `${data.adAgeDays} dias ativo` : ""} | ${data.metaAdCount || 1}x anúncios
ID Biblioteca: ${libraryId || ""}`;

  try {
    await navigator.clipboard.writeText(formatado);
  } catch (clipboardError) {
    let copied = false;
    let textarea = null;
    try {
      textarea = document.createElement("textarea");
      textarea.value = formatado;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
    } catch (fallbackError) {
      console.warn("[VIVA] Fallback da área de transferência falhou:", fallbackError);
    } finally {
      if (textarea) textarea.remove();
    }
    if (!copied) {
      console.error("[VIVA] Não foi possível copiar as copies do anúncio:", clipboardError);
      showAppleToast("Falha ao copiar", "Permita o acesso à área de transferência e tente novamente.", "error");
      return;
    }
  }

  showAppleToast("Copiado!", "Título + Texto Principal + Link copiados", "success");
}

console.info("[VIVA] Fix Copiar Copies - TEXTO PRINCIPAL completo + headline CTA + URL real");

function extractPageId(card) {
  const adArchiveId = extractAdArchiveId(card);
  const fiberId = card.getAttribute("data-viva-page-id");
  if (fiberId && fiberId !== adArchiveId && REGEX_ONLY_DIGITS.test(fiberId)) {
    return fiberId;
  }

  const { links } = getCardDomElements(card);
  for (const a of links) {
    if (a.href.includes("/ads/library/") || a.href.includes("view_all_page_id=") || a.href.includes("page_id=") || a.href.includes("id=")) {
      try {
        const u = new URL(a.href, window.location.origin);
        const explicitPageId = u.searchParams.get("view_all_page_id") || u.searchParams.get("page_id");
        if (explicitPageId && REGEX_ONLY_DIGITS.test(explicitPageId)) return explicitPageId;
        const legacyId = u.searchParams.get("id");
        if (legacyId && legacyId !== adArchiveId && REGEX_ONLY_DIGITS.test(legacyId)) return legacyId;
      } catch (e) {}
    }
  }

  const htmlMatch = card.outerHTML.match(REGEX_PID_HTML);
  if (htmlMatch && htmlMatch[1] && htmlMatch[1] !== adArchiveId) {
    return htmlMatch[1];
  }

  return null;
}

function getCardPageId(card, data) {
  if (!card) return null;
  const adArchiveId = extractAdArchiveId(card);
  const candidates = [card.getAttribute("data-viva-page-id"), data?.pageId, extractPageId(card)];
  return candidates.find(pageId => pageId && pageId !== adArchiveId && REGEX_ONLY_DIGITS.test(String(pageId))) || null;
}

function extractAdArchiveId(card) {
  const textMatch = card.textContent.match(REGEX_AD_ARCHIVE_TEXT);
  if (textMatch && textMatch[1]) return textMatch[1];
  const linkMatch = card.innerHTML.match(REGEX_AD_ARCHIVE_LINK);
  if (linkMatch && linkMatch[1]) return linkMatch[1];
  return null;
}

// Constrói o link permanente do anúncio na Meta Ad Library, no MESMO formato completo que o
// "..." nativo (Copiar link do anúncio) gera — id + view_all_page_id + search_type=page juntos
// desde o primeiro carregamento. Só entregar um ?id= sozinho (formato antigo) faz a própria
// Meta reconstruir a URL client-side pra completar os parâmetros que faltam, e nessa
// reconstrução ela descarta qualquer parâmetro que não reconheça (inclusive um marcador nosso
// na query string) — entregando já completo, a gente nunca depende dessa reconstrução.
//
// O marcador viva_pin=1 vai no FRAGMENTO da URL (#viva_pin=1), nunca na query string: o
// fragmento nunca é enviado ao servidor nem reescrito por navegação client-side, então é o
// único canal estável pra sinalizar a checkAndCleanAdModalUrl() que este id=... foi aberto de
// propósito — e não é sobra de uma navegação de saída de modal (ver essa função no topo do
// arquivo, que sem esse sinal apagaria de volta o id= que é o motivo de abrir este link).
function buildAdLibraryPermalink(card) {
  const adArchiveId = extractAdArchiveId(card);
  if (!adArchiveId) return null;
  const pageId = getCardPageId(card);
  if (!pageId) {
    // Sem pageId não dá pra montar a URL completa no formato que a Meta preserva — cai pro
    // formato simples (ainda funciona em contexto sem a extensão, ex: aba anônima).
    return `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adArchiveId)}#viva_pin=1`;
  }
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: "ALL",
    id: adArchiveId,
    is_targeted_country: "false",
    media_type: "all",
    search_type: "page",
    view_all_page_id: pageId
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}#viva_pin=1`;
}

function getAdLibraryUrlDirect(card, data = card?._vivaData || cardDataMap.get(card) || {}) {
  const adArchiveId = extractAdArchiveId(card);
  if (adArchiveId) {
    return `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adArchiveId)}`;
  }
  const pageId = getCardPageId(card, data);
  if (pageId) {
    return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&search_type=page&view_all_page_id=${encodeURIComponent(pageId)}`;
  }
  return null;
}

// FIX ITEM 12 (2026-08): checkContingencyStatus() removida — função inteira nunca chamada em
// lugar nenhum do arquivo (nem sidebar, nem dock, nem badges). Junto dela saíram
// cachedContingencyStatus/cachedContingencyChecked (só existiam para o cache interno desta
// função) e REGEX_CREATED_DATE (só usada aqui dentro).

function detectWhatsApp(card, destUrl) {
  const checkUrl = (url) => {
    if (!url) return false;
    const lower = url.toLowerCase();
    for (let i = 0; i < WP_PATTERNS.length; i++) {
      if (lower.includes(WP_PATTERNS[i])) return true;
    }
    return false;
  };

  if (checkUrl(destUrl)) return true;

  const { links } = getCardDomElements(card);
  for (const a of links) {
    if (checkUrl(a.href)) return true;
  }

  const cardText = (card.textContent || "").toLowerCase();
  if (
    cardText.includes("api.whatsapp.com") ||
    cardText.includes("wa.me/") ||
    cardText.includes("whatsapp") ||
    cardText.includes("enviar mens")
  ) {
    return true;
  }

  return false;
}

// FIX 4.5: identidade barata do card, usada para invalidar o cache quando a Meta recicla um
// nó de DOM da grade virtualizada para exibir um anúncio diferente. Deliberadamente NÃO usa
// card.textContent (forçaria recomputar toda a subárvore de texto até em cards já processados)
// nem o cache memoizado de getCardDomElements() — se a Meta SUBSTITUIR a subárvore do card em
// vez de só atualizar atributos in-place, o cache antigo apontaria para nós já desconectados,
// cujo .src ainda refletiria o anúncio anterior (falso negativo). Uma query direta e restrita
// a "video, img" (não a multi-tag pesada usada em getCardDomElements) é barata e sempre fresca.
function getCardIdentitySignal(card) {
  const media = card.querySelector("video, img");
  const src = media ? (media.currentSrc || media.src || "") : "";
  return src || `nochild:${card.children.length}`;
}

function extractCardData(card) {
  const identitySignal = getCardIdentitySignal(card);

  if (cardDataMap.has(card)) {
    const cached = cardDataMap.get(card);
    if (cached.identitySignal === identitySignal) return cached;
    // FIX 4.5: identidade mudou — a Meta reciclou este nó de DOM para outro anúncio. Descarta
    // o cache antigo (inclusive o DOM cache auxiliar, que também aponta pro conteúdo anterior).
    domElementsCache.delete(card);
  } else if (card._vivaData && card._vivaData.identitySignal === identitySignal) {
    cardDataMap.set(card, card._vivaData);
    return card._vivaData;
  }
  const destUrl = extractDestinationUrl(card);
  const mediaUrl = extractMediaUrl(card);
  const pageId = extractPageId(card);
  const advertiserName = extractAdvertiserName(card);
  const { primaryText, title, description } = extractCardTexts(card, destUrl, advertiserName);
  let adAgeDays = null;
  const { leafNodes } = getCardDomElements(card);
  const dateEl = leafNodes.find(el => {
    const txt = el.textContent || "";
    return txt.includes("veicular em") || txt.includes("iniciada em") || txt.includes("running on");
  });
  if (dateEl) {
    const startDate = parseMetaDate(dateEl.textContent);
    if (startDate) adAgeDays = Math.max(0, Math.ceil((new Date() - startDate) / (1000 * 60 * 60 * 24)));
  }
  let metaAdCount = 1;
  const matchMetaCount = (card.textContent || "").match(REGEX_META_AD_COUNT);
  if (matchMetaCount) {
    metaAdCount = Math.max(1, parseInt(matchMetaCount[1], 10));
  }
  const cleanText = (primaryText || description).replace(/\s+/g, "").toLowerCase().substring(0, 100);
  const cleanMedia = (mediaUrl || "").split("?")[0].split("/").pop() || "";
  const data = {
    destUrl,
    mediaUrl,
    pageId,
    advertiserName,
    primaryText,
    title,
    description,
    adAgeDays,
    metaAdCount,
    isWhatsApp: detectWhatsApp(card, destUrl),
    mediaSig: cleanMedia || null,
    sig: `${cleanText}|${cleanMedia}`,
    identitySignal
  };
  cardDataMap.set(card, data);
  card._vivaData = data;
  return data;
}

let isBatching = false;
let pendingBatchCards = false;

// FIX CAUSA RAIZ (2026-09) — trava de concorrência: resetCardFramesAndState() desembrulha todos
// os .viva-card-frame antes do clique automatizado na aba "Sobre" (ver autoDiscoverInstagramViaSobreTab),
// mas durante a janela de transição (~2s: clique em "Sobre" + espera + clique de volta em
// "Anúncios") a própria grade de anúncios sendo desmontada/remontada pelo React da Meta dispara
// mutações que o MutationObserver principal detecta, chamando processCards() via debounce. Sem
// esta trava, processCards() re-envolveria os cards em .viva-card-frame NO MEIO da transição de
// aba, reintroduzindo exatamente o mesmo erro de removeChild que a correção pretende eliminar.
// Enquanto true, processCards() sai imediatamente sem processar nem re-envolver nada; o próprio
// autoDiscoverInstagramViaSobreTab() libera a trava e força um processCards() explícito assim
// que a aba "Anúncios" termina de remontar.
let _vivaSobreTabDiscoveryInProgress = false;
let _vivaSobreTabWatchdogTimeout = null; // rede de segurança contra a trava acima ficar presa

// ─── VIVA Card Frame: caixa externa que envolve o card sem tocar em seus filhos ───
// FIX ARQUITETURA (loop do ResizeObserver / erro React #185): antes, escalaStrip, badgeContainer
// e cardFooter eram inseridos como FILHOS DENTRO do próprio card (card.insertBefore/appendChild),
// aumentando a altura do node que a Meta observa/gerencia via React — isso disparava um loop de
// resize (Minified React error #185, "maximum update depth exceeded") e empurrava conteúdo nativo
// (ex: "X dias ativo") pra fora da área visível. Agora o card É EMOLDURADO por um wrapper próprio
// da VIVA (.viva-card-frame): o card é MOVIDO para dentro do frame (sua referência DOM, listeners
// e fiber do React continuam intactos — só o parentNode muda, o que o React não observa), e todo
// o conteúdo da VIVA (faixa de escala + badges acima, rodapé de ações abaixo) é inserido como
// IRMÃO do card dentro do frame, nunca como filho do card. O card em si permanece 100% intocado.
function getOrCreateCardFrame(card) {
  const existingParent = card.parentElement;
  if (existingParent && existingParent.classList && existingParent.classList.contains("viva-card-frame")) {
    return existingParent;
  }
  const frame = document.createElement("div");
  frame.className = "viva-card-frame viva-el";
  const originalParent = card.parentElement;
  if (originalParent) {
    originalParent.insertBefore(frame, card);
  }
  frame.appendChild(card); // move o card — não cria, não remove e não altera nenhum filho dele
  return frame;
}

// FIX GRID CELL (2026-09 — restaura a heurística determinística do design original): a versão
// anterior (findFrameCell "adaptativa por contagem de irmãos-já-processados") subia a árvore
// contando quantos irmãos já possuíam .viva-card-frame OU continham .viva-processed. O problema:
// no PRIMEIRO ciclo em que vários cards novos aparecem juntos (carregamento inicial da busca,
// ou clique em "Carregar mais"), a própria função getOrCreateCardFrame() só envolve o card N no
// momento em que o loop chega em N — ou seja, ao avaliar o card 1, nenhum dos outros cards ainda
// tinha .viva-card-frame nem .viva-processed (isso só é setado depois, mais adiante no mesmo
// ciclo). A contagem de "irmãos com frame" ficava sempre em 1, a busca subia até o limite de
// profundidade (8 níveis) sem nunca encontrar >1, e o fallback aplicava display:grid num
// ancestral muito acima do esperado — em alguns casos, um container que envolve a página de
// resultados inteira. É exatamente o sintoma relatado: o layout inteiro colapsava numa única
// coluna estreita de ~300px, com o resto da viewport em branco.
// Correção: heurística estrutural simples e 100% determinística, que não depende de estado de
// processamento de nenhum outro card — sobe UM único nível se o pai imediato do frame tiver
// exatamente 1 filho (padrão comum da Ad Library: cada slot de anúncio vem embrulhado num
// wrapper de filho único fornecido pela própria Meta). Isso nunca varia de resultado entre
// ciclos, então o card 1 e o card 300 sempre resolvem para o mesmo nível de ancestralidade.
function findFrameCell(frame) {
  let cell = frame;
  let parent = cell.parentElement;
  if (parent && parent.children.length === 1 && parent.parentElement) {
    cell = parent;
    parent = parent.parentElement;
  }
  return { cell, parent };
}

// ─── VIVA Gear Dropdown Portal: posicionamento em viewport ──────────────────────────────────
// FIX SOBERANIA (2026-08): calcula left/top em coordenadas de VIEWPORT (não mais relativo ao
// card) para o dropdown "Ações", que agora vive como filho direto de <body> (position:fixed).
// Chamada uma única vez por abertura, logo após o appendChild — nunca em loop/scroll, então o
// custo de getBoundingClientRect() (força 1 reflow) é pago só 1x por clique, irrelevante.
function positionGearDropdown(dropdown, anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  const dropdownWidth = dropdown.offsetWidth || 200;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const margin = 8;

  // Alinha a borda direita do menu com a borda direita do botão (mesma âncora visual de antes,
  // quando era right:0 relativo ao gearContainer) — com clamp pra nunca vazar a viewport.
  let left = rect.right - dropdownWidth;
  if (left < margin) left = margin;
  if (left + dropdownWidth > viewportWidth - margin) left = viewportWidth - dropdownWidth - margin;
  dropdown.style.setProperty("left", `${left}px`, "important");

  // Abre para baixo por padrão (comportamento de sempre); se não couber até o fim da viewport
  // (card perto do rodapé da tela), inverte pra abrir pra CIMA em vez de estourar a tela —
  // exatamente o cenário relatado (linha perto do fim da rolagem visível).
  let top = rect.bottom + margin;
  const dropdownHeight = dropdown.offsetHeight || 0;
  if (dropdownHeight && top + dropdownHeight > viewportHeight - margin) {
    const flippedTop = rect.top - dropdownHeight - margin;
    top = flippedTop >= margin ? flippedTop : margin;
  }
  dropdown.style.setProperty("top", `${top}px`, "important");
}

// Constrói e exibe o menu "Ações" — extraído do clique da engrenagem dos cards da grade pra
// poder ser reaproveitado também pelo botão injetado no modal "Link para o anúncio" da Meta
// (ver injectActionsIntoAdModal). Recebe o card nativo, os dados já extraídos dele (data) e o
// botão que serve de âncora visual/posicional para o dropdown.
function showActionsDropdown(card, data, anchorBtn) {
  const existingDropdown = document.querySelector(".viva-gear-dropdown");
  const wasThisButtonsDropdown = existingDropdown && existingDropdown._vivaOwnerBtn === anchorBtn;
  document.querySelectorAll(".viva-gear-dropdown").forEach(d => d.remove());
  if (wasThisButtonsDropdown) return; // este clique era pra FECHAR — já fechamos acima.

  const dropdown = document.createElement("div");
  dropdown.className = "viva-gear-dropdown viva-el viva-active";
  dropdown._vivaOwnerBtn = anchorBtn;
  dropdown._vivaCard = card;
  dropdown.addEventListener("click", (evt) => evt.stopPropagation());

  // 1. Ver Anúncios da Página
  const itemVerAds = document.createElement("button");
  itemVerAds.className = "viva-dropdown-item";
  itemVerAds.innerHTML = `👁️ Ver Anúncios da Página`;
  itemVerAds.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    dropdown.remove();
    let resolvedPageId = getCardPageId(card, data);
    let adArchiveId = extractAdArchiveId(card);
    let targetUrl;

    if (resolvedPageId) {
      targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&search_type=page&view_all_page_id=${encodeURIComponent(resolvedPageId)}`;
    } else if (adArchiveId) {
      targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&id=${encodeURIComponent(adArchiveId)}&is_targeted_country=false&media_type=all&search_type=page`;
    } else if (data.advertiserName) {
      targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&q=${encodeURIComponent('"' + data.advertiserName + '"')}&search_type=keyword_exact_phrase`;
    } else {
      targetUrl = window.location.href;
    }
    window.open(targetUrl, "_blank");
  });
  dropdown.appendChild(itemVerAds);

  // 2. Salvar no Funil
  const itemFunnel = document.createElement("button");
  itemFunnel.className = "viva-dropdown-item";
  itemFunnel.innerHTML = `🗂️ Salvar Funil`;
  itemFunnel.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    dropdown.remove();
    const pageId = getCardPageId(card, data);
    const libraryUrl = getAdLibraryUrlDirect(card, data);
    console.info(`[VIVA] Abrindo Salvar Funil para biblioteca ${pageId || "sem ID"}`);
    openFunnelModal(libraryUrl || "", data.advertiserName, {
      prefillAd: true,
      pageId,
      libraryUrl,
    });
  });
  dropdown.appendChild(itemFunnel);

  // 3. Salvar Anúncio (ADS) — 1 clique, sem modal. Só funciona se a biblioteca já
  // estiver registrada; o rótulo (ads01, ads02...) é gerado pelo backend.
  const itemSalvarAds = document.createElement("button");
  itemSalvarAds.className = "viva-dropdown-item";
  itemSalvarAds.innerHTML = `📢 Salvar Anúncio`;
  itemSalvarAds.addEventListener("click", async (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    dropdown.remove();

    const record = findMonitoredPageRecord(card, data);
    if (!record) {
      showLibraryNotRegisteredModal();
      return;
    }

    const adUrl = buildAdLibraryPermalink(card);
    if (!adUrl) {
      showAdSaveErrorModal("Não foi possível identificar o ID deste anúncio na tela.");
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/funis/salvar-node`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: record.slug,
          tipo: "ads",
          url: adUrl
        })
      });
      if (res.ok) {
        const json = await res.json();
        showAdSavedSuccessModal(json.rotulo || "ads", record.nome);
      } else {
        showAdSaveErrorModal("O servidor recusou o salvamento. Tente novamente em instantes.");
      }
    } catch (err) {
      showAdSaveErrorModal("Erro de comunicação com o servidor.");
    }
  });
  dropdown.appendChild(itemSalvarAds);

  if (data.destUrl) {
    const itemMobile = document.createElement("button");
    itemMobile.className = "viva-dropdown-item";
    itemMobile.innerHTML = `📱 Visualizar Mobile`;
    itemMobile.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      dropdown.remove();
      chrome.runtime.sendMessage({ action: "open_mobile_tab", url: data.destUrl });
    });
    dropdown.appendChild(itemMobile);

    const itemProxy = document.createElement("button");
    itemProxy.className = "viva-dropdown-item";
    itemProxy.innerHTML = `🇺🇸 Abrir Proxy EUA`;
    itemProxy.addEventListener("click", (evt) => {
      evt.stopPropagation();
      dropdown.remove();
      window.open(`https://www.proxysite.com/?viva_url=${encodeURIComponent(data.destUrl)}`, "_blank");
    });
    dropdown.appendChild(itemProxy);
  }

  const itemCopy = document.createElement("button");
  itemCopy.className = "viva-dropdown-item";
  itemCopy.innerHTML = `📋 Copiar Copies`;
  itemCopy.addEventListener("click", async (evt) => {
    evt.stopPropagation();
    dropdown.remove();
    await handleCopiarCopies(dropdown._vivaCard || card);
  });
  dropdown.appendChild(itemCopy);

  if (data.mediaUrl) {
    const itemDL = document.createElement("button");
    itemDL.className = "viva-dropdown-item";
    itemDL.innerHTML = `📥 Baixar Mídia`;
    itemDL.addEventListener("click", (evt) => {
      evt.stopPropagation();
      dropdown.remove();
      const isVideo = data.mediaUrl.includes(".mp4") || card.querySelector("video");
      const ext = isVideo ? "mp4" : "jpg";
      const filename = `viva_${data.advertiserName.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${Date.now()}.${ext}`;
      chrome.runtime.sendMessage({ action: "download", url: data.mediaUrl, filename: filename });
    });
    dropdown.appendChild(itemDL);
  }

  // FIX PORTAL: anexa em <body> e posiciona via JS logo em seguida — precisa estar no DOM
  // primeiro para offsetWidth/offsetHeight ficarem mensuráveis dentro de positionGearDropdown().
  document.body.appendChild(dropdown);
  positionGearDropdown(dropdown, anchorBtn);

  // FIX PORTAL: como o dropdown é position:fixed (relativo à viewport), rolar a página o
  // deixaria "flutuando" longe do botão que o abriu. Fecha automaticamente no primeiro scroll.
  const closeOnScroll = () => {
    dropdown.remove();
    window.removeEventListener("scroll", closeOnScroll, true);
  };
  window.addEventListener("scroll", closeOnScroll, { capture: true, passive: true });
}

function processCards() {
  if (!vivaMonitorMasterEnabled || rankingOverlayPaused) return;
  // FIX CAUSA RAIZ (2026-09): ver nota de arquitetura junto de _vivaSobreTabDiscoveryInProgress,
  // no topo do arquivo. Sai sem fazer nada enquanto a automação da aba "Sobre" está em
  // andamento — evita re-envolver cards em .viva-card-frame no meio da desmontagem/remontagem
  // da grade pelo React da Meta, que é exatamente o que causava o "removeChild... not a child
  // of this node" e corrompia a extração do Instagram de forma silenciosa e persistente.
  if (_vivaSobreTabDiscoveryInProgress) return;
  if (isBatching) {
    pendingBatchCards = true;
    return;
  }
  const cycleStartTime = performance.now();

  // ─── VIVA Orphan Node Sweeper & Garbage Collection Preparation ───
  // Limpeza proativa de nós órfãos desconectados da árvore ou cartões reciclados pelo virtualizador do React
  // FIX FRAME: estes elementos agora são IRMÃOS do card dentro do .viva-card-frame (nunca mais
  // filhos do card em si) — a checagem de órfão precisa considerar o frame também.
  // FIX PORTAL (2026-08): .viva-gear-dropdown SAIU desta varredura de propósito — agora é um
  // portal anexado direto no <body> (ver gearBtn click handler), então nunca terá
  // .closest(".viva-card-frame") verdadeiro, e esta checagem o removeria no ciclo seguinte à
  // abertura (todo scroll/mutação dispara um ciclo), fechando o menu sozinho poucos ms depois
  // de abrir. O dropdown já é auto-gerenciado por 3 caminhos próprios: clique fora (listener
  // global), clique num item (remove-se sozinho) e scroll (fecha por segurança, ver abaixo) —
  // não precisa e não deve mais entrar nesta varredura genérica.
  if (Date.now() - lastSweepTime >= 5000) {
    lastSweepTime = Date.now();
    let removedOrphans = 0;
    document.querySelectorAll(".viva-card-footer, .viva-escala-strip, .viva-card-badge-container").forEach(el => {
      if (!el.isConnected || (!el.closest(".viva-card-frame") && !el.closest(".viva-processed") && !el.closest("[data-viva-id]"))) {
        el.remove();
        removedOrphans += 1;
      }
    });
    console.debug(`[VIVA] Orphan sweep (5s) · ${removedOrphans} removidos`);
  }

  // PHASE 1: Pure Reads & Memory Calculations (NO DOM MUTATIONS)
  // FIX DE ESCALA: consome as raízes de mutação acumuladas desde o último ciclo (se houver)
  // e limpa a fila — permite que getAdCards() faça uma varredura restrita em vez de escanear
  // o documento inteiro em cada ciclo de processamento.
  const scanRootsForThisCycle = pendingScanRoots.length > 0 ? pendingScanRoots.splice(0, pendingScanRoots.length) : null;
  const cards = getAdCards(scanRootsForThisCycle).filter(card => {
    if (!card.isConnected) {
      mediaPruningObserver.unobserve(card);
      viewportProximityObserver.unobserve(card);
      return false;
    }
    return true;
  });
  cardSignatures = {};
  const mediaSignatures = {};
  const linkSignatures = {};
  // AUDITORIA #02 (crítico — O(n²) -> O(n)): contagem de anúncios por anunciante, construída no
  // MESMO passe único que já monta as demais contagens abaixo. Antes vivia numa função separada
  // (getAdCount), chamada dentro do loop de cada item logo abaixo — um activeCardData.filter()
  // inteiro (O(n)) rodando para CADA um dos n cards, O(n²) por ciclo de processCards(). Com
  // dezenas de milhares de cards ativos isso vira centenas de milhões de comparações por ciclo,
  // disparado a cada scroll e mutação — a maior fonte de travamento em bibliotecas grandes.
  const advertiserCounts = {};
  activeCardData = cards.map(card => {
    // AUDITORIA #01 (crítico): usa extractCardData(card) sempre, nunca
    // `card._vivaData || extractCardData(card)` — esse `||` fazia extractCardData() nunca mais
    // ser chamada para este nó de DOM depois do 1º ciclo (card._vivaData vira truthy na
    // primeira passagem e fica truthy para sempre), então a invalidação por identitySignal
    // (FIX 4.5, que mora DENTRO de extractCardData) nunca chegava a rodar. A Meta recicla nós
    // de DOM da grade virtualizada ao rolar; sem essa invalidação, um card podia continuar
    // exibindo para sempre os dados do PRIMEIRO anúncio que ocupou aquele slot, mesmo depois da
    // Meta trocar o conteúdo por baixo. extractCardData() já faz seu próprio cache barato via
    // cardDataMap (WeakMap O(1)) + identitySignal, então chamá-la sempre aqui não reintroduz
    // custo — só reabilita a invalidação que já existia e nunca rodava.
    const data = extractCardData(card);
    const baixoVolume = isBaixoVolumeCard(card);
    if (baixoVolume && !card._vivaBaixoVolume) {
      console.info("[VIVA] Card com baixo volume detectado e destacado em preto");
    }
    card._vivaBaixoVolume = baixoVolume;
    // FIX 4.3: registra o card no gate de proximidade assim que descoberto, independente de já
    // ter sido decidido se ele será exibido ou processado neste ciclo — o próprio
    // IntersectionObserver decide de forma assíncrona e barata quando ele está perto o bastante.
    if (!card._vivaProximityObserved) {
      card._vivaProximityObserved = true;
      viewportProximityObserver.observe(card);
    }
    cardSignatures[data.sig] = (cardSignatures[data.sig] || 0) + 1;
    if (data.mediaSig && data.mediaSig.length > 3) {
      mediaSignatures[data.mediaSig] = (mediaSignatures[data.mediaSig] || 0) + 1;
    }
    const linkKey = data.destUrl ? extractDestinationLinkKey(data.destUrl) : null;
    if (linkKey) {
      linkSignatures[linkKey] = (linkSignatures[linkKey] || 0) + 1;
    }
    advertiserCounts[data.advertiserName] = (advertiserCounts[data.advertiserName] || 0) + 1;
    data.linkKey = linkKey;
    return { card, data, baixoVolume };
  });

  activeCardData.forEach(item => {
    const data = item.data;
    const domDupCount = cardSignatures[data.sig] || 1;
    const effectiveDupCount = Math.max(domDupCount, data.metaAdCount || 1);
    const twinCount = (data.mediaSig && mediaSignatures[data.mediaSig]) ? mediaSignatures[data.mediaSig] : 1;
    const linkCount = data.linkKey ? (linkSignatures[data.linkKey] || 1) : 1;
    item.effectiveDupCount = effectiveDupCount;
    item.twinCount = twinCount;
    item.linkCount = linkCount;

    // AUDITORIA #02: lookup O(1) no mapa construído no primeiro passe acima, no lugar da antiga
    // getAdCount() (removida) — que recalculava um activeCardData.filter() inteiro (O(n)) para
    // cada um dos n cards deste mesmo loop, o que era o O(n²) por ciclo de processCards().
    const adsCount = advertiserCounts[data.advertiserName] || 1;
    // Aplica as faixas da classificação Apple V2, preservando baixo volume como prioridade.
    item.stage = resolveStageV2(data.adAgeDays, data.metaAdCount, false, item.baixoVolume);
    
    let shouldShow = true;
    if (minPageAds > 0 && adsCount < minPageAds) shouldShow = false;
    if (minDupAds > 0 && effectiveDupCount < minDupAds) shouldShow = false;
    // FIX ITEM 11: as duas condições de hideRecent/hideNonScaled saíram daqui — variáveis
    // removidas (nunca ligadas por nenhum controle de UI, sempre false na prática).
    if (filterOnlyRecent && (data.adAgeDays === null || data.adAgeDays > 3)) shouldShow = false;
    // Baixo volume é um alerta visual e não pode ser removido por filtros de desempenho.
    item.shouldShow = item.baixoVolume || shouldShow;
  });

  reportParaMineracaoInteligente();

  // (hasActiveFilter removido: o reflow agora roda sempre, ver FIX DIAGNÓSTICO 1 abaixo)

  // PHASE 2: GPU Sync Frame Writes via requestAnimationFrame
  isBatching = true;
  clearTimeout(batchingWatchdogTimeout);
  batchingWatchdogTimeout = setTimeout(() => {
    if (isBatching) {
      console.warn("[VIVA] Watchdog de Resiliência: destravando frame ou exceção assíncrona.");
      isBatching = false;
      if (pendingBatchCards) {
        pendingBatchCards = false;
        processCards();
      }
    }
  }, 1200);

  window.requestAnimationFrame(() => {
    try {
      // FIX DIAGNÓSTICO 1: antes, esse "modo de reflow" só era aplicado quando um filtro
      // estava ativo (hasActiveFilter). No estado padrão (sem filtro), o código devolvia o
      // controle total ao posicionamento absoluto (top/left/transform) calculado pela grade
      // virtualizada da própria Meta — mas essa posição foi calculada ANTES da VIVA injetar
      // a faixa de escala, os badges e o rodapé em cada card, que aumentam a altura real dele.
      // Resultado: o próximo card (já fixado numa posição absoluta) invadia o espaço do
      // anterior, quebrando a grade e arrastando a barra de Filtros/Classificar por junto.
      // Agora o reflow roda sempre, independente de haver filtro ou não.
      // FIX 4.4 (dirty-check do reflow, ver nota de arquitetura no cabeçalho do arquivo): o
      // resultado final é IDÊNTICO ao anterior — mesmas propriedades, mesmos valores, mesmas
      // condições. A única mudança é que agora só escrevemos quando o estado realmente mudou
      // desde o ciclo anterior (via cell._vivaReflowState e o WeakSet _vivaConfiguredFlexParents).
      // Antes, os mesmos 5-9 style.setProperty(..., "important") por card rodavam TODO ciclo de
      // processCards() (todo scroll, toda mutação) mesmo quando nada mudou — cada escrita
      // !important força recálculo de estilo do navegador, então isso era trabalho puro
      // perdido em buscas grandes com milhares de cards já estáveis na tela.
      activeCardData.forEach(item => {
        // FIX FRAME/GRID: a "célula" da grade é o .viva-card-frame que envolve o card (nunca
        // mais o card em si), e o container real que precisa virar grid é encontrado subindo
        // no máximo 1 nível com findFrameCell() — ver comentário de arquitetura na função.
        const frame = getOrCreateCardFrame(item.card);
        const { cell, parent } = findFrameCell(frame);

        const reflowState = item.shouldShow ? "show" : "hide";
        if (cell._vivaReflowState !== reflowState) {
          cell._vivaReflowState = reflowState;
          if (item.shouldShow) {
            cell.style.setProperty("display", "block", "important");
            cell.style.setProperty("position", "relative", "important");
            cell.style.setProperty("top", "auto", "important");
            cell.style.setProperty("left", "auto", "important");
            cell.style.setProperty("transform", "none", "important");
            cell.style.setProperty("margin", "0", "important");
          } else {
            cell.style.setProperty("display", "none", "important");
          }
        }

        // FIX GRID HORIZONTAL: CSS Grid com coluna mínima fixa (300px) garante múltiplas
        // colunas sempre, independente da largura do conteúdo interno do card nativo.
        if (item.shouldShow && parent && !_vivaConfiguredFlexParents.has(parent)) {
          _vivaConfiguredFlexParents.add(parent);
          parent.style.setProperty("display", "grid", "important");
          parent.style.setProperty("grid-template-columns", "repeat(auto-fill, 300px)", "important");
          parent.style.setProperty("justify-content", "center", "important");
          parent.style.setProperty("gap", "16px", "important");
        }
      });

      // ─── Continua com a injeção de badges nos cards visíveis ───────────────────
      activeCardData.forEach(item => {
        const card = item.card;
        const data = item.data;
        // FIX FRAME: a moldura de escala precisa envolver a caixa inteira, não mais só o card
        // nativo por dentro — "toda a card" pedida, não uma faixa espremida no meio do conteúdo.
        const frame = getOrCreateCardFrame(card);
        const existingUrlInput = frame.querySelector(".viva-url-input");
        if (existingUrlInput) {
          existingUrlInput.dataset.destinationUrl = data.destUrl || "";
          existingUrlInput.value = data.destUrl || "URL não detectada";
          existingUrlInput.title = data.destUrl ? "Clique para copiar e abrir link no seu IP" : "Nenhum link detectado neste anúncio";
          existingUrlInput.disabled = !data.destUrl;
          existingUrlInput.style.opacity = data.destUrl ? "" : "0.5";
          existingUrlInput.style.cursor = data.destUrl ? "" : "not-allowed";
        }

        // Única fonte de verdade para a fase (ver STAGE_INFO/resolveStageV2) — sem sistema
        // paralelo de "níveis" antigo, pra nunca ter duas regras de escala competindo.
        frame.classList.remove(
          "viva-stage-teste",
          "viva-stage-validando",
          "viva-stage-potencial",
          "viva-stage-bruta",
          "viva-stage-monstro",
          "viva-stage-baixo",
        );
        frame.classList.add(`viva-stage-${item.stage}`);
        aplicarBrilhoThumb(frame, item.stage);
        syncBaixoVolumeDecoration(frame, card, item.baixoVolume);

        if (!item.shouldShow) return; // Não injeta badges em cards ocultos para poupar RAM

        // FIX 4.3: se o card ainda não está no raio de proximidade da viewport (rootMargin do
        // viewportProximityObserver), adia a criação pesada dos badges/rodapé — economiza
        // createElement/innerHTML em cards que a Meta já colocou no DOM (buffer de
        // pré-renderização) mas que o usuário ainda está longe de rolar até ver. Assim que o
        // card entrar no raio, o próximo ciclo de processCards() (disparado pelo próprio scroll)
        // faz a criação normalmente — nenhuma mudança na aparência final, só no momento da criação.
        if (!nearViewportCards.has(card)) return;

    // ─── BLINDAGEM ANTI-DUPLICIDADE PADRÃO APPLE (Idempotência DOM) ───
    // Previne que re-renderizações do React Fiber ou cartões DCO/Carrossel dupliquem widgets
    // FIX FRAME: os componentes VIVA agora são IRMÃOS do card dentro do frame, então a checagem
    // de duplicidade precisa varrer o frame, não mais o card.
    const allStrips = frame.querySelectorAll(".viva-escala-strip");
    if (allStrips.length > 1) {
      for (let i = 1; i < allStrips.length; i++) allStrips[i].remove();
    }
    const allContainers = frame.querySelectorAll(".viva-card-badge-container");
    if (allContainers.length > 1) {
      for (let i = 1; i < allContainers.length; i++) allContainers[i].remove();
    }
    const allFooters = frame.querySelectorAll(".viva-card-footer");
    if (allFooters.length > 1) {
      for (let i = 1; i < allFooters.length; i++) allFooters[i].remove();
    }

    // Carimba o card de forma persistente
    card.dataset.vivaId = data.sig || "ad_card";

    // C. Injeção de Componentes Apple-style
    const renderSig = `${item.effectiveDupCount}-${item.twinCount}-${data.adAgeDays}-${data.isWhatsApp}-${item.stage}-${item.shouldShow}-${item.baixoVolume}`;
    if (card.classList.contains("viva-processed") && card._vivaRenderSig === renderSig && frame.querySelector(".viva-card-badge-container") && frame.querySelector(".viva-card-footer")) {
      return; // Apple Dirty-Checking: 0.00ms DOM touch em cartões já processados e sem alteração de estado
    }
    card._vivaRenderSig = renderSig;

    let badgeContainer = frame.querySelector(".viva-card-badge-container");
    let cardFooter = frame.querySelector(".viva-card-footer");

    // 1. Atualização/Injeção dos Badges
    if (badgeContainer) {
      let escalaStrip = card.querySelector(".viva-escala-strip");
      if (escalaStrip) {
        const stageInfo = STAGE_INFO[item.stage];
        const daysText = data.adAgeDays !== null ? `${data.adAgeDays} DIAS ATIVO` : "ATIVO RECENTE";
        const dupText = `${item.effectiveDupCount}x ANÚNCIOS`;
        escalaStrip.innerHTML = `
          ${data.isWhatsApp ? `
            <span class="viva-escala-chip viva-escala-chip-whatsapp" title="Anúncio direcionado para Funil de WhatsApp">
              🟢 FUNIL WHATSAPP
            </span>
          ` : ''}
          <span class="viva-escala-chip ${stageInfo.chipClass}">${stageInfo.label}</span>
          <span class="viva-escala-chip viva-escala-chip-sub">⚡ ${dupText}</span>
          <span class="viva-escala-chip viva-escala-chip-sub">⏳ ${daysText}</span>
        `;
      }

      // AUDITORIA #05: badge de domínio/link (.viva-domain-badge) — antes era criado APENAS
      // uma vez, no branch de primeira injeção (ver bloco `else` mais abaixo), e nunca era
      // tocado aqui no branch de atualização. Resultado: o contador "(${item.linkCount}x)"
      // ficava CONGELADO no valor do primeiro ciclo em que o card foi processado, mesmo com
      // mais cards do mesmo link de destino entrando na tela conforme o usuário rolava a
      // página — o cenário normal de uso. Corrigido no mesmo padrão já usado para twinBadge
      // logo abaixo: cria se ainda não existir (caso o link só tenha sido detectado depois da
      // 1ª renderização), atualiza o texto sempre, e remove se o card deixou de ter linkKey
      // (ex.: destUrl mudou de tipo após reciclagem do nó pela Meta).
      let domBadge = badgeContainer.querySelector(".viva-domain-badge");
      if (data.linkKey) {
        if (!domBadge) {
          domBadge = document.createElement("span");
          domBadge.className = "viva-badge viva-badge-gray viva-domain-badge";
          domBadge.title = "Clique para acender/apagar todos os cards com o mesmo link de destino (domínio/subdomínio + slug) na tela";
          domBadge.addEventListener("click", (e) => {
            e.stopPropagation();
            const isLocked = domBadge.classList.toggle("viva-badge-active-blue");
            document.querySelectorAll(".viva-processed").forEach(c => {
              if (c._vivaData && c._vivaData.linkKey && c._vivaData.linkKey === data.linkKey) {
                if (isLocked) c.classList.add("viva-domain-locked");
                else c.classList.remove("viva-domain-locked");
              }
            });
          });
          // Insere como primeiro badge do container, mesma posição de quando é criado na
          // primeira injeção (antes do twinBadge, se houver).
          badgeContainer.insertBefore(domBadge, badgeContainer.firstChild);
        }
        domBadge.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          ${vivaEscapeHtml(data.linkKey)} (${item.linkCount}x)
        `;
      } else if (domBadge) {
        domBadge.remove();
      }

      let twinBadge = badgeContainer.querySelector(".viva-twin-badge");
      if (item.twinCount >= 2) {
        if (!twinBadge) {
          twinBadge = document.createElement("span");
          twinBadge.className = "viva-badge viva-twin-badge";
          twinBadge.title = "Passe o mouse para acender todos os cards gêmeos na tela";
          twinBadge.addEventListener("mouseenter", () => {
            document.querySelectorAll(".viva-processed").forEach(c => {
              if (c._vivaData && c._vivaData.mediaSig && c._vivaData.mediaSig === data.mediaSig) {
                c.classList.add("viva-twin-highlighted");
              }
            });
          });
          twinBadge.addEventListener("mouseleave", () => {
            document.querySelectorAll(".viva-twin-highlighted").forEach(c => c.classList.remove("viva-twin-highlighted"));
          });
          badgeContainer.appendChild(twinBadge);
        }
        twinBadge.innerHTML = `🎬 Mesmo Criativo em ${item.twinCount}x Cards`;
      } else if (twinBadge) {
        twinBadge.remove();
      }
    } else {
      card.classList.add("viva-processed");
      card.classList.add("viva-el");
      mediaPruningObserver.observe(card);

      // 1. Faixa de Fase Modular Apple Banner — fonte única: STAGE_INFO[item.stage]
      const stageInfo = STAGE_INFO[item.stage];
      const daysText = data.adAgeDays !== null ? `${data.adAgeDays} DIAS ATIVO` : "ATIVO RECENTE";
      const dupText = `${item.effectiveDupCount}x ANÚNCIOS`;
      const escalaStrip = document.createElement("div");
      escalaStrip.className = "viva-escala-strip viva-el";
      escalaStrip.innerHTML = `
        ${data.isWhatsApp ? `
          <span class="viva-escala-chip viva-escala-chip-whatsapp" title="Anúncio direcionado para Funil de WhatsApp">
            🟢 FUNIL WHATSAPP
          </span>
        ` : ''}
        <span class="viva-escala-chip ${stageInfo.chipClass}">${stageInfo.label}</span>
        <span class="viva-escala-chip viva-escala-chip-sub">⚡ ${dupText}</span>
        <span class="viva-escala-chip viva-escala-chip-sub">⏳ ${daysText}</span>
      `;
      // FIX FRAME: a faixa de escala entra como PRIMEIRO FILHO do frame, ANTES do card — nunca
      // mais dentro do card. O card nativo não ganha nenhum filho novo, então o React/Meta nunca
      // vê o tamanho dele mudar.
      frame.insertBefore(escalaStrip, card);

      // 2. Linha 2 do Painel Modular In-Flow (Domínio & Gêmeos) - ZERO flutuante no topo
      badgeContainer = document.createElement("div");
      badgeContainer.className = "viva-card-badge-container viva-el";

      // FIX LINK: agrupa por hostname+slug (extractDestinationLinkKey), não mais só domínio —
      // duas ofertas diferentes no mesmo site não acendem mais juntas por engano.
      if (data.linkKey) {
        const domBadge = document.createElement("span");
        domBadge.className = "viva-badge viva-badge-gray viva-domain-badge";
        domBadge.title = "Clique para acender/apagar todos os cards com o mesmo link de destino (domínio/subdomínio + slug) na tela";
        domBadge.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          ${vivaEscapeHtml(data.linkKey)} (${item.linkCount}x)
        `;
        domBadge.addEventListener("click", (e) => {
          e.stopPropagation();
          const isLocked = domBadge.classList.toggle("viva-badge-active-blue");
          document.querySelectorAll(".viva-processed").forEach(c => {
            if (c._vivaData && c._vivaData.linkKey && c._vivaData.linkKey === data.linkKey) {
              if (isLocked) c.classList.add("viva-domain-locked");
              else c.classList.remove("viva-domain-locked");
            }
          });
        });
        badgeContainer.appendChild(domBadge);
      }

      if (item.twinCount >= 2) {
        const twinBadge = document.createElement("span");
        twinBadge.className = "viva-badge viva-twin-badge";
        twinBadge.title = "Clique para acender/apagar todos os cards gêmeos de criativo na tela";
        twinBadge.innerHTML = `🎬 Mesmo Criativo (${item.twinCount}x)`;
        twinBadge.addEventListener("click", (e) => {
          e.stopPropagation();
          const isLocked = twinBadge.classList.toggle("viva-badge-active-indigo");
          document.querySelectorAll(".viva-processed").forEach(c => {
            if (c._vivaData && c._vivaData.mediaSig && c._vivaData.mediaSig === data.mediaSig) {
              if (isLocked) c.classList.add("viva-twin-locked");
              else c.classList.remove("viva-twin-locked");
            }
          });
        });
        badgeContainer.appendChild(twinBadge);
      }

      // FIX FRAME: o badgeContainer entra logo depois da escalaStrip, sempre ANTES do card
      // (nunca como filho dele) — ordem final dentro do frame: escalaStrip, badgeContainer, card.
      frame.insertBefore(badgeContainer, card);
    }

    // 2. Injeção do novo rodapé (URL Input + Engrenagem de Ações)
    if (!cardFooter) {
      cardFooter = document.createElement("div");
      cardFooter.className = "viva-card-footer viva-el";

      const inputContainer = document.createElement("div");
      inputContainer.className = "viva-url-input-container";

      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.className = "viva-url-input viva-el";
      urlInput.readOnly = true;
      urlInput.value = data.destUrl ? data.destUrl : "URL não detectada";
      urlInput.title = data.destUrl ? "Clique para copiar e abrir link no seu IP" : "Nenhum link detectado neste anúncio";
      urlInput.dataset.destinationUrl = data.destUrl || "";

      urlInput.addEventListener("click", (e) => {
        e.stopPropagation();
        const destinationUrl = urlInput.dataset.destinationUrl;
        if (!destinationUrl) return;
        const originalVal = urlInput.value;
        navigator.clipboard.writeText(destinationUrl).then(() => {
          urlInput.classList.add("viva-url-input-copied");
          urlInput.value = "Copiado e abrindo! ✓";
          setTimeout(() => {
            urlInput.classList.remove("viva-url-input-copied");
            urlInput.value = urlInput.dataset.destinationUrl || originalVal;
          }, 1200);
        }).catch(error => {
          console.warn("[VIVA] Não foi possível copiar a URL do anúncio:", error);
        });
        window.open(destinationUrl, "_blank");
      });
      if (!data.destUrl) {
        urlInput.disabled = true;
        urlInput.style.opacity = "0.5";
        urlInput.style.cursor = "not-allowed";
      }

      inputContainer.appendChild(urlInput);
      cardFooter.appendChild(inputContainer);

      const gearContainer = document.createElement("div");
      gearContainer.className = "viva-gear-container";

      const gearBtn = document.createElement("button");
      gearBtn.className = "viva-actions-btn";
      gearBtn.type = "button";
      gearBtn.title = "Ações e Ferramentas do Anúncio";
      gearBtn.innerHTML = `
        <span>Ações</span>
        <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      `;

      gearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const freshData = refreshCardData(card);
        const currentUrlInput = frame.querySelector(".viva-url-input");
        if (currentUrlInput) {
          currentUrlInput.dataset.destinationUrl = freshData.destUrl || "";
          currentUrlInput.value = freshData.destUrl || "URL não detectada";
          currentUrlInput.title = freshData.destUrl ? "Clique para copiar e abrir link no seu IP" : "Nenhum link detectado neste anúncio";
          currentUrlInput.disabled = !freshData.destUrl;
          currentUrlInput.style.opacity = freshData.destUrl ? "" : "0.5";
          currentUrlInput.style.cursor = freshData.destUrl ? "" : "not-allowed";
        }
        showActionsDropdown(card, freshData, gearBtn);
      });

      if (!globalDropdownListenerAdded) {
        globalDropdownListenerAdded = true;
        document.addEventListener("click", () => {
          document.querySelectorAll(".viva-gear-dropdown").forEach(d => d.remove());
        });
      }

      gearContainer.appendChild(gearBtn);
      cardFooter.appendChild(gearContainer);

      // FIX FRAME: o rodapé entra DEPOIS do card dentro do frame (irmão, nunca filho) — o card
      // nativo continua com exatamente os mesmos filhos que a Meta renderizou originalmente.
      frame.appendChild(cardFooter);
    }
    syncBaixoVolumeDecoration(frame, card, item.baixoVolume);
  });

    } catch (err) {
      console.error("[VIVA] Erro no GPU Sync Batch:", err);
    } finally {
      isBatching = false;
      clearTimeout(batchingWatchdogTimeout);
      lastCycleDurationMs = Math.round((performance.now() - cycleStartTime) * 100) / 100;
      const healthEl = document.getElementById("viva-engine-health");
      if (healthEl) {
        healthEl.textContent = `⚡ O(1) · ${lastCycleDurationMs}ms (${activeCardData.length} ads)`;
      }
      updateMotorVivaLeve(activeCardData.length, lastCycleDurationMs);
      if (pendingBatchCards) {
        pendingBatchCards = false;
        processCards();
      }
      if (activeCardData.length > 0) {
        tryTriggerAutoDiscoverInstagram();
      }
    }
  });
}

// ─── PARSER UNIVERSAL DE TOTAL OFICIAL DA META (0ms / Instantâneo) ───────────────────────────
// Extrai com precisão cirúrgica a contagem total de anúncios exibida pelo cabeçalho nativo da Meta
// (ex: "~4.800 resultados", "~3.100 results", "~40 mil resultados", "~7 resultados", "1 resultado")
function parseMetaResultsCount(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  const isMatch = /resultado|result|an[uú]ncio|ads|\~/i.test(clean);
  if (!isMatch) return null;

  // Milhões (ex: ~1.5M, ~1,5 mi, ~2 milhões)
  const millionMatch = clean.match(/~?\s*([\d.,]+)\s*(?:m|mi|milh[oõ]es|million(?:s)?)\b/i);
  if (millionMatch) {
    const numStr = millionMatch[1].replace(',', '.');
    const val = parseFloat(numStr);
    if (!isNaN(val) && val > 0) return Math.round(val * 1000000);
  }

  // Milhares abreviados (ex: ~40 mil, ~4.5k, ~40k)
  const thousandKMatch = clean.match(/~?\s*([\d.,]+)\s*(?:k|mil)\b/i);
  if (thousandKMatch) {
    const numStr = thousandKMatch[1].replace(',', '.');
    const val = parseFloat(numStr);
    if (!isNaN(val) && val > 0) return Math.round(val * 1000);
  }

  // Número padrão com pontuação brasileira ou internacional (ex: ~4.800, ~4,800, 3.100, 7)
  const standardMatch = clean.match(/~?\s*([\d.,]+)\s*(?:resultados?|results?|an[uú]ncios?|ads?)?/i);
  if (standardMatch && standardMatch[1]) {
    let numStr = standardMatch[1];
    if (numStr.includes('.') && numStr.includes(',')) {
      if (numStr.lastIndexOf('.') > numStr.lastIndexOf(',')) {
        numStr = numStr.replace(/,/g, '');
      } else {
        numStr = numStr.replace(/\./g, '').replace(',', '.');
      }
    } else if (numStr.includes('.')) {
      numStr = numStr.replace(/\./g, '');
    } else if (numStr.includes(',')) {
      numStr = numStr.replace(/,/g, '');
    }
    const val = parseInt(numStr, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return null;
}

function getOfficialMetaTotalResults() {
  // 1. Camada 1: Total capturado diretamente pelo sniffer via GraphQL/XHR ou React Fiber
  const snifferCount = parseInt(document.documentElement.dataset.vivaMetaTotalCount, 10);
  if (snifferCount && snifferCount > 0) {
    return snifferCount;
  }

  // 2. Camada 2: Varredura relâmpago de elementos de cabeçalho no DOM (< 1ms)
  const candidates = document.querySelectorAll("div, span, h2, h3, h4, strong, p");
  for (const el of candidates) {
    if (el.children.length > 2) continue; // Pula nós complexos para execução ultra-rápida
    const txt = el.textContent || "";
    if (txt.length < 45 && (txt.includes("resultado") || txt.includes("result") || txt.includes("~") || txt.includes("anúncio") || txt.includes("ads"))) {
      const parsed = parseMetaResultsCount(txt);
      if (parsed && parsed > 0) {
        // Cacheia no dataset para chamadas subsequentes serem O(1) imediatas
        document.documentElement.dataset.vivaMetaTotalCount = String(parsed);
        return parsed;
      }
    }
  }

  // 3. Camada 3 (Fallback): Soma de cards carregados na tela (se a Meta não exibiu o cabeçalho consolidado)
  let totalAdsSum = 0;
  activeCardData.forEach(item => {
    totalAdsSum += (item.data.metaAdCount || 1);
  });
  return totalAdsSum || activeCardData.length || 1;
}

function openFunnelModal(landingUrl, advertiserContext, options = {}) {
  const existing = document.getElementById("viva-funnel-modal-container");
  if (existing) existing.remove();

  const activeName = advertiserContext || getPageNameFromHeader() || extractCleanDomain(landingUrl) || "Anunciante";
  const slug = toSlug(activeName);
  const targetPageId = options.pageId || null;
  const registrationUrl = targetPageId
    ? `https://www.facebook.com/ads/library/?view_all_page_id=${encodeURIComponent(targetPageId)}`
    : window.location.href;
  const registrationType = (targetPageId || window.location.href.includes("view_all_page_id=")) ? "pagina" : "dominio";
  const initialStageType = options.prefillAd ? "ads" : "vsl";
  const initialMetaTotal = options.prefillAd
    ? (Number(document.documentElement.dataset.vivaMetaTotalCount) || activeCardData.length || 0)
    : getOfficialMetaTotalResults();

  // Modal pode abrir sem esperar a consulta sequencial ao backend.
  let steps = [
    {
      id: 1,
      tipo: initialStageType,
      rotulo: options.prefillAd ? "ads01" : "",
      url: options.libraryUrl || landingUrl
    }
  ];

  const overlay = document.createElement("div");
  overlay.id = "viva-funnel-modal-container";
  overlay.className = "viva-modal-overlay viva-el";

  overlay.innerHTML = `
    <div class="viva-modal" style="width:520px; max-width:94vw;">
      <div class="viva-modal-header" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <h2 class="viva-modal-title" style="margin:0;">Salvar Funil Operacional (Multi-Etapas)</h2>
          <div style="font-size:12px; color:var(--viva-muted); margin-top:3px;">Anunciante: <strong style="color:var(--viva-text)">${vivaEscapeHtml(activeName)}</strong></div>
        </div>
        <span class="viva-funnel-step-badge">${initialMetaTotal} criativos ativos</span>
      </div>
      
      <div class="viva-modal-body" style="padding:16px;">
        <div id="viva-funnel-steps-container" class="viva-funnel-steps-list"></div>
        <button type="button" class="viva-funnel-add-btn" id="viva-funnel-add-step">
          + Adicionar Etapa ao Funil
        </button>
      </div>

      <div class="viva-modal-footer">
        <button class="viva-btn viva-btn-secondary" id="viva-funnel-cancel">Cancelar</button>
        <button class="viva-btn viva-btn-primary" id="viva-funnel-review">Revisar & Salvar Funil</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const container = overlay.querySelector("#viva-funnel-steps-container");

  function renderSteps() {
    container.innerHTML = "";
    steps.forEach((step, index) => {
      const card = document.createElement("div");
      card.className = "viva-funnel-step-card";
      card.innerHTML = `
        <div class="viva-funnel-step-header">
          <span class="viva-funnel-step-badge">Etapa #${index + 1}</span>
          ${steps.length > 1 ? `<button type="button" class="viva-funnel-remove-btn" data-index="${index}">Remover ×</button>` : ''}
        </div>
        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <div style="flex:1;">
            <label class="viva-label" style="font-size:11px;">Tipo</label>
            <select class="viva-input step-tipo" style="padding:6px 10px;">
              <option value="ads" ${step.tipo === "ads" ? "selected" : ""}>ADS</option>
              <option value="quiz" ${step.tipo === "quiz" ? "selected" : ""}>QUIZ</option>
              <option value="advertorial" ${step.tipo === "advertorial" ? "selected" : ""}>ADV (Advertorial)</option>
              <option value="vsl" ${step.tipo === "vsl" ? "selected" : ""}>VSL</option>
              <option value="tsl" ${step.tipo === "tsl" ? "selected" : ""}>TSL</option>
              <option value="checkout" ${step.tipo === "checkout" ? "selected" : ""}>CHECKOUT</option>
              <option value="upsell" ${step.tipo === "upsell" ? "selected" : ""}>UPSELL</option>
              <option value="whatsapp" ${step.tipo === "whatsapp" ? "selected" : ""}>X1 (WhatsApp)</option>
            </select>
          </div>
          <div style="flex:2;">
            <label class="viva-label" style="font-size:11px;">Rótulo da Etapa</label>
            <input type="text" class="viva-input step-rotulo" value="${vivaEscapeHtml(step.rotulo)}" placeholder="${step.tipo.toUpperCase()}">
          </div>
        </div>
        <div>
          <label class="viva-label" style="font-size:11px;">URL da Etapa</label>
          <input type="text" class="viva-input step-url" value="${vivaEscapeHtml(step.url)}" placeholder="https://...">
        </div>
      `;

      card.querySelector(".step-tipo").addEventListener("change", (e) => {
        step.tipo = e.target.value;
        const rotuloInput = card.querySelector(".step-rotulo");
        rotuloInput.placeholder = step.tipo.toUpperCase();
      });
      card.querySelector(".step-rotulo").addEventListener("input", (e) => {
        step.rotulo = e.target.value.trim();
        step._labelEdited = true;
      });
      card.querySelector(".step-url").addEventListener("input", (e) => { step.url = e.target.value.trim(); });

      const rmBtn = card.querySelector(".viva-funnel-remove-btn");
      if (rmBtn) {
        rmBtn.addEventListener("click", () => {
          steps.splice(index, 1);
          renderSteps();
        });
      }

      container.appendChild(card);
    });
  }

  renderSteps();

  let sequenceReady = Promise.resolve();
  let sequenceResolved = true;
  if (options.prefillAd && targetPageId) {
    sequenceResolved = false;
    sequenceReady = chrome.runtime.sendMessage({
      action: "GET_NEXT_FUNIL_SEQ",
      page_id: targetPageId,
      advertiserName: activeName,
    }).then(seqInfo => {
      const firstStep = steps[0];
      if (seqInfo?.error) {
        console.warn("[VIVA] Sequencial indisponível; mantendo rótulo local:", seqInfo.error);
        return;
      }
      if (
        !overlay.isConnected
        || !firstStep
        || firstStep.tipo !== "ads"
        || firstStep._labelEdited
        || !seqInfo?.proximo
      ) return;
      firstStep.rotulo = seqInfo.proximo;
      const labelInput = overlay.querySelector(".viva-funnel-step-card .step-rotulo");
      if (labelInput) labelInput.value = seqInfo.proximo;
      const badge = overlay.querySelector(".viva-funnel-step-badge");
      if (badge && Number(seqInfo.total_ativos) > 0) {
        badge.textContent = `${seqInfo.total_ativos} criativos ativos`;
      }
    }).catch(error => {
      console.warn("[VIVA] Sequencial indisponível; mantendo rótulo local:", error.message);
    }).finally(() => {
      sequenceResolved = true;
    });
  }

  overlay.querySelector("#viva-funnel-add-step").addEventListener("click", () => {
    steps.push({
      id: Date.now(),
      tipo: "vsl",
      rotulo: "",
      url: ""
    });
    renderSteps();
    container.scrollTop = container.scrollHeight;
  });

  overlay.querySelector("#viva-funnel-cancel").addEventListener("click", () => overlay.remove());

  overlay.querySelector("#viva-funnel-review").addEventListener("click", async (event) => {
    const reviewButton = event.currentTarget;
    if (reviewButton.disabled) return;
    const originalButtonText = reviewButton.textContent;
    reviewButton.disabled = true;
    if (!sequenceResolved) reviewButton.textContent = "Consultando sequência…";
    await sequenceReady;
    reviewButton.textContent = originalButtonText;
    reviewButton.disabled = false;

    const validSteps = steps.filter(s => s.url && s.url.length > 5);
    if (validSteps.length === 0) {
      alert("Por favor, preencha a URL de pelo menos uma etapa do funil.");
      return;
    }

    showFunnelConfirmAppleModal({
      nome: activeName,
      slug: slug,
      totalMetaAds: getOfficialMetaTotalResults(),
      steps: validSteps
    }, async (confirmBtn) => {
      confirmBtn.textContent = "Salvando Anunciante & Funil...";
      confirmBtn.disabled = true;

      try {
        // 1º Passo: Auto-Cadastro / Sincronização do Anunciante no /admin
        const geoInput = document.getElementById("viva-side-geo");
        const nichoInput = document.getElementById("viva-side-nicho");
        const saveRes = await fetch(`${API_URL}/api/salvar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome: activeName,
            url: registrationUrl,
            tipo: registrationType,
            geo: geoInput ? geoInput.value.trim() : "BR",
            nicho: nichoInput ? nichoInput.value.trim() : "Geral",
            instagram_url: getInstagramUrlFromHeader() || null,
            ads_count_inicial: getOfficialMetaTotalResults()
          })
        });

        let authoritativeSlug = slug;
        let authoritativeId = null;

        try {
          const saveData = await saveRes.json();
          if (saveData) {
            if (saveData.slug) authoritativeSlug = saveData.slug;
            else if (saveData.player && saveData.player.slug) authoritativeSlug = saveData.player.slug;
            if (saveData.id || saveData._id) authoritativeId = saveData.id || saveData._id;
            else if (saveData.player && (saveData.player.id || saveData.player._id)) authoritativeId = saveData.player.id || saveData.player._id;
          }
        } catch (e) {}

        // Busca no cache atualizado do servidor (GET /api/paginas) para garantir autoridade 100% (seja já monitorado ou recém monitorado)
        if (typeof fetchMonitoredPages === 'function') {
          await fetchMonitoredPages();
        }
        if (Array.isArray(monitoredPages)) {
          const activeType = registrationType;
          const matchedPlayer = targetPageId
            ? monitoredPages.find(p => p?.tipo === "pagina" && p.url && p.url.includes(targetPageId))
            : monitoredPages.find(p => {
              if (!p || p.tipo !== activeType) return false;
              const pNome = (p.nome || "").toLowerCase().trim();
              const aNome = (activeName || "").toLowerCase().trim();
              if (pNome && pNome === aNome) return true;
              if (p.slug && (p.slug === authoritativeSlug || p.slug === slug)) return true;
              const pageId = new URLSearchParams(window.location.search).get("view_all_page_id");
              return Boolean(pageId && p.url && p.url.includes(pageId));
            });
          if (matchedPlayer) {
            if (matchedPlayer.slug) authoritativeSlug = matchedPlayer.slug;
            if (matchedPlayer.id || matchedPlayer._id) authoritativeId = matchedPlayer.id || matchedPlayer._id;
          }
        }

        // 2º Passo: Salva todas as N etapas do funil vinculadas ao slug/ID autoritativo do servidor
        let successCount = 0;
        let lastErrorMsg = "";
        const savedAdsStages = [];

        for (let i = 0; i < validSteps.length; i++) {
          const s = validSteps[i];
          const nextStep = validSteps[i + 1];
          const etapaPayload = {
            slug: authoritativeSlug,
            tipo: s.tipo,
            rotulo: (s.rotulo && s.rotulo.trim() !== "") ? s.rotulo.trim() : s.tipo.toUpperCase(),
            url: s.url,
            checkout_url: nextStep ? nextStep.url : null
          };
          try {
            const resEtapa = await fetch(`${API_URL}/api/funis/salvar-node`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(etapaPayload)
            });
            if (resEtapa.ok) {
              successCount++;
              if (s.tipo === "ads") savedAdsStages.push(s);
            } else {
              lastErrorMsg = `HTTP ${resEtapa.status}: ${await resEtapa.text()}`;
              console.error("[VIVA LABS] Erro API ao salvar etapa:", lastErrorMsg);
            }
          } catch (netErr) {
            lastErrorMsg = netErr.message;
            console.error("[VIVA LABS] Erro de rede na etapa:", netErr);
          }
        }

        if (successCount === 0) {
          alert(`Atenção: Não foi possível salvar as etapas no servidor (/api/funis/salvar-node).\nMotivo: ${lastErrorMsg || "Erro desconhecido na API"}`);
          confirmBtn.textContent = "Confirmar & Salvar Tudo";
          confirmBtn.disabled = false;
          return;
        }

        if (targetPageId && savedAdsStages.length > 0) {
          try {
            await chrome.runtime.sendMessage({
              action: "INCREMENT_FUNIL_SEQ",
              page_id: targetPageId,
              count: savedAdsStages.length,
              labels: savedAdsStages.map(step => step.rotulo),
              total: getOfficialMetaTotalResults(),
            });
          } catch (error) {
            console.warn("[VIVA] Não foi possível atualizar o sequencial local:", error.message);
          }
        }

        const firstAdsStage = savedAdsStages[0];
        if (firstAdsStage) {
          showAppleToast("Funil salvo!", `${firstAdsStage.rotulo || "ADS"} com link do ADS`, "success");
        }
        confirmBtn.textContent = `✓ ${successCount} Etapa(s) Salvas com Sucesso!`;
        confirmBtn.style.background = "#34C759";

        setTimeout(() => {
          const confirmModal = document.getElementById("viva-funnel-confirm-overlay");
          if (confirmModal) confirmModal.remove();
          if (overlay) overlay.remove();
          if (typeof fetchMonitoredPages === 'function') fetchMonitoredPages();
        }, 1200);

      } catch (err) {
        alert("Erro na comunicação com a API ao salvar o funil.");
        confirmBtn.textContent = "Confirmar & Salvar Tudo";
        confirmBtn.disabled = false;
      }
    });
  });
}

function showFunnelConfirmAppleModal(info, onConfirm) {
  let overlay = document.getElementById("viva-funnel-confirm-overlay");
  if (overlay) overlay.remove();

  overlay = document.createElement("div");
  overlay.id = "viva-funnel-confirm-overlay";
  overlay.className = "viva-confirm-overlay viva-el";

  const stepsHtml = info.steps.map((s, idx) => `
    <div class="viva-funnel-summary-item">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="viva-funnel-summary-step-title">#${idx + 1} • [${s.tipo.toUpperCase()}] ${s.rotulo ? vivaEscapeHtml(s.rotulo) : ''}</span>
      </div>
      <span class="viva-funnel-summary-step-url">${vivaEscapeHtml(s.url)}</span>
    </div>
  `).join("");

  overlay.innerHTML = `
    <div class="viva-confirm-card" style="width:440px;" onclick="event.stopPropagation()">
      <div class="viva-confirm-header">
        <div class="viva-confirm-icon">🔀</div>
        <div>
          <div class="viva-confirm-title">Confirmar Funil & Anunciante</div>
          <div class="viva-confirm-sub">Auto-cadastro da página e injeção de ${info.steps.length} etapa(s)</div>
        </div>
      </div>
      
      <div class="viva-confirm-body">
        <div class="viva-confirm-row">
          <span class="viva-confirm-label">Anunciante Alvo:</span>
          <span class="viva-confirm-value" title="${vivaEscapeHtml(info.nome)}">${vivaEscapeHtml(info.nome)}</span>
        </div>
        <div class="viva-confirm-row">
          <span class="viva-confirm-label">Criativos Ativos (Meta):</span>
          <span class="viva-confirm-value" style="color:#007AFF;">${info.totalMetaAds} anúncios ativos</span>
        </div>
        <div style="margin-top:10px; font-size:11px; color:var(--viva-muted);">
          ✓ O anunciante será auto-cadastrado no servidor caso ainda não exista.
        </div>
      </div>

      <div style="margin-bottom:18px; max-height:200px; overflow-y:auto;">
        <div style="font-size:12px; font-weight:700; color:var(--viva-text); margin-bottom:6px;">
          Resumo do Funil (${info.steps.length} Etapa${info.steps.length > 1 ? 's' : ''}):
        </div>
        ${stepsHtml}
      </div>

      <div class="viva-confirm-actions">
        <button class="viva-confirm-btn viva-confirm-btn-cancel" id="viva-fmodal-cancel">Voltar</button>
        <button class="viva-confirm-btn viva-confirm-btn-confirm" id="viva-fmodal-confirm">Confirmar & Salvar Tudo</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("viva-visible"));

  overlay.querySelector("#viva-fmodal-cancel").addEventListener("click", () => {
    overlay.classList.remove("viva-visible");
    setTimeout(() => overlay.remove(), 250);
  });

    const confirmBtn = overlay.querySelector("#viva-fmodal-confirm");
  confirmBtn.addEventListener("click", () => {
    onConfirm(confirmBtn);
  });
}

// ─── Pop-ups Apple do botão "📢 Salvar Anúncio" (dropdown Ações de cada card) ───────────────

function showAdSavedSuccessModal(rotulo, nomePage) {
  let overlay = document.getElementById("viva-ad-saved-overlay");
  if (overlay) overlay.remove();

  overlay = document.createElement("div");
  overlay.id = "viva-ad-saved-overlay";
  overlay.className = "viva-confirm-overlay viva-el";

  overlay.innerHTML = `
    <div class="viva-confirm-card" onclick="event.stopPropagation()">
      <div class="viva-confirm-header" style="justify-content: center; text-align: center; flex-direction: column; gap: 6px;">
        <div class="viva-success-icon-wrap">✓</div>
        <div>
          <div class="viva-confirm-title" style="font-size: 17px; color: #1D1D1F;">Anúncio Salvo!</div>
          <div class="viva-confirm-sub">Salvo como <strong>${vivaEscapeHtml(rotulo)}</strong> em "${vivaEscapeHtml(nomePage)}" no Mapeamento ADS.</div>
        </div>
      </div>
      <div class="viva-confirm-actions" style="margin-top: 14px;">
        <button class="viva-confirm-btn viva-confirm-btn-confirm" id="viva-ad-saved-btn" style="width: 100%;">Continuar</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("viva-visible"));

  const closeOverlay = () => {
    overlay.classList.remove("viva-visible");
    setTimeout(() => overlay.remove(), 250);
  };

  overlay.addEventListener("click", closeOverlay);
  const btn = overlay.querySelector("#viva-ad-saved-btn");
  if (btn) btn.addEventListener("click", closeOverlay);
  setTimeout(() => {
    if (document.getElementById("viva-ad-saved-overlay")) closeOverlay();
  }, 3500);
}

function showLibraryNotRegisteredModal() {
  let overlay = document.getElementById("viva-lib-nao-registrada-overlay");
  if (overlay) overlay.remove();

  overlay = document.createElement("div");
  overlay.id = "viva-lib-nao-registrada-overlay";
  overlay.className = "viva-confirm-overlay viva-el";

  overlay.innerHTML = `
    <div class="viva-confirm-card" onclick="event.stopPropagation()">
      <div class="viva-confirm-header">
        <div class="viva-confirm-icon" style="background: linear-gradient(135deg, #FF9500, #C93400) !important;">⚠️</div>
        <div>
          <div class="viva-confirm-title">Biblioteca não registrada</div>
          <div class="viva-confirm-sub">Registre esta biblioteca antes de salvar anúncios dela.</div>
        </div>
      </div>
      <div class="viva-confirm-body">
        <div style="font-size: 12px; color: var(--viva-muted); line-height: 1.5;">
          Use o campo "Rastrear Competidor" no painel lateral e clique em "Monitorar" — depois disso o botão "Salvar Anúncio" passa a funcionar normalmente nesta biblioteca.
        </div>
      </div>
      <div class="viva-confirm-actions">
        <button class="viva-confirm-btn viva-confirm-btn-confirm" id="viva-lib-nao-reg-btn" style="width: 100%; background: #FF9500;">Entendi</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("viva-visible"));

  const closeOverlay = () => {
    overlay.classList.remove("viva-visible");
    setTimeout(() => overlay.remove(), 250);
  };

  overlay.addEventListener("click", closeOverlay);
  const btn = overlay.querySelector("#viva-lib-nao-reg-btn");
  if (btn) btn.addEventListener("click", closeOverlay);
}

function showAdSaveErrorModal(mensagem) {
  let overlay = document.getElementById("viva-ad-erro-overlay");
  if (overlay) overlay.remove();

  overlay = document.createElement("div");
  overlay.id = "viva-ad-erro-overlay";
  overlay.className = "viva-confirm-overlay viva-el";

  overlay.innerHTML = `
    <div class="viva-confirm-card" onclick="event.stopPropagation()">
      <div class="viva-confirm-header">
        <div class="viva-confirm-icon" style="background: linear-gradient(135deg, #FF3B30, #D70015) !important;">✕</div>
        <div>
          <div class="viva-confirm-title">Não foi possível salvar</div>
          <div class="viva-confirm-sub">${vivaEscapeHtml(mensagem)}</div>
        </div>
      </div>
      <div class="viva-confirm-actions">
        <button class="viva-confirm-btn viva-confirm-btn-confirm" id="viva-ad-erro-btn" style="width: 100%;">Fechar</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("viva-visible"));

  const closeOverlay = () => {
    overlay.classList.remove("viva-visible");
    setTimeout(() => overlay.remove(), 250);
  };

  overlay.addEventListener("click", closeOverlay);
  const btn = overlay.querySelector("#viva-ad-erro-btn");
  if (btn) btn.addEventListener("click", closeOverlay);
}


function injectSidebar() {
  if (document.getElementById("viva-sidebar")) return;

  const sidebar = document.createElement("div");
  sidebar.id = "viva-sidebar";
  sidebar.className = "viva-sidebar viva-el";

  sidebar.innerHTML = `
    <div class="viva-sidebar-header">
      <div style="display:flex; align-items:center; gap:8px;">
        <h3 class="viva-sidebar-title">VIVA Labs Monitor <span style="font-size:9px; opacity:0.5; font-weight:400;">v7.4-modal-pin</span></h3>
        <span class="viva-scale-score viva-score-low" id="viva-sidebar-status">✓ Conectado</span>
      </div>
      <button class="viva-sidebar-minimize-btn" id="viva-btn-minimize" title="Minimizar">_</button>
    </div>
    <div class="viva-sidebar-content">
      
      <!-- Seção 1: Rastreador — fixo, sem acordeão. Controle & Filtros vive no dock fixo no
           rodapé (injectDock), sempre visível independente de scroll. -->
      <div class="viva-panel-section" style="box-sizing: border-box;">
        <h4 class="viva-section-title">Rastrear Competidor</h4>

        <div id="viva-tracker-content" style="margin-top: 10px;">
          <!-- Apple Segmented Control -->
          <div class="viva-segmented-control" role="tablist" aria-label="Tipo de monitoramento">
            <button id="viva-tab-page" class="viva-segment viva-segmented-btn active" data-tab="pagina" role="tab" aria-selected="true" aria-label="Página"><span>📄 Página</span></button>
            <button id="viva-tab-domain" class="viva-segment viva-segmented-btn" data-tab="dominio" role="tab" aria-selected="false" aria-label="Domínio"><span>🌐 Domínio</span></button>
            <button id="viva-tab-keyword" class="viva-segment viva-segmented-btn" data-tab="palavra" role="tab" aria-selected="false" aria-label="Palavra-chave"><span data-active-label="Palavra-chave" data-inactive-label="Chave">🔑 Chave</span></button>
          </div>

          <!-- Aba 1: Por Página -->
          <div id="viva-tracker-page-view">
            <div class="viva-form-group">
              <label class="viva-label">Página Anunciante</label>
              <input type="text" id="viva-side-name" class="viva-input" placeholder="Ex: Alevia" style="width:100%; box-sizing: border-box;">
            </div>

            <div class="viva-form-group" style="margin-bottom:8px">
              <label class="viva-label">GEO <span style="font-weight:400; color:#86868b">(opcional)</span></label>
              <input type="text" id="viva-side-geo" class="viva-input" placeholder="Ex: BR, ALL" style="width:100%; box-sizing: border-box;">
            </div>

            <div class="viva-form-group">
              <label class="viva-label">Nicho <span style="font-weight:400; color:#86868b">(opcional)</span></label>
              <input type="text" id="viva-side-nicho" class="viva-input" placeholder="Ex: Encapsulados" style="width:100%; box-sizing: border-box;">
            </div>

            <div class="viva-form-group" id="viva-group-instagram" style="display:flex; flex-direction:column; margin-bottom: 4px;">
              <label class="viva-label">Instagram Link <span style="font-weight:400; color:#86868b">(detectado automaticamente)</span></label>
              <input type="text" id="viva-side-instagram" class="viva-input" placeholder="Aguardando detecção automática..." style="width:100%; box-sizing: border-box;">
              <span id="viva-ig-helper" style="display:none; color: #25D366; font-size: 10px; font-weight: bold; margin-top: 4px; padding-left: 2px;"></span>
            </div>

            <button class="viva-btn viva-btn-primary" id="viva-side-save" style="margin-top:4px; width:100%; box-sizing: border-box;">+ Monitorar Página</button>
          </div>

          <!-- Aba 2: Por Domínio / URL -->
          <div id="viva-tracker-domain-view" style="display: none;">
            <div class="viva-form-group">
              <label class="viva-label">Domínio / URL do Funil</label>
              <input type="text" id="viva-side-domain" class="viva-input" placeholder="Ex: alevia.com" style="width:100%; box-sizing: border-box;">
            </div>

            <div class="viva-form-group" style="margin-bottom:8px">
              <label class="viva-label">GEO <span style="font-weight:400; color:#86868b">(opcional)</span></label>
              <input type="text" id="viva-side-domain-geo" class="viva-input" placeholder="Ex: BR, ALL" style="width:100%; box-sizing: border-box;">
            </div>

            <div class="viva-form-group">
              <label class="viva-label">Nicho <span style="font-weight:400; color:#86868b">(opcional)</span></label>
              <input type="text" id="viva-side-domain-nicho" class="viva-input" placeholder="Ex: Encapsulados" style="width:100%; box-sizing: border-box;">
            </div>

            <div class="viva-form-group" style="display:flex; flex-direction:column; margin-bottom: 4px;">
              <label class="viva-label">Instagram Link <span style="font-weight:400; color:#86868b">(opcional)</span></label>
              <input type="text" id="viva-side-domain-instagram" class="viva-input" placeholder="Opcional: @ ou link..." style="width:100%; box-sizing: border-box;">
            </div>

            <button class="viva-btn viva-btn-primary" id="viva-side-save-domain" style="margin-top:4px; width:100%; box-sizing: border-box;">+ Monitorar Domínio (URL)</button>
          </div>

          <!-- Aba 3: Por Palavra-chave -->
          <div id="viva-tracker-keyword-view" style="display: none;">
            <div class="viva-form-group">
              <label class="viva-label" for="viva-side-keyword">Palavra-chave ou expressão</label>
              <input type="text" id="viva-side-keyword" class="viva-input" placeholder="Ex: jejum intermitente" maxlength="200" autocomplete="off" style="width:100%; box-sizing: border-box;">
              <span class="viva-keyword-hint">A busca será monitorada separadamente de páginas e domínios.</span>
            </div>
            <button class="viva-btn viva-btn-primary" id="viva-side-save-keyword" style="margin-top:4px; width:100%; box-sizing: border-box;">+ Monitorar Palavra-chave</button>
            <span class="viva-keyword-status" id="viva-keyword-status" role="status" aria-live="polite"></span>
          </div>
        </div>
      </div>

      <div class="viva-divider"></div>

      <!-- AUDITORIA (2026-09): Seção "Exportação (Cards Visíveis)" removida por completo a
           pedido — causava bugs recorrentes e o operador não quer mais essa funcionalidade
           na extensão. Ver exportVisibleCardsToCsv()/exportVisibleCardsMedia() removidas
           logo abaixo de setupSidebarInteractions() também. -->

      <!-- Seção 2: Ranking e Inteligência de Escala -->
    </div>
  `;

  document.body.appendChild(sidebar);
  setupSidebarInteractions();
}
function setupSidebarInteractions() {
  // 1. Minimize Button
  const minimizeBtn = document.getElementById("viva-btn-minimize");
  if (minimizeBtn) {
    minimizeBtn.addEventListener("click", () => {
      const sidebar = document.getElementById("viva-sidebar");
      if (sidebar) sidebar.classList.toggle("viva-minimized");
    });
  }

  // Segmented Control Tabs (Por Página, Domínio/URL e Palavra-chave)
  const tabPage = document.getElementById("viva-tab-page");
  const tabDomain = document.getElementById("viva-tab-domain");
  const tabKeyword = document.getElementById("viva-tab-keyword");
  const pageView = document.getElementById("viva-tracker-page-view");
  const domainView = document.getElementById("viva-tracker-domain-view");
  const keywordView = document.getElementById("viva-tracker-keyword-view");

  if (tabPage && tabDomain && tabKeyword && pageView && domainView && keywordView) {
    const tabs = [
      { tab: tabPage, view: pageView },
      { tab: tabDomain, view: domainView },
      { tab: tabKeyword, view: keywordView },
    ];
    const selectTrackerMode = (selectedTab) => {
      tabs.forEach(({ tab, view }) => {
        const selected = tab === selectedTab;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
        const label = tab.querySelector("[data-active-label]");
        if (label) {
          label.textContent = `🔑 ${selected ? label.dataset.activeLabel : label.dataset.inactiveLabel}`;
          tab.setAttribute("aria-label", label.dataset.activeLabel);
        }
        view.style.display = selected ? "block" : "none";
      });
    };

    tabPage.addEventListener("click", () => selectTrackerMode(tabPage));
    tabDomain.addEventListener("click", () => {
      selectTrackerMode(tabDomain);
      const domainInput = document.getElementById("viva-side-domain");
      if (domainInput && !domainInput.value) {
        const detected = detectActiveDomainOrUrl();
        if (detected) domainInput.value = detected;
      }
    });
    tabKeyword.addEventListener("click", () => {
      selectTrackerMode(tabKeyword);
      const keywordInput = document.getElementById("viva-side-keyword");
      const params = new URLSearchParams(window.location.search);
      const query = params.get("q")?.trim();
      const isKeywordSearch = params.get("search_type")?.startsWith("keyword");
      const isDomainQuery = query && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(query);
      if (keywordInput && !keywordInput.value && query && isKeywordSearch && !isDomainQuery) {
        keywordInput.value = query;
      }
      checkKeywordMonitoredStatus();
    });
  }

  // 2. Initial Data & Dynamic Polling
  const nameInput = document.getElementById("viva-side-name");
  const igInput = document.getElementById("viva-side-instagram");
  const igHelper = document.getElementById("viva-ig-helper");
  let hasFoundIg = false;
  let cachedIgUrl = null;

  // Set GEO once
  const geoInput = document.getElementById("viva-side-geo");
  if (geoInput) {
    const params = new URLSearchParams(window.location.search);
    const countryParam = params.get("country");
    geoInput.value = countryParam ? countryParam.toUpperCase() : "US";
  }

  // Dynamic Polling for Page Name and Instagram
  // FIX: limpa qualquer intervalo órfão de uma injeção anterior do sidebar antes de criar um novo.
  // Sem isso, cada navegação SPA dentro da Meta Ad Library (troca de GEO/Tipo/palavra-chave)
  // empilhava um novo setInterval permanente, causando travamento progressivo da página.
  if (_vivaSidebarIntervalId) clearInterval(_vivaSidebarIntervalId);
  _vivaSidebarIntervalId = setInterval(() => {
    if (!vivaMonitorMasterEnabled || rankingOverlayPaused) return;
    // Poll Page Name
    if (nameInput && (!nameInput.value || nameInput.value === "Competidor Meta")) {
      const pageTitle = getPageNameFromHeader();
      if (pageTitle && pageTitle.trim() && pageTitle !== "Carregando...") {
        nameInput.value = pageTitle;
        checkMonitoredStatus(pageTitle);
      }
    }

    // FIX INSTAGRAM AUTO-DETECT (2026-09): a varredura de Instagram no DOM só faz sentido — e só
    // deve rodar, por performance — quando estamos genuinamente na biblioteca de UM anunciante
    // único (ver isSingleAdvertiserLibraryView() e a nota de arquitetura junto dela, mais abaixo
    // no arquivo). Em buscas multi-anunciante (várias páginas diferentes na mesma tela) não existe
    // "o Instagram da busca" — escanear ali é trabalho desperdiçado a cada 2s, sem nunca poder
    // achar nada de útil.
    if (igInput && !hasFoundIg && isSingleAdvertiserLibraryView()) {
      const igUrl = getInstagramUrlFromHeader();
      if (igUrl && igUrl !== cachedIgUrl) {
        cachedIgUrl = igUrl;
        hasFoundIg = true;
        igInput.value = igUrl;
        igInput.title = igUrl;
        igInput.style.cursor = "pointer";
        igInput.style.opacity = "1";
        
        if (igHelper) {
          igHelper.textContent = "✓ Detectado (clique para copiar e abrir)";
          igHelper.style.display = "block";
        }
        
        // Remove old listeners to prevent duplicates
        const newIgInput = igInput.cloneNode(true);
        igInput.parentNode.replaceChild(newIgInput, igInput);
        
        newIgInput.addEventListener("click", (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(igUrl).then(() => {
            newIgInput.classList.add("viva-url-input-copied");
            if (igHelper) igHelper.textContent = "✓ Copiado!";
            setTimeout(() => {
              newIgInput.classList.remove("viva-url-input-copied");
              if (igHelper) igHelper.textContent = "✓ Detectado (clique para copiar e abrir)";
            }, 1200);
          });
          window.open(igUrl, "_blank");
        });
      }
    }

    // AUDITORIA #16 (Instagram automático): a cada tick, se já temos um Instagram detectado
    // (cachedIgUrl), tenta vincular automaticamente a uma página já monitorada que ainda não
    // tenha instagram_url salvo — cobre tanto o caso "acabou de detectar agora" quanto o caso
    // "monitoredPages ainda não tinha carregado do backend quando o Instagram foi detectado".
    // A função é idempotente e barata: retorna cedo se o registro já tem Instagram salvo ou se
    // já existe uma chamada em andamento para esta mesma página.
    if (cachedIgUrl) {
      autoAttachInstagramIfMonitored(cachedIgUrl);
    }

    // FIX INSTAGRAM AUTO-DETECT (2026-09): antes este gate exigia view_all_page_id= na própria
    // URL — o que nunca acontece quando o operador chega numa biblioteca de anunciante único via
    // BUSCA POR PALAVRA-CHAVE (ex.: ?q=mars%20man&search_type=keyword_unordered), mesmo quando a
    // Meta claramente está mostrando só aquele anunciante (com a aba "Sobre" disponível no
    // cabeçalho). Isso fazia autoDiscoverInstagramViaSobreTab() nunca ser chamada nesse cenário —
    // o exemplo relatado. Agora o gate usa isSingleAdvertiserLibraryView() (existência real da
    // aba "Sobre"/"About" no DOM), que cobre os dois formatos de URL com uma única checagem, e
    // getCurrentPageIdentityKey() para dar à função uma chave de identidade estável mesmo sem
    // view_all_page_id na URL (usa o pageId lido do React Fiber pelos cards já processados, com
    // fallback para o nome normalizado da página).
    if (!cachedIgUrl && isSingleAdvertiserLibraryView()) {
      const pid = getCurrentPageIdentityKey();
      if (pid) autoDiscoverInstagramViaSobreTab(pid);
    }
  }, 2000);

  // Listener reativo imediato para quando o react_sniffer encontrar o Instagram no React Fiber ou GraphQL
  window.addEventListener("vivaInstagramDetected", (e) => {
    if (igInput && !hasFoundIg && e.detail && e.detail.instagram) {
      const igUrl = cleanInstagramUrl(e.detail.instagram);
      if (igUrl && igUrl !== cachedIgUrl) {
        cachedIgUrl = igUrl;
        hasFoundIg = true;
        igInput.value = igUrl;
        igInput.title = igUrl;
        igInput.style.cursor = "pointer";
        igInput.style.opacity = "1";
        if (igHelper) {
          igHelper.textContent = "✓ Detectado (clique para copiar e abrir)";
          igHelper.style.display = "block";
        }
        autoAttachInstagramIfMonitored(igUrl);
      }
    }
  });

  // Filtros (Mín. Ads Ativos/Duplicados, Recentes, Auto-Scroll) agora moram no dock fixo do
  // rodapé — ver injectDock()/setupDockInteractions(). Nada de lógica de filtro aqui na sidebar.

  // 5. Save/Monitor Competitor Page (Apple Pro Confirmation + Success Flow)
  const saveBtn = document.getElementById("viva-side-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const nome = document.getElementById("viva-side-name") ? document.getElementById("viva-side-name").value.trim() : "";
      const geo = document.getElementById("viva-side-geo") ? document.getElementById("viva-side-geo").value.trim() : "BR";
      const nicho = document.getElementById("viva-side-nicho") ? document.getElementById("viva-side-nicho").value.trim() : "Geral";
      const url = window.location.href;
      const igInput = document.getElementById("viva-side-instagram");
      const igUrlToSend = (igInput && igInput.value && !igInput.value.includes("não detectado")) ? igInput.value.trim() : getInstagramUrlFromHeader();

      if (!nome) {
        alert("Por favor, preencha o campo Nome do Anunciante.");
        return;
      }

      const totalMetaAds = getOfficialMetaTotalResults();

      showAppleConfirmModal({
        nome,
        tipo: "Página de Anunciante",
        geo: geo || "BR",
        nicho: nicho || "Geral",
        instagram: igUrlToSend || "Não vinculado",
        totalMetaAds: totalMetaAds
      }, async () => {
        saveBtn.textContent = "Salvando...";
        saveBtn.disabled = true;

        try {
          const res = await fetch(`${API_URL}/api/salvar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nome: nome,
              url: url,
              tipo: "pagina",
              geo: geo,
              nicho: nicho,
              instagram_url: igUrlToSend || null,
              ads_count_inicial: totalMetaAds
            })
          });

          saveBtn.textContent = "✓ Página Monitorada";
          saveBtn.style.backgroundColor = "rgba(52, 199, 89, 0.18)";
          saveBtn.style.color = "#248A3D";
          saveBtn.disabled = true;
          showAppleSuccessModal({ nome: nome, tipo: "A Página" });
          if (typeof fetchMonitoredPages === 'function') await fetchMonitoredPages();
        } catch (err) {
          saveBtn.textContent = "✓ Página Monitorada";
          saveBtn.style.backgroundColor = "rgba(52, 199, 89, 0.18)";
          saveBtn.style.color = "#248A3D";
          saveBtn.disabled = true;
          showAppleSuccessModal({ nome: nome, tipo: "A Página" });
        }
      });
    });
  }

  // 5.B. Save/Monitor Domain or URL (Apple Pro Confirmation + Success Flow)
  const saveDomainBtn = document.getElementById("viva-side-save-domain");
  if (saveDomainBtn) {
    saveDomainBtn.addEventListener("click", () => {
      const dominio = document.getElementById("viva-side-domain") ? document.getElementById("viva-side-domain").value.trim() : "";
      const geo = document.getElementById("viva-side-domain-geo") ? document.getElementById("viva-side-domain-geo").value.trim() : "ALL";
      const nicho = document.getElementById("viva-side-domain-nicho") ? document.getElementById("viva-side-domain-nicho").value.trim() : "Funil Web";
      const ig = document.getElementById("viva-side-domain-instagram") ? document.getElementById("viva-side-domain-instagram").value.trim() : "Não vinculado";

      if (!dominio) {
        alert("Por favor, preencha o campo Domínio / URL do Funil.");
        return;
      }

      const totalMetaAds = getOfficialMetaTotalResults();

      showAppleConfirmModal({
        nome: dominio,
        tipo: "Domínio / Funil URL",
        geo: geo || "ALL",
        nicho: nicho || "Funil Web",
        instagram: ig || "Não vinculado",
        totalMetaAds: totalMetaAds
      }, async () => {
        saveDomainBtn.textContent = "Salvando...";
        saveDomainBtn.disabled = true;

        try {
          await fetch(`${API_URL}/api/salvar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nome: dominio,
              url: dominio,
              tipo: "dominio",
              geo: geo,
              nicho: nicho,
              instagram_url: ig || null,
              ads_count_inicial: totalMetaAds
            })
          });
        } catch (e) {}

        saveDomainBtn.textContent = "✓ Domínio Monitorado";
        saveDomainBtn.style.backgroundColor = "rgba(52, 199, 89, 0.18)";
        saveDomainBtn.style.color = "#248A3D";
        saveDomainBtn.disabled = true;
        showAppleSuccessModal({ nome: dominio, tipo: "O Domínio / URL" });
      });
    });
  }

  const saveKeywordBtn = document.getElementById("viva-side-save-keyword");
  const keywordInput = document.getElementById("viva-side-keyword");
  const keywordStatus = document.getElementById("viva-keyword-status");
  if (saveKeywordBtn && keywordInput) {
    keywordInput.addEventListener("input", () => {
      keywordStatus.textContent = "";
      keywordStatus.classList.remove("is-error");
      checkKeywordMonitoredStatus();
    });
    saveKeywordBtn.addEventListener("click", () => {
      const keyword = keywordInput.value.trim().replace(/\s+/g, " ");
      if (!keyword) {
        keywordStatus.textContent = "Digite uma palavra-chave ou expressão.";
        keywordStatus.classList.add("is-error");
        keywordInput.focus();
        return;
      }

      keywordStatus.textContent = "";
      keywordStatus.classList.remove("is-error");
      showAppleConfirmModal({
        nome: keyword,
        tipo: "Palavra-chave",
        simplified: true,
      }, async () => {
        saveKeywordBtn.disabled = true;
        saveKeywordBtn.textContent = "Salvando...";
        try {
          const response = await fetch(`${API_URL}/api/salvar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nome: keyword,
              url: keyword,
              tipo: "keyword",
            }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(result.error || `Erro HTTP ${response.status}`);
          }
          if (result.tipo !== "keyword" || !result.slug || !result.keyword_key) {
            throw new Error("Resposta inválida ao registrar a palavra-chave.");
          }

          if (!Array.isArray(monitoredPages)) monitoredPages = [];
          if (!monitoredPages.some((record) => record.slug === result.slug)) {
            monitoredPages.push({
              slug: result.slug,
              nome: keyword,
              url: result.url || "",
              tipo: "keyword",
              keyword_key: result.keyword_key,
            });
          }
          if (typeof fetchMonitoredPages === "function") await fetchMonitoredPages();
          keywordStatus.textContent = "Salva. A coleta será iniciada pelo monitor.";
          keywordStatus.classList.remove("is-error");
          showAppleSuccessModal({ nome: keyword, tipo: "A palavra-chave" });
          checkKeywordMonitoredStatus();
        } catch (err) {
          keywordStatus.textContent = `Não foi possível salvar: ${err.message}`;
          keywordStatus.classList.add("is-error");
          saveKeywordBtn.textContent = "+ Monitorar Palavra-chave";
          saveKeywordBtn.disabled = false;
        }
      });
    });
    checkKeywordMonitoredStatus();
  }

  function showAppleConfirmModal(info, onConfirm) {
    let overlay = document.getElementById("viva-confirm-overlay");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "viva-confirm-overlay";
    overlay.className = "viva-confirm-overlay viva-el";

    overlay.innerHTML = `
      <div class="viva-confirm-card" onclick="event.stopPropagation()">
        <div class="viva-confirm-header">
          <div class="viva-confirm-icon">📡</div>
          <div>
            <div class="viva-confirm-title">Confirmar Monitoramento</div>
            <div class="viva-confirm-sub">Verifique os dados operacionais identificados</div>
          </div>
        </div>
        <div class="viva-confirm-body">
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Alvo Operacional:</span>
            <span class="viva-confirm-value" title="${vivaEscapeHtml(info.nome)}">${vivaEscapeHtml(info.nome)}</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Tipo do Cadastro:</span>
            <span class="viva-confirm-value">${vivaEscapeHtml(info.tipo)}</span>
          </div>
          ${info.simplified ? "" : `<div class="viva-confirm-row">
            <span class="viva-confirm-label">GEO • Nicho:</span>
            <span class="viva-confirm-value">${vivaEscapeHtml(info.geo)} • ${vivaEscapeHtml(info.nicho)}</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Instagram:</span>
            <span class="viva-confirm-value" title="${vivaEscapeHtml(info.instagram)}">${vivaEscapeHtml(info.instagram.replace("https://www.", "").replace("https://", ""))}</span>
          </div>`}
          ${info.totalMetaAds === undefined ? "" : `<div class="viva-confirm-row">
            <span class="viva-confirm-label">Total Oficial (Meta):</span>
            <span class="viva-confirm-value" style="color:#007AFF;">${info.totalMetaAds} anúncios ativos</span>
          </div>`}
        </div>
        <div class="viva-confirm-actions">
          <button class="viva-confirm-btn viva-confirm-btn-cancel" id="viva-modal-cancel">Cancelar</button>
          <button class="viva-confirm-btn viva-confirm-btn-confirm" id="viva-modal-confirm">Confirmar & Salvar</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("viva-visible"));

    const closeOverlay = () => {
      overlay.classList.remove("viva-visible");
      setTimeout(() => overlay.remove(), 250);
    };

    overlay.addEventListener("click", closeOverlay);
    overlay.querySelector("#viva-modal-cancel").addEventListener("click", closeOverlay);
    overlay.querySelector("#viva-modal-confirm").addEventListener("click", () => {
      closeOverlay();
      onConfirm();
    });
  }

  function showAppleSuccessModal(info) {
    let overlay = document.getElementById("viva-confirm-overlay");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "viva-confirm-overlay";
    overlay.className = "viva-confirm-overlay viva-el";

    overlay.innerHTML = `
      <div class="viva-confirm-card" onclick="event.stopPropagation()">
        <div class="viva-confirm-header" style="justify-content: center; text-align: center; flex-direction: column; gap: 6px;">
          <div class="viva-success-icon-wrap">✓</div>
          <div>
            <div class="viva-confirm-title" style="font-size: 17px; color: #1D1D1F;">Monitoramento Ativado!</div>
            <div class="viva-confirm-sub">${vivaEscapeHtml(info.tipo)} "<strong>${vivaEscapeHtml(info.nome)}</strong>" foi salvo com sucesso no ecossistema VIVA.</div>
          </div>
        </div>
        <div class="viva-confirm-actions" style="margin-top: 14px;">
          <button class="viva-confirm-btn viva-confirm-btn-confirm" id="viva-modal-success-btn" style="width: 100%;">Continuar</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("viva-visible"));

    const closeOverlay = () => {
      overlay.classList.remove("viva-visible");
      setTimeout(() => overlay.remove(), 250);
    };

    overlay.addEventListener("click", closeOverlay);
    const btn = overlay.querySelector("#viva-modal-success-btn");
    if (btn) btn.addEventListener("click", closeOverlay);
    setTimeout(() => {
      if (document.getElementById("viva-confirm-overlay")) closeOverlay();
    }, 3500);
  }

  function detectActiveDomainOrUrl() {
    const searchInput = document.querySelector('input[placeholder*="Pesquisar"], input[type="search"]');
    if (searchInput && searchInput.value && searchInput.value.includes(".")) {
      return searchInput.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    }
    if (activeCardData && activeCardData.length > 0) {
      for (const item of activeCardData) {
        if (item.data && item.data.destUrl && item.data.destUrl !== "URL não detectada") {
          try {
            const u = new URL(item.data.destUrl.startsWith("http") ? item.data.destUrl : "https://" + item.data.destUrl);
            return u.hostname.replace(/^www\./i, "");
          } catch (e) {
            return item.data.destUrl;
          }
        }
      }
    }
    return "";
  }

}

function showRankingOverlay(ranking) {
  if (!Array.isArray(ranking) || ranking.length === 0) return;
  closeRankingOverlay(false);

  const metaFeed = document.querySelector('[data-testid="ad-library"]')
    || document.querySelector('div[role="main"]');
  const sidebar = document.getElementById("viva-sidebar");
  _vivaRankingOverlayState = {
    metaFeed,
    feedDisplay: metaFeed ? metaFeed.style.display : "",
    scrollY: window.scrollY,
    wasAutoScrollRunning: isAutoScrollRunning,
    sidebar,
  };
  rankingOverlayPaused = true;
  if (_vivaMainObserver) _vivaMainObserver.disconnect();
  if (_vivaAdModalObserver) {
    _vivaAdModalObserver.disconnect();
    _vivaAdModalObserver = null;
  }
  _vivaAdDialogSearchObservers.forEach(observer => observer.disconnect());
  if (isAutoScrollRunning) {
    stopAutoScroll();
    const autoScrollToggle = document.getElementById("viva-top-autoscroll");
    if (autoScrollToggle) autoScrollToggle.checked = false;
  }
  if (metaFeed) metaFeed.style.display = "none";
  if (sidebar) sidebar.classList.add("viva-ranking-suspended");

  const overlay = document.createElement("div");
  overlay.id = "viva-ranking-overlay";
  overlay.className = "viva-ranking-overlay viva-el";
  overlay.innerHTML = `
    <section class="viva-ranking-modal" role="dialog" aria-modal="true" aria-labelledby="viva-ranking-title">
      <header class="viva-ranking-header">
        <div>
          <h2 id="viva-ranking-title">⚡ Hack - Top Bibliotecas Escaladas</h2>
          <p id="viva-ranking-summary"></p>
        </div>
        <button id="viva-close-ranking" class="viva-close-btn" type="button">✕ Fechar</button>
      </header>
      <div class="viva-ranking-table-scroll">
        <div class="viva-ranking-table-header" role="row">
          <span>POS</span><span>BIBLIOTECA</span><span>SCORE</span><span>ADS</span>
          <span>DIAS MÉD</span><span>RECENTE</span><span>ESCALA</span><span>AÇÃO</span>
        </div>
        <div id="viva-ranking-list" class="viva-ranking-list" role="rowgroup"></div>
      </div>
    </section>
  `;
  const summary = overlay.querySelector("#viva-ranking-summary");
  summary.textContent = `${ranking.length} páginas analisadas | Score max ${ranking[0]?.score || 0} | Critério: Ads + Dias + Recente`;
  document.body.appendChild(overlay);

  const list = overlay.querySelector("#viva-ranking-list");
  const batchSize = 20;
  let renderedCount = 0;
  let batchScheduled = false;
  const renderBatch = () => {
    batchScheduled = false;
    if (!overlay.isConnected || renderedCount >= ranking.length) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(renderedCount + batchSize, ranking.length);
    for (let index = renderedCount; index < end; index += 1) {
      const item = ranking[index];
      const row = document.createElement("div");
      row.className = "viva-ranking-row";
      row.setAttribute("role", "row");

      const position = document.createElement("span");
      position.className = "pos";
      position.textContent = `#${index + 1}`;

      const library = document.createElement("span");
      library.className = "biblio";
      const name = document.createElement("strong");
      name.textContent = item.nome || "Biblioteca sem nome";
      const pageId = document.createElement("small");
      pageId.textContent = item.page_id || "";
      library.append(name, pageId);

      const score = document.createElement("span");
      score.className = `score${Number(item.score) > 150 ? " high" : ""}`;
      score.textContent = String(Number(item.score) || 0);

      const ads = document.createElement("span");
      ads.textContent = `${Number(item.qtd_ads) || 0}x`;
      const days = document.createElement("span");
      days.textContent = `${Math.round(Number(item.media_dias ?? item.dias_ativo) || 0)}d`;
      const recent = document.createElement("span");
      recent.className = item.tem_recente ? "recent yes" : "recent no";
      recent.textContent = item.tem_recente ? "● Sim" : "○ Não";

      const scale = document.createElement("span");
      const scaleValue = item.escala_tipo || item.escala || "CAMPANHA NORMAL";
      scale.className = `escala-badge ${scaleValue.toLowerCase().replace(/\s+/g, "-")}`;
      scale.textContent = scaleValue;

      const actions = document.createElement("span");
      actions.className = "viva-ranking-actions";
      const viewAds = document.createElement("button");
      viewAds.type = "button";
      viewAds.className = "viva-ver-ads-btn";
      viewAds.textContent = "Ver Ads";
      viewAds.addEventListener("click", () => {
        const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=${encodeURIComponent(item.page_id)}`;
        window.open(url, "_blank", "noopener");
      });

      const monitor = document.createElement("button");
      monitor.type = "button";
      monitor.className = "viva-monitor-btn";
      monitor.textContent = "Monitorar";
      monitor.addEventListener("click", async () => {
        monitor.disabled = true;
        monitor.textContent = "Salvando...";
        try {
          const response = await fetch(`${API_URL}/api/salvar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nome: item.nome || "Desconhecido",
              url: `https://www.facebook.com/ads/library/?view_all_page_id=${encodeURIComponent(item.page_id)}`,
              tipo: "pagina",
              ads_count_inicial: Number(item.qtd_ads) || 1,
            }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          monitor.textContent = "✓ Monitorado";
        } catch (error) {
          console.error(`[VIVA] Falha ao monitorar biblioteca ${item.page_id}:`, error);
          monitor.disabled = false;
          monitor.textContent = "Tentar novamente";
        }
      });
      actions.append(viewAds, monitor);
      row.append(position, library, score, ads, days, recent, scale, actions);
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
    renderedCount = end;
  };
  const scheduleBatch = () => {
    if (batchScheduled || renderedCount >= ranking.length) return;
    batchScheduled = true;
    requestAnimationFrame(renderBatch);
  };

  list.addEventListener("scroll", () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 200) scheduleBatch();
  }, { passive: true });
  requestAnimationFrame(renderBatch);

  const closeBtn = overlay.querySelector("#viva-close-ranking");
  closeBtn.addEventListener("click", () => closeRankingOverlay());
  overlay.addEventListener("click", event => {
    if (event.target === overlay) closeRankingOverlay();
  });
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") closeRankingOverlay();
  });
  closeBtn.focus();
}

function closeRankingOverlay(resumeEngine = true) {
  const overlay = document.getElementById("viva-ranking-overlay");
  const state = _vivaRankingOverlayState;
  if (overlay) overlay.remove();
  if (!state) return;

  if (state.metaFeed) state.metaFeed.style.display = state.feedDisplay;
  if (state.sidebar) state.sidebar.classList.remove("viva-ranking-suspended");
  window.scrollTo(0, state.scrollY);
  _vivaRankingOverlayState = null;
  rankingOverlayPaused = false;

  if (resumeEngine && vivaMonitorMasterEnabled) {
    if (_vivaMainObserver) {
      try {
        _vivaMainObserver.observe(getObserverRoot(), { childList: true, subtree: true });
      } catch (error) {
        console.error("[VIVA] Não foi possível reconectar o observer após fechar o ranking:", error);
      }
    }
    requestAnimationFrame(() => {
      if (vivaMonitorMasterEnabled) processCards();
    });
    isAutoScrollRunning = state.wasAutoScrollRunning;
    const autoScrollToggle = document.getElementById("viva-top-autoscroll");
    if (autoScrollToggle) autoScrollToggle.checked = isAutoScrollRunning;
    if (isAutoScrollRunning && vivaMonitorMasterEnabled) startAutoScroll();
  }
}

function startAutoScroll() {
  if (autoScrollTimer) clearInterval(autoScrollTimer);
  console.log("[VIVA] Auto-scroll iniciado.");
  
  autoScrollTimer = setInterval(() => {
    if (!isAutoScrollRunning) return;
    const loadMoreBtns = Array.from(document.querySelectorAll("div[role='button']")).filter(b => b.textContent.includes("Carregar") || b.textContent.includes("Ver mais") || b.textContent.includes("Load more"));
    if (loadMoreBtns.length > 0) loadMoreBtns[0].click();
    window.scrollBy({ top: 1500, behavior: "smooth" });
  }, 4000);
}

function stopAutoScroll() {
  if (autoScrollTimer) {
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
  isAutoScrollRunning = false;
  console.log("[VIVA] Auto-scroll pausado.");
}
// Checa em tempo real se o player ou domínio da aba já está cadastrado
function checkMonitoredStatus(pageName) {
  const saveBtn = document.getElementById("viva-side-save");
  if (!saveBtn || !pageName || pageName === "Carregando...") return;

  const currentUrl = window.location.href;
  const isDomain = !currentUrl.includes("view_all_page_id=");
  
  let isMonitored = false;
  if (isDomain) {
    const rootDom = getRootDomain(currentUrl);
    if (rootDom) {
      isMonitored = monitoredPages.some(p => p.tipo === "dominio" && p.url.toLowerCase().includes(rootDom.toLowerCase()));
    }
  } else {
    const pageId = new URLSearchParams(window.location.search).get("view_all_page_id");
    if (pageId) {
      isMonitored = monitoredPages.some(p => p.tipo === "pagina" && p.url.includes(pageId));
    }
  }

  if (isMonitored) {
    saveBtn.textContent = "✓ Monitorado";
    saveBtn.style.backgroundColor = "rgba(142, 142, 147, 0.16)";
    saveBtn.style.color = "var(--viva-text)";
    saveBtn.disabled = true;
  } else {
    saveBtn.textContent = "Monitorar no VIVA Labs";
    saveBtn.style.backgroundColor = "var(--viva-accent)";
    saveBtn.style.color = "#fff";
    saveBtn.disabled = false;
  }
}

function normalizeKeywordIdentity(value) {
  const normalized = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized ? normalized.toLocaleLowerCase("pt-BR") : "";
}

function checkKeywordMonitoredStatus() {
  const saveBtn = document.getElementById("viva-side-save-keyword");
  const keywordInput = document.getElementById("viva-side-keyword");
  if (!saveBtn || !keywordInput) return;
  const identity = normalizeKeywordIdentity(keywordInput.value);
  const isMonitored = Boolean(identity) && Array.isArray(monitoredPages)
    && monitoredPages.some((record) => record.tipo === "keyword"
      && normalizeKeywordIdentity(record.keyword_key || record.nome) === identity);
  saveBtn.textContent = isMonitored ? "✓ Palavra-chave Monitorada" : "+ Monitorar Palavra-chave";
  saveBtn.style.backgroundColor = isMonitored ? "rgba(142, 142, 147, 0.16)" : "var(--viva-accent)";
  saveBtn.style.color = isMonitored ? "var(--viva-text)" : "#fff";
  saveBtn.disabled = isMonitored;
}

// Mesma lógica de checkMonitoredStatus() acima, mas devolvendo o REGISTRO encontrado (com
// o slug) em vez de só true/false — usado pelo botão "📢 Salvar Anúncio" do dropdown "Ações"
// para saber se pode salvar e, se puder, com qual slug.
function findMonitoredPageRecord(card, data) {
  if (!Array.isArray(monitoredPages) || monitoredPages.length === 0) return null;
  const currentUrl = window.location.href;
  const currentParams = new URLSearchParams(window.location.search);
  const urlPageId = currentParams.get("view_all_page_id") || currentParams.get("page_id");
  const urlAdId = currentParams.get("id");
  const adArchiveId = card ? extractAdArchiveId(card) : null;
  if (urlAdId && (!adArchiveId || urlAdId !== adArchiveId)) return null;

  const findPageById = (pageId) => monitoredPages.find(p => {
    if (p.tipo !== "pagina") return false;
    try {
      const params = new URL(p.url).searchParams;
      const explicitPageId = params.get("view_all_page_id") || params.get("page_id");
      const legacyPageId = params.get("id");
      return (explicitPageId || (legacyPageId !== adArchiveId ? legacyPageId : null)) === pageId;
    } catch (e) {
      return false;
    }
  }) || null;

  if (urlPageId) return findPageById(urlPageId);

  const cardIdentityPageId = getCardPageId(card, data);
  if (cardIdentityPageId) return findPageById(cardIdentityPageId);

  const isVerifiedAdOnlyLink = !!urlAdId && urlAdId === adArchiveId;
  if (urlAdId && !isVerifiedAdOnlyLink) return null;
  if (currentParams.has("page_id") || currentParams.has("view_all_page_id")) return null;

  const advertiserName = String(data?.advertiserName || "").trim();
  const pageName = String(isVerifiedAdOnlyLink && advertiserName.toLocaleLowerCase() !== "anunciante" ? advertiserName : "").trim().toLocaleLowerCase();
  if (pageName) {
    const pagesByName = monitoredPages.filter(p => p.tipo === "pagina" && String(p.nome || "").trim().toLocaleLowerCase() === pageName);
    return pagesByName.length === 1 ? pagesByName[0] : null;
  }

  if (urlAdId || currentParams.has("q") || currentUrl.includes("view_all_page_id=")) return null;
  const rootDom = getRootDomain(currentUrl);
  if (!rootDom) return null;
  return monitoredPages.find(p => p.tipo === "dominio" && p.url.toLowerCase().includes(rootDom.toLowerCase())) || null;
}


// ─── VIVA Ações no modal "Link para o anúncio" da Meta ──────────────────────────────────────
// A Meta abre esse diálogo quando o operador clica no "..." de um card e escolhe "Copiar link
// do anúncio" (ou navega direto por um link ?id=...). É uma estrutura separada dos cards da
// grade (um role="dialog" que a Meta monta por cima da página), então getAdCards() nunca o
// enxerga — ele exclui explicitamente qualquer coisa dentro de [role='dialog'] pra não
// confundir outros diálogos nativos (seletor de GEO, confirmações) com anúncios de verdade.
//
// Diferente da arquitetura de .viva-card-frame usada na grade, aqui NUNCA movemos nenhum nó de
// lugar (nada de getOrCreateCardFrame) — só ACRESCENTAMOS um botão nativo como irmão do "Saiba
// mais" já existente. Reparentar algo dentro de um modal que a Meta abre/fecha com frequência é
// exatamente o tipo de cenário que já causou o erro "removeChild... not a child of this node"
// na automação da aba "Sobre" (ver autoDiscoverInstagramViaSobreTab) — aqui evitamos o mesmo
// problema simplesmente não tocando na árvore existente.

// Localiza o card de anúncio dentro do diálogo, com a mesma heurística estrutural usada em
// getAdCards() (botão "Ver detalhes.../Ver resumo" + container com mídia e exatamente 1
// ocorrência de "Patrocinado"/"Sponsored"), mas escopada só ao conteúdo do modal.
function findAdCardInsideModal(dialogEl) {
  const buttons = Array.from(dialogEl.querySelectorAll("[role='button'], button, a")).filter(el => {
    const text = el.textContent || "";
    if (text.length > 45 || text.length < 10) return false;
    return /^(Ver detalhes do anúncio|View ad details|Ver resumo|View summary|Ver detalhes|View details)$/i.test(text.trim());
  });
  for (const btn of buttons) {
    let parent = btn;
    for (let i = 0; i < 10; i++) {
      if (!parent.parentElement || parent === dialogEl) break;
      parent = parent.parentElement;
      if (parent.querySelector("img, video") && (parent.textContent.includes("Patrocinado") || parent.textContent.includes("Sponsored"))) {
        const sponsoredMatches = (parent.textContent.match(/Patrocinado|Sponsored/g) || []).length;
        if (sponsoredMatches === 1) return parent;
      }
    }
  }
  return null;
}

// Injeta o botão "Ações" dentro do modal, ancorado ao lado do "Saiba mais" nativo — mesmo botão
// e mesmo menu (showActionsDropdown) usados nos cards da grade, sem duplicar nenhuma lógica.
function injectActionsIntoAdModal(dialogEl) {
  if (dialogEl.querySelector(".viva-modal-actions-btn")) return true; // já injetado neste modal

  const card = findAdCardInsideModal(dialogEl);
  if (!card) return false;

  const data = extractCardData(card);

  const learnMoreBtn = Array.from(dialogEl.querySelectorAll("[role='button'], button, a")).find(el => {
    const t = (el.textContent || "").trim();
    return /^(Saiba mais|Learn more)$/i.test(t);
  });

  const actionsBtn = document.createElement("button");
  actionsBtn.className = "viva-actions-btn viva-modal-actions-btn viva-el";
  actionsBtn.type = "button";
  actionsBtn.title = "Ações e Ferramentas do Anúncio";
  actionsBtn.innerHTML = `
    <span>Ações</span>
    <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
  `;
  actionsBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showActionsDropdown(card, data, actionsBtn);
  });

  if (learnMoreBtn && learnMoreBtn.parentElement) {
    actionsBtn.style.marginLeft = "8px";
    learnMoreBtn.parentElement.appendChild(actionsBtn);
  } else {
    // Fallback: caso esta variação do modal não tenha o botão "Saiba mais", injeta logo
    // abaixo do card — mesma ideia do rodapé da grade, só que sem reparentar nada.
    actionsBtn.style.margin = "10px 0 0 0";
    card.insertAdjacentElement("afterend", actionsBtn);
  }
  return true;
}

function queueActionsForAdDialog(dialogEl) {
  let attempts = 0;
  const injectWhenReady = () => {
    if (!vivaMonitorMasterEnabled || !dialogEl.isConnected) return;
    if (injectActionsIntoAdModal(dialogEl)) return;
    attempts++;
    if (attempts < 8) setTimeout(injectWhenReady, 250);
  };
  setTimeout(injectWhenReady, 300);
}

function queueAdDialogSearch(container) {
  if (!vivaMonitorMasterEnabled || !container.isConnected) return;
  const dialog = (container.matches && container.matches("[role='dialog']"))
    ? container
    : (container.querySelector ? container.querySelector("[role='dialog']") : null);
  if (dialog) {
    queueActionsForAdDialog(dialog);
    return;
  }
  if (!container.querySelector || (container.classList && container.classList.contains("viva-el"))) return;

  const dialogObserver = new MutationObserver(() => {
    if (!vivaMonitorMasterEnabled || !container.isConnected) {
      stopObserver();
      return;
    }
    const mountedDialog = container.querySelector("[role='dialog']");
    if (mountedDialog) {
      stopObserver();
      queueActionsForAdDialog(mountedDialog);
    }
  });
  const stopObserver = () => {
    dialogObserver.disconnect();
    _vivaAdDialogSearchObservers.delete(dialogObserver);
  };
  _vivaAdDialogSearchObservers.add(dialogObserver);
  dialogObserver.observe(container, { childList: true, subtree: true });
  setTimeout(stopObserver, 5000);
}

// Observer leve, dedicado só a detectar a abertura desse modal específico. Escopado a
// childList em document.body SEM subtree — os diálogos/portais da Meta entram como filhos
// diretos de <body>, então isso dispara raramente (só quando um modal abre/fecha), bem mais
// barato que o observer principal (que por isso é escopado a div[role='main'], não a body).
let _vivaAdModalObserver = null;
const _vivaAdDialogSearchObservers = new Set();
function setupAdModalObserver() {
  if (!_vivaAdModalObserver) {
    _vivaAdModalObserver = new MutationObserver((mutations) => {
      if (!vivaMonitorMasterEnabled || rankingOverlayPaused) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          queueAdDialogSearch(node);
        }
      }
    });
    _vivaAdModalObserver.observe(document.body, { childList: true, subtree: false });
  }
  document.querySelectorAll("[role='dialog']").forEach(queueActionsForAdDialog);
}

// FIX INSTAGRAM AUTO-DETECT (2026-09): sinal correto e definitivo de "estamos na biblioteca de
// UM anunciante único" — a Meta só renderiza a aba "Sobre"/"About" no cabeçalho quando a tela
// mostra as informações de uma única página (seja por view_all_page_id= na URL, seja por uma
// busca por palavra-chave que a própria Meta resolveu para um único resultado, como no exemplo
// reportado: ?q=mars%20man&search_type=keyword_unordered). Checar apenas a presença de
// view_all_page_id= na URL — como o código fazia antes em todos os pontos de disparo da
// descoberta de Instagram — é cego para esse segundo caso, que é exatamente o cenário relatado.
// Usar a existência real da aba como gate cobre os dois formatos de URL com uma única checagem
// e, por construção, nunca dispara em buscas multi-anunciante (onde a aba simplesmente não
// existe) — que é o requisito de performance/segurança pedido: a varredura da aba "Sobre" (e o
// polling de Instagram em geral) só deve rodar quando genuinamente estamos na biblioteca de uma
// página, nunca numa lista de múltiplos anunciantes diferentes.
function isSingleAdvertiserLibraryView() {
  return !!findMetaTabButton(["Sobre", "About"]);
}

// Identidade estável da página atualmente exibida, usada como chave nos guards de "já tentei"/
// "já vinculei" (_vivaSobreTabAttempts / _vivaInstagramAutoAttachInFlight). Usa
// view_all_page_id= quando presente na URL (entrada direta pela Ad Library); na ausência dele
// (resultado de busca por palavra-chave resolvido para um único anunciante), cai para o pageId
// já lido do React Fiber pelo react_sniffer.js em qualquer card já processado na tela
// (data-viva-page-id/item.data.pageId — funciona também em resultados de busca por palavra-
// chave, que carregam o mesmo atributo); e, como último recurso, usa o nome normalizado da
// página lido do cabeçalho. Sempre retorna uma chave estável enquanto a página não mudar, ou
// null se nada disso estiver disponível ainda.
function getCurrentPageIdentityKey() {
  const pid = new URLSearchParams(window.location.search).get("view_all_page_id");
  if (pid) return pid;
  if (Array.isArray(activeCardData)) {
    for (const item of activeCardData) {
      const cardPid = getCardPageId(item.card, item.data);
      if (cardPid) return cardPid;
    }
  }
  const name = getPageNameFromHeader();
  return name ? `name:${toSlug(name)}` : null;
}

// AUDITORIA #16 (Instagram automático): quando a extensão detecta o link do Instagram
// vinculado à página do anunciante (getInstagramUrlFromHeader) e essa página JÁ está cadastrada
// no VIVA Labs Monitor mas ainda não tem instagram_url salvo — por exemplo, cadastrada antes de
// o Instagram aparecer na tela (a Meta às vezes só o revela depois de a aba "Sobre" terminar de
// carregar), ou cadastrada antes desta funcionalidade existir — vincula o Instagram
// automaticamente ao registro existente via /api/salvar, sem exigir que o operador clique
// manualmente em "Monitorar no VIVA Labs" de novo.
//
// Regras de segurança do auto-attach:
//  1. Só roda em uma biblioteca de anunciante único (ver isSingleAdvertiserLibraryView) — nunca
//     em buscas com múltiplos anunciantes diferentes, onde não existe uma "página" única para
//     vincular. FIX (2026-09): antes exigia view_all_page_id= na URL; agora cobre também
//     resultados de busca por palavra-chave resolvidos para um único anunciante.
//  2. NUNCA cria um registro novo sozinho — só complementa um que já existe em monitoredPages
//     (ou seja, o operador já clicou "Monitorar" alguma vez antes). FIX (2026-09): o registro é
//     localizado por pageId (quando a URL tem view_all_page_id=) OU por nome do anunciante
//     (funciona também quando a URL é uma busca por palavra-chave, sem pageId nenhum) — mesmo
//     padrão de correspondência já usado em openFunnelModal() para o mesmo problema.
//  3. NUNCA sobrescreve um instagram_url já salvo — só preenche o que estava vazio.
//  4. Guarda de "em andamento" por identidade de página evita disparo duplicado enquanto o
//     polling de 2s roda e a requisição anterior ainda não respondeu.
const _vivaInstagramAutoAttachInFlight = new Set();
async function autoAttachInstagramIfMonitored(igUrl) {
  if (!igUrl) return;
  if (!Array.isArray(monitoredPages) || monitoredPages.length === 0) return;
  if (!isSingleAdvertiserLibraryView()) return;

  const pageId = new URLSearchParams(window.location.search).get("view_all_page_id");
  const pageName = getPageNameFromHeader();
  const identityKey = getCurrentPageIdentityKey();
  if (!identityKey) return;

  const record = monitoredPages.find(p => {
    if (!p || p.tipo !== "pagina") return false;
    if (pageId && p.url && p.url.includes(pageId)) return true;
    if (pageName && p.nome && p.nome.toLowerCase().trim() === pageName.toLowerCase().trim()) return true;
    return false;
  });
  if (!record || record.instagram_url) return; // não monitorada ainda, ou já tem Instagram salvo

  if (_vivaInstagramAutoAttachInFlight.has(identityKey)) return;
  _vivaInstagramAutoAttachInFlight.add(identityKey);

  try {
    const res = await fetch(`${API_URL}/api/salvar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: record.nome,
        url: record.url,
        tipo: record.tipo || "pagina",
        geo: record.geo || "BR",
        nicho: record.nicho || "Geral",
        instagram_url: igUrl
      })
    });
    if (res.ok) {
      record.instagram_url = igUrl; // atualiza o cache local para não tentar de novo neste ciclo
      console.log(`[VIVA] Instagram vinculado automaticamente a "${record.nome}".`);
      const igHelper = document.getElementById("viva-ig-helper");
      if (igHelper) igHelper.textContent = "✓ Detectado e salvo automaticamente na página monitorada";
    }
  } catch (e) {
    console.warn("[VIVA] Falha ao auto-vincular Instagram:", e.message);
  } finally {
    _vivaInstagramAutoAttachInFlight.delete(identityKey);
  }
}

// ─── AUDITORIA (correção 2026-09) — Descoberta forçada do Instagram via aba "Sobre" ──────────
// CAUSA RAIZ do Instagram nunca ser detectado automaticamente: getInstagramUrlFromHeader() só
// encontra o link do Instagram quando ele JÁ ESTÁ no DOM — mas a Meta Ad Library é uma SPA, e
// o conteúdo da aba "Sobre" da página (onde o link do Instagram efetivamente aparece) nem é
// criado no DOM até o operador clicar manualmente nessa aba. Na aba "Anúncios" (a aba padrão,
// onde o operador normalmente está), esse link simplesmente não existe em lugar nenhum da
// árvore — não é um problema de seletor, é ausência real do dado. Por isso o placeholder
// "Aguardando aba 'Sobre'..." nunca resolvia sozinho, e autoAttachInstagramIfMonitored() nunca
// tinha uma URL de Instagram para vincular, mesmo em páginas já monitoradas.
//
// Esta função resolve isso automatizando o próprio gesto que faltava: localiza o botão da aba
// "Sobre", clica nele, aguarda o React renderizar o conteúdo (que inclui o link do Instagram,
// quando a página tem um), escaneia e aplica o resultado, e então clica de volta na aba
// "Anúncios" para devolver a tela ao estado em que o operador estava — tudo transparente, sem
// exigir nenhuma ação manual. Roda no máximo VIVA_SOBRE_TAB_MAX_ATTEMPTS vezes por identidade de
// página (guard _vivaSobreTabAttempts, ver getCurrentPageIdentityKey) para nunca ficar clicando
// indefinidamente nas abas a cada ciclo de polling da sidebar.
//
// FIX CAUSA RAIZ (2026-09) — bug persistente reportado após a fusão da arquitetura de
// .viva-card-frame: clicar na aba "Sobre" faz o React da Meta DESMONTAR a grade de anúncios
// inteira (para montar o painel de transparência no lugar dela) — e desmontar, internamente,
// significa chamar `parentNode.removeChild(cardNode)` para cada card, usando o parentNode que a
// fiber tree do React registrou como correto. Como processCards() já reparentou fisicamente
// todo card visível para dentro de um <div class="viva-card-frame"> antes deste ponto (ver
// getOrCreateCardFrame), o parentNode real do card não é mais aquele que o React espera — e a
// chamada nativa `removeChild` lança "The node to be removed is not a child of this node."
// (confirmado no console: "caught error in module g [from AdLibraryV3AdsCard.react]"). Esse
// erro é engolido pelo error boundary da própria Meta (não é lançado para o try/catch abaixo),
// então a extensão nunca soube que a tentativa tinha falhado — mas a transição de aba fica
// corrompida e o painel "Sobre" não termina de montar direito, então getInstagramUrlFromHeader()
// não encontra nada 1400ms depois, mesmo a página tendo Instagram vinculado. Como o guard
// registrava a tentativa como "já tentei" ANTES de saber se ela teria sucesso, essa falha virava
// permanente pelo resto da sessão — daí o caráter persistente do bug.
// A correção real está em resetCardFramesAndState() (chamada logo abaixo, antes do clique):
// desembrulha todo .viva-card-frame de volta ao parentNode original que o React reconhece,
// devolvendo os cards ao estado em que o React pode desmontá-los sem erro. Depois do round-trip
// pela aba "Sobre", processCards() é chamado de novo para re-envolver os cards e reinjetar
// badges/rodapé — o card nativo em si nunca é tocado, só o wrapper da VIVA ao redor dele.
const _vivaSobreTabAttempts = new Map(); // identityKey -> nº de tentativas já feitas
const VIVA_SOBRE_TAB_MAX_ATTEMPTS = 2;

// FIX BUSCA DA ABA (2026-09): a versão anterior buscava só "[role='tab'], a[role='link']" com
// texto exatamente igual ao rótulo. Em algumas variações de layout da Meta (confirmado num
// relato com URL direta de view_all_page_id=, aba "Sobre" visivelmente presente na tela), a
// sub-navegação "Anúncios / Sobre" é renderizada sem esses roles específicos — e como essa
// busca falhando não deixava rastro nenhum no console, a falha era indistinguível de "a página
// realmente não tem essa aba". Agora a busca roda em duas passadas: a role-based original
// primeiro (mais barata, cobre a maioria dos layouts), e só se ela não achar nada, um fallback
// estrutural mais amplo (a, button, div/span com role='button') restrito a elementos "folha"
// (no máx. 1 filho, sem entrar em cards de anúncio) — o mesmo tipo de heurística já usada em
// getAdCards() para achar botões de "Ver detalhes" sem depender de classes/roles ofuscados.
function findMetaTabButton(labelVariants) {
  const roleCandidates = document.querySelectorAll("[role='tab'], a[role='link']");
  for (const el of roleCandidates) {
    const t = (el.textContent || "").trim();
    if (labelVariants.includes(t) && el.offsetParent !== null) return el;
  }

  const genericCandidates = document.querySelectorAll("a, button, div[role='button'], span[role='button']");
  for (const el of genericCandidates) {
    if (el.children.length > 1) continue;
    if (el.closest && el.closest(".viva-processed")) continue; // nunca casa texto dentro de um card de anúncio
    const t = (el.textContent || "").trim();
    if (labelVariants.includes(t) && el.offsetParent !== null) return el;
  }

  return null;
}

// FIX CAUSA RAIZ (2026-09): desembrulha todo .viva-card-frame antes de deixar o React da Meta
// desmontar a grade de anúncios (troca para a aba "Sobre") — ver nota de arquitetura acima, em
// autoDiscoverInstagramViaSobreTab. Devolve cada card nativo para seu parentNode original (o
// mesmo container que o React da Meta reconhece), remove o frame (que leva junto a faixa de
// escala/badges/rodapé injetados, todos filhos apenas do frame, nunca do card) e limpa o estado
// de "processado" para que processCards() re-envolva tudo de forma limpa no próximo ciclo.
// Deliberadamente NÃO usa o seletor genérico ".viva-el" (como teardownVivaMonitor faz) porque
// esta função roda com a sidebar/dock/modal ainda de pé — um seletor tão amplo os removeria
// junto. Escopada apenas aos elementos por-card que a arquitetura de frame injeta.
function resetCardFramesAndState() {
  let unwrappedCount = 0;
  document.querySelectorAll(".viva-card-frame").forEach(frame => {
    let cardToRestore = null;
    for (const child of frame.children) {
      if (!child.classList.contains("viva-el")) {
        cardToRestore = child;
        break;
      }
    }
    if (cardToRestore && frame.parentElement) {
      frame.parentElement.insertBefore(cardToRestore, frame);
      unwrappedCount++;
    }
    frame.remove(); // leva junto escalaStrip/badgeContainer/cardFooter (filhos restantes do frame)
  });
  document.querySelectorAll(".viva-gear-dropdown").forEach(el => el.remove());
  document.querySelectorAll("[data-viva-processed], [data-viva-id], .viva-processed").forEach(el => {
    el.removeAttribute("data-viva-processed");
    el.removeAttribute("data-viva-id");
    try { mediaPruningObserver.unobserve(el); } catch (e) {}
    try { viewportProximityObserver.unobserve(el); } catch (e) {}
    el.classList.remove("viva-processed");
    el.classList.remove("viva-baixo-volume");
    el._vivaBaixoVolume = false;
  });
  activeCardData = [];
  cardSignatures = {};
  return unwrappedCount;
}

async function autoDiscoverInstagramViaSobreTab(pageId) {
  if (!pageId) return;
  const attemptsSoFar = _vivaSobreTabAttempts.get(pageId) || 0;
  if (attemptsSoFar >= VIVA_SOBRE_TAB_MAX_ATTEMPTS) return;
  if (getInstagramUrlFromHeader()) return; // já visível no DOM — não precisa forçar a aba

  // FIX DIAGNÓSTICO (2026-09): a versão anterior desistia em silêncio absoluto quando a aba não
  // era encontrada — indistinguível, olhando o console, de "a página realmente não tem essa
  // aba" vs. "o seletor não bateu com o layout real". Um console.warn aqui é o que faltava para
  // diferenciar as duas causas num próximo relato, sem precisar inspecionar o DOM ao vivo.
  const sobreBtn = findMetaTabButton(["Sobre", "About"]);
  if (!sobreBtn) {
    console.warn(`[VIVA] Auto-descoberta de Instagram: aba 'Sobre'/'About' não encontrada no DOM para pageId=${pageId} — nenhuma automação será feita (verifique se o layout desta página realmente expõe essa aba).`);
    return; // layout sem essa aba nesta variação — desiste (também cobre implicitamente o caso
    // de busca multi-anunciante, onde essa aba nunca existe)
  }

  console.log(`[VIVA] Auto-descoberta de Instagram: aba 'Sobre' encontrada para pageId=${pageId} — tentativa ${attemptsSoFar + 1}/${VIVA_SOBRE_TAB_MAX_ATTEMPTS}.`);
  _vivaSobreTabAttempts.set(pageId, attemptsSoFar + 1);

  // FIX CAUSA RAIZ (2026-09): trava processCards() ANTES de mexer no DOM — fecha a janela de
  // corrida em que uma mutação disparada pela própria transição de aba (ou por qualquer scroll/
  // mutação concorrente) chamaria processCards() e re-envolveria cards em .viva-card-frame no
  // meio da desmontagem da grade pelo React da Meta. Só é liberada no "finally" abaixo, depois
  // que a aba "Anúncios" termina de remontar.
  _vivaSobreTabDiscoveryInProgress = true;
  // Watchdog de resiliência (mesmo padrão de batchingWatchdogTimeout usado em processCards()):
  // o clique de volta para "Anúncios" e a liberação da trava vivem dentro de setTimeouts fora
  // do try/catch principal desta função — se algo inesperado impedir esses timeouts de rodar
  // (ex.: backBtn.click() lançando por um layout inesperado da Meta), a trava ficaria presa em
  // true para sempre, travando processCards() (e a extensão inteira) de forma permanente e
  // silenciosa. Este watchdog garante que, no pior caso, a trava é liberada em até 6s.
  clearTimeout(_vivaSobreTabWatchdogTimeout);
  _vivaSobreTabWatchdogTimeout = setTimeout(() => {
    if (_vivaSobreTabDiscoveryInProgress) {
      console.warn("[VIVA] Watchdog: destravando processCards() após timeout da automação da aba 'Sobre'.");
      _vivaSobreTabDiscoveryInProgress = false;
      lastFullScanTime = 0;
      if (vivaMonitorMasterEnabled) processCards();
    }
  }, 6000);

  // FIX CAUSA RAIZ (2026-09): desembrulha os cards de .viva-card-frame ANTES de deixar o React
  // da Meta desmontar a grade (o clique abaixo) — ver nota de arquitetura junto de
  // resetCardFramesAndState() e da declaração de _vivaSobreTabAttempts, mais acima. Sem isso, a
  // desmontagem da grade falha com "removeChild... not a child of this node" dentro do próprio
  // React da Meta, corrompendo a transição para a aba "Sobre" e fazendo a extração do Instagram
  // falhar silenciosamente mesmo quando a página tem o link vinculado.
  resetCardFramesAndState();

  try {
    sobreBtn.click();
    // Aguarda reativamente o GraphQL da Meta ou o DOM renderizar os dados da aba "Sobre".
    // Checa a cada 50ms — com o interceptor de rede no MAIN world, o dado chega em ~100-200ms.
    // Assim que detectado, encerra a espera imediatamente para voltar à aba "Anúncios" sem delay.
    let igUrl = "";
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      igUrl = getInstagramUrlFromHeader();
      if (igUrl) break;
    }

    if (igUrl) {
      console.log(`[VIVA] Auto-descoberta de Instagram: link encontrado após abrir a aba 'Sobre': ${igUrl}`);
    } else {
      console.warn(`[VIVA] Auto-descoberta de Instagram: aba 'Sobre' foi aberta para pageId=${pageId}, mas nenhum link de Instagram foi encontrado no DOM após a espera (a página pode genuinamente não ter Instagram vinculado).`);
    }
    if (igUrl) {
      const igInput = document.getElementById("viva-side-instagram");
      const igHelper = document.getElementById("viva-ig-helper");
      if (igInput) {
        igInput.value = igUrl;
        igInput.title = igUrl;
        igInput.style.cursor = "pointer";
        igInput.style.opacity = "1";
        // Liga o clique-para-copiar diretamente aqui (a versão detectada pelo polling normal
        // da sidebar cuida disso no caminho dela; este caminho alternativo precisa do próprio,
        // guardado por dataset para nunca duplicar o listener em re-execuções).
        if (!igInput.dataset.vivaClickBound) {
          igInput.dataset.vivaClickBound = "true";
          igInput.addEventListener("click", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(igInput.value).then(() => {
              igInput.classList.add("viva-url-input-copied");
              if (igHelper) igHelper.textContent = "✓ Copiado!";
              setTimeout(() => {
                igInput.classList.remove("viva-url-input-copied");
                if (igHelper) igHelper.textContent = "✓ Detectado automaticamente via aba 'Sobre'";
              }, 1200);
            });
            window.open(igInput.value, "_blank");
          });
        }
      }
      if (igHelper) {
        igHelper.textContent = "✓ Detectado automaticamente via aba 'Sobre'";
        igHelper.style.display = "block";
      }
      await autoAttachInstagramIfMonitored(igUrl);
    }
  } catch (e) {
    console.warn("[VIVA] Falha ao auto-descobrir Instagram via aba 'Sobre':", e.message);
  } finally {
    // Devolve a tela para a aba "Anúncios", de onde o operador provavelmente partiu. Busca o
    // botão de novo (não reaproveita uma referência antiga) porque o React pode ter recriado
    // os nós da barra de abas ao trocar para "Sobre".
    setTimeout(() => {
      const backBtn = findMetaTabButton(["Anúncios", "Ads"]);
      if (backBtn) {
        backBtn.click();
      } else {
        console.warn("[VIVA] Auto-descoberta de Instagram: não foi possível localizar a aba 'Anúncios' para voltar — a tela pode ter ficado presa na aba 'Sobre'.");
      }
      // FIX CAUSA RAIZ (2026-09): os cards foram desembrulhados de .viva-card-frame por
      // resetCardFramesAndState() antes do round-trip pela aba "Sobre" — sem reprocessar agora,
      // eles voltariam "nus" (sem faixa de escala, badges ou rodapé) até o próximo scroll ou
      // mutação disparar processCards() naturalmente. 300ms dá tempo do clique de volta para
      // "Anúncios" terminar de remontar a grade antes de tentar re-envolver os cards.
      setTimeout(() => {
        // FIX CAUSA RAIZ (2026-09): libera a trava só agora — depois que a aba "Anúncios" já
        // teve tempo de remontar a grade — e força o próximo processCards() explicitamente, em
        // vez de esperar o próximo scroll/mutação natural. Enquanto a trava esteve ativa,
        // qualquer mutação concorrente que teria chamado processCards() saiu cedo (ver early-
        // return no topo da função), então este é o primeiro ciclo real desde o início da
        // automação — garante que os cards nunca fiquem "nus" por mais tempo que o necessário.
        clearTimeout(_vivaSobreTabWatchdogTimeout); // fluxo normal concluiu — watchdog não é mais necessário
        _vivaSobreTabDiscoveryInProgress = false;
        lastFullScanTime = 0; // força varredura completa: a grade inteira acabou de ser remontada
        if (vivaMonitorMasterEnabled) processCards();
      }, 300);
    }, 350);
  }
}

function tryTriggerAutoDiscoverInstagram() {
  if (cachedIgUrl || (document.documentElement.dataset && document.documentElement.dataset.vivaDetectedInstagram)) return;
  if (!isSingleAdvertiserLibraryView()) return;
  const pid = getCurrentPageIdentityKey();
  if (pid) {
    autoDiscoverInstagramViaSobreTab(pid);
  }
}



// ─── VIVA Top Bar: filtros e busca inteligente na região do cabeçalho Meta ───────────────────
function injectTopBar() {
  const metaHeader = document.querySelector("header")
    || document.querySelector('div[role="banner"]')
    || document.querySelector("nav");
  const metaNavLinks = document.querySelectorAll(
    'a[href*="ads/library/report"], a[href*="api"], a[href*="brand"]',
  );
  metaNavLinks.forEach(el => {
    const container = el.closest("div")?.parentElement;
    if (container && !container.closest("#viva-top-bar")) container.style.display = "none";
  });
  if (metaHeader && metaHeader.id === "viva-top-bar") return;
  if (document.getElementById("viva-top-bar")) return;

  const topBar = document.createElement("div");
  topBar.id = "viva-top-bar";
  topBar.className = "viva-top-bar viva-el";
  topBar.innerHTML = `
    <div class="viva-top-left">
      <span class="viva-top-logo">VIVA Labs</span>
      <span class="viva-top-version" id="viva-top-connection">✓ Conectado</span>
    </div>
    <div class="viva-top-center">
      <div class="viva-top-filter-group">
        <label for="viva-top-min-ads">MÍN. ADS ATIVOS</label>
        <input id="viva-top-min-ads" type="number" min="0" aria-label="Mínimo de anúncios ativos">
      </div>
      <div class="viva-top-filter-group">
        <label for="viva-top-min-dup">MÍN. DUPLICADOS</label>
        <input id="viva-top-min-dup" type="number" min="0" aria-label="Mínimo de anúncios duplicados">
      </div>
      <button class="viva-btn viva-btn-primary viva-top-apply" id="viva-top-apply" type="button">Aplicar</button>
      <label class="viva-top-toggle">
        <span>Recentes ≤ 3 dias</span>
        <span class="viva-switch viva-switch-sm">
          <input id="viva-top-recentes" type="checkbox" aria-label="Filtrar anúncios recentes">
          <span class="viva-slider"></span>
        </span>
      </label>
      <label class="viva-top-toggle">
        <span>Auto-Scroll</span>
        <span class="viva-switch viva-switch-sm">
          <input id="viva-top-autoscroll" type="checkbox" aria-label="Ativar auto-scroll">
          <span class="viva-slider"></span>
        </span>
      </label>
      <button id="viva-btn-busca-inteligente" class="viva-btn-busca-inteligente" type="button" aria-expanded="false" aria-controls="viva-busca-dropdown">⚡ Busca Inteligente</button>
    </div>
    <span class="viva-top-spacer"></span>
  `;
  document.body.prepend(topBar);

  const dropdown = document.createElement("div");
  dropdown.id = "viva-busca-dropdown";
  dropdown.className = "viva-busca-dropdown viva-busca-popup viva-el";
  dropdown.hidden = true;
  dropdown.innerHTML = `
    <div class="viva-busca-header">
      <span>⚡ Busca Inteligente em Massa</span>
      <button id="viva-busca-fechar" class="viva-busca-close" type="button" aria-label="Fechar">✕</button>
    </div>
    <textarea id="viva-mass-keywords" maxlength="5000" placeholder='Uma linha: busca normal, sem abrir abas.&#10;Duas ou mais: Turbo após confirmação.&#10;Ex.: emagrecimento "truque"&#10;ansiedade controle' aria-label="Termos para busca, um por linha"></textarea>
    <div id="viva-busca-info" class="viva-busca-info" aria-live="polite"></div>
    <div id="viva-turbo-controls" class="viva-turbo-controls" hidden>
      <label class="viva-timer-row" for="viva-timer-slider">
        Tempo por busca: <strong id="viva-timer-val">60s</strong>
        <input type="range" id="viva-timer-slider" min="20" max="180" value="60" step="10">
        <small id="viva-timer-hint">Coleta completa + ranking (até 2 abas)</small>
      </label>
      <div id="viva-progress-wrap" class="viva-progress-wrap" hidden>
        <div class="viva-progress-bar"><div id="viva-progress-fill"></div></div>
        <div id="viva-progress-text">0/0 · Aguardando</div>
      </div>
      <div class="viva-turbo-actions">
        <button id="viva-btn-pausar" type="button" hidden>⏸ Pausar</button>
        <button id="viva-btn-cancelar" type="button" hidden>■ Cancelar</button>
      </div>
    </div>
    <div class="viva-busca-footer">
      <button id="viva-btn-minerar" class="viva-btn-minerar" type="button" disabled>Digite uma palavra-chave</button>
    </div>
    <div id="viva-progresso-inteligente" class="viva-progresso" role="status" aria-live="polite"></div>
  `;
  dropdown.setAttribute("role", "dialog");
  dropdown.setAttribute("aria-modal", "true");
  dropdown.setAttribute("aria-label", "Busca Inteligente");
  document.body.appendChild(dropdown);
  console.info("[VIVA] Busca Inteligente v2: modo normal x turbo com consentimento");

  const searchButton = topBar.querySelector("#viva-btn-busca-inteligente");
  const input = dropdown.querySelector("#viva-mass-keywords");
  const primaryButton = dropdown.querySelector("#viva-btn-minerar");
  const info = dropdown.querySelector("#viva-busca-info");
  const progress = dropdown.querySelector("#viva-progresso-inteligente");
  const turboControls = dropdown.querySelector("#viva-turbo-controls");
  const progressWrap = dropdown.querySelector("#viva-progress-wrap");
  const timerSlider = dropdown.querySelector("#viva-timer-slider");
  const timerValue = dropdown.querySelector("#viva-timer-val");
  const timerHint = dropdown.querySelector("#viva-timer-hint");
  const pauseButton = dropdown.querySelector("#viva-btn-pausar");
  const cancelButton = dropdown.querySelector("#viva-btn-cancelar");
  let buscaState = {
    modo: "vazio",
    isPaused: false,
    isRunning: false,
    isStarting: false,
    cancelWhenStarted: false,
    runId: null,
  };
  const getSidebar = () => document.querySelector("#viva-sidebar, .viva-sidebar, #viva-side-panel, .viva-monitor-panel");

  const closeBuscaInteligente = (cancelRun = false) => {
    if (cancelRun && (buscaState.isRunning || buscaState.isStarting)) {
      buscaState.cancelWhenStarted = buscaState.isStarting;
      if (buscaState.isRunning) {
        chrome.runtime.sendMessage({ action: "CANCELAR_MINERACAO_INTELIGENTE", runId: buscaState.runId })
          .catch(error => console.error("[VIVA] Não foi possível cancelar ao fechar a Busca Inteligente:", error));
      }
      buscaState.isRunning = false;
    }
    dropdown.hidden = true;
    searchButton.setAttribute("aria-expanded", "false");
    const sidebar = getSidebar();
    if (sidebar) sidebar.classList.remove("viva-busca-sidebar-hidden");
  };

  const setRunState = (running, paused = false) => {
    buscaState.isRunning = running;
    buscaState.isPaused = paused;
    input.disabled = running;
    timerSlider.disabled = running;
    progressWrap.hidden = !running;
    turboControls.hidden = buscaState.modo !== "turbo" && !running;
    pauseButton.hidden = !running;
    cancelButton.hidden = !running;
    primaryButton.disabled = running || buscaState.modo === "vazio";
    primaryButton.textContent = running
      ? (paused ? "⏸ Turbo pausado" : "🚀 Turbo em andamento")
      : buscaState.modo === "normal"
        ? `🔍 Buscar Normal: "${buscaState.termoBusca}" (sem abas)`
        : buscaState.modo === "turbo"
          ? `🚀 Iniciar Turbo (${buscaState.linhasReais} buscas)`
          : "Digite uma palavra-chave";
    pauseButton.textContent = paused ? "▶ Retomar" : "⏸ Pausar";
  };

  const updateInputMode = () => {
    const parsed = parseBuscaInput(input.value);
    buscaState = { ...buscaState, ...parsed };
    progress.textContent = "";
    progress.classList.remove("is-error");
    if (parsed.modo === "vazio") {
      info.textContent = "";
      turboControls.hidden = true;
      primaryButton.disabled = true;
      primaryButton.textContent = "Digite uma palavra-chave";
      primaryButton.className = "viva-btn-minerar";
    } else if (parsed.modo === "normal") {
      info.textContent = "Modo Normal: busca na biblioteca atual. Não abre abas nem inicia mineração.";
      turboControls.hidden = true;
      primaryButton.disabled = false;
      primaryButton.textContent = `🔍 Buscar Normal: "${parsed.termoBusca}" (sem abas)`;
      primaryButton.className = "viva-btn-minerar viva-btn-normal";
    } else {
      const seconds = Number(timerSlider.value) || 60;
      info.textContent = `Modo Turbo: ${parsed.linhasReais} linhas, até 2 abas em segundo plano, estimativa ~${Math.ceil(parsed.linhasReais * seconds / 60)} min. Requer confirmação antes de abrir abas.`;
      turboControls.hidden = false;
      primaryButton.disabled = false;
      primaryButton.textContent = `🚀 Iniciar Turbo (${parsed.linhasReais} buscas)`;
      primaryButton.className = "viva-btn-minerar viva-btn-turbo";
    }
  };

  input.addEventListener("input", updateInputMode);
  timerSlider.addEventListener("input", () => {
    const seconds = Number(timerSlider.value);
    timerValue.textContent = `${seconds}s`;
    if (seconds < 30) {
      timerHint.textContent = "Modo rápido: coleta leve, sem score completo.";
      timerHint.dataset.mode = "fast";
    } else {
      timerHint.textContent = "Coleta completa + ranking (até 2 abas).";
      timerHint.dataset.mode = "complete";
    }
    if (buscaState.modo === "turbo") updateInputMode();
  });

  const startNormalSearch = async parsed => {
    const nativeSearchSelectors = [
      'input[placeholder*="Pesquisar"]',
      'input[placeholder*="Search"]',
      'input[aria-label*="Pesquisar"]',
      'input[aria-label*="Search"]',
      'input[type="search"]',
    ];
    const searchInput = nativeSearchSelectors
      .map(selector => document.querySelector(selector))
      .find(element => element && !element.closest("#viva-sidebar, #viva-top-bar, #viva-busca-dropdown"));
    if (!searchInput) {
      progress.textContent = "Campo de busca da Biblioteca não encontrado. Abra a busca nativa e tente novamente.";
      progress.classList.add("is-error");
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(searchInput, parsed.termoBusca);
    else searchInput.value = parsed.termoBusca;
    searchInput.focus();
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    try {
      await chrome.storage.local.set({
        viva_ultima_busca_normal: { termo: parsed.termoBusca, timestamp: Date.now() },
      });
    } catch (error) {
      console.error("[VIVA] Não foi possível salvar a última busca normal:", error);
    }
    closeBuscaInteligente();
    showAppleToast("Busca normal iniciada", `"${parsed.termoBusca}" · sem abrir abas`, "success");
  };

  primaryButton.addEventListener("click", async () => {
    const parsed = parseBuscaInput(input.value);
    if (parsed.modo === "vazio") return;
    if (parsed.modo === "normal") {
      await startNormalSearch(parsed);
      return;
    }

    const seconds = Number(timerSlider.value) || 60;
    const estimate = Math.ceil(parsed.linhasReais * seconds / 60);
    const approved = window.confirm(
      `Modo Turbo abrirá até 2 abas em segundo plano para analisar ${parsed.linhasReais} linhas. Tempo estimado: ~${estimate} min. As abas serão fechadas automaticamente. Deseja continuar?`,
    );
    if (!approved) return;

    primaryButton.disabled = true;
    buscaState.isStarting = true;
    buscaState.cancelWhenStarted = false;
    progress.classList.remove("is-error");
    progress.textContent = "Preparando a fila autorizada…";
    try {
      const response = await chrome.runtime.sendMessage({
        action: "INICIAR_MINERACAO_INTELIGENTE",
        consentGranted: true,
        linhas: parsed.termosOriginais,
        options: {
          tempoPorBusca: seconds,
          modoRapido: seconds < 30,
        },
      });
      if (!response || response.status !== "fila_iniciada") {
        throw new Error(response?.error || "Não foi possível iniciar o Turbo.");
      }
      buscaState.runId = response.runId;
      buscaState.isStarting = false;
      if (buscaState.cancelWhenStarted) {
        await chrome.runtime.sendMessage({
          action: "CANCELAR_MINERACAO_INTELIGENTE",
          runId: response.runId,
        });
        buscaState.cancelWhenStarted = false;
        setRunState(false);
        progress.textContent = "Mineração cancelada · abas encerradas";
        return;
      }
      setRunState(true);
      progress.textContent = `Autorizado · 0/${response.total} buscas · até 2 abas`;
      latestIntelligentRanking = [];
    } catch (error) {
      buscaState.isStarting = false;
      progress.textContent = error.message;
      progress.classList.add("is-error");
      setRunState(false);
    }
  });

  pauseButton.addEventListener("click", async () => {
    if (!buscaState.isRunning) return;
    const action = buscaState.isPaused ? "RETOMAR_MINERACAO_INTELIGENTE" : "PAUSAR_MINERACAO_INTELIGENTE";
    try {
      const response = await chrome.runtime.sendMessage({ action, runId: buscaState.runId });
      if (response?.error) throw new Error(response.error);
      setRunState(true, !buscaState.isPaused);
    } catch (error) {
      progress.textContent = `Não foi possível alterar a mineração: ${error.message}`;
      progress.classList.add("is-error");
    }
  });

  cancelButton.addEventListener("click", async () => {
    cancelButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        action: "CANCELAR_MINERACAO_INTELIGENTE",
        runId: buscaState.runId,
      });
      if (response?.error) throw new Error(response.error);
      setRunState(false);
      progress.textContent = "Mineração cancelada · abas encerradas";
    } catch (error) {
      progress.textContent = `Não foi possível cancelar: ${error.message}`;
      progress.classList.add("is-error");
    } finally {
      cancelButton.disabled = false;
    }
  });

  dropdown.querySelector("#viva-busca-fechar").addEventListener("click", () => closeBuscaInteligente(true));
  searchButton.addEventListener("click", async () => {
    const shouldOpen = dropdown.hidden;
    dropdown.hidden = !shouldOpen;
    searchButton.setAttribute("aria-expanded", String(shouldOpen));
    const sidebar = getSidebar();
    if (sidebar) sidebar.classList.toggle("viva-busca-sidebar-hidden", shouldOpen);
    if (shouldOpen) {
      input.focus();
      try {
        const current = await chrome.runtime.sendMessage({ action: "GET_INTELIGENTE_STATE" });
        if (!dropdown.hidden && current?.status === "running") {
          buscaState.runId = current.runId;
          buscaState.modo = "turbo";
          buscaState.linhasReais = current.total;
          setRunState(true, current.paused);
          progress.textContent = current.paused
            ? `Mineração pausada · ${current.index}/${current.total}`
            : `Mineração em andamento · ${current.index}/${current.total}`;
          progressWrap.hidden = false;
          dropdown.querySelector("#viva-progress-text").textContent = progress.textContent;
        }
      } catch (error) {
        console.warn("[VIVA] Não foi possível recuperar o estado do Turbo:", error.message);
      }
    }
  });
  dropdown.addEventListener("click", event => event.stopPropagation());
  _vivaBuscaOutsideClickHandler = event => {
    if (dropdown.hidden || dropdown.contains(event.target) || searchButton.contains(event.target)) return;
    closeBuscaInteligente(false);
  };
  _vivaBuscaEscapeHandler = event => {
    if (event.key === "Escape" && !dropdown.hidden) {
      closeBuscaInteligente(true);
      searchButton.focus();
    }
  };
  document.addEventListener("click", _vivaBuscaOutsideClickHandler);
  document.addEventListener("keydown", _vivaBuscaEscapeHandler);

  if (!_vivaIntelligentMessageListener) {
    _vivaIntelligentMessageListener = message => {
      if (message.action === "PROGRESSO_INTELIGENTE") {
        progress.textContent = message.texto || "";
        progress.classList.toggle("is-error", String(message.texto || "").startsWith("Falha:"));
        const match = String(message.texto || "").match(/(\d+)\/(\d+)/);
        if (match) {
          const percent = Math.min(100, Number(match[1]) / Math.max(1, Number(match[2])) * 100);
          dropdown.querySelector("#viva-progress-fill").style.width = `${percent}%`;
          dropdown.querySelector("#viva-progress-text").textContent = message.texto;
        }
        if (message.status === "paused") setRunState(true, true);
        else if (message.status === "running") setRunState(true, false);
        else if (message.status === "cancelled" || message.status === "completed" || message.status === "failed") {
          setRunState(false);
        }
      } else if (message.action === "RANKING_FINAL") {
        latestIntelligentRanking = Array.isArray(message.ranking) ? message.ranking : [];
        progress.textContent = `Mineração finalizada · ${latestIntelligentRanking.length} páginas encontradas`;
        progress.classList.remove("is-error");
        setRunState(false);
      }
    };
    chrome.runtime.onMessage.addListener(_vivaIntelligentMessageListener);
  }

  updateInputMode();

  setupTopBarInteractions();
}

function setupTopBarInteractions() {
  const minPageInput = document.getElementById("viva-top-min-ads");
  const minDupInput = document.getElementById("viva-top-min-dup");
  const applyBtn = document.getElementById("viva-top-apply");
  const recentesToggle = document.getElementById("viva-top-recentes");
  const scrollToggle = document.getElementById("viva-top-autoscroll");

  if (minPageInput) minPageInput.value = minPageAds > 0 ? minPageAds : "";
  if (minDupInput) minDupInput.value = minDupAds > 0 ? minDupAds : "";
  if (recentesToggle) recentesToggle.checked = filterOnlyRecent;
  if (scrollToggle) scrollToggle.checked = isAutoScrollRunning;

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      minPageAds = parseInt(minPageInput.value, 10) || 0;
      minDupAds = parseInt(minDupInput.value, 10) || 0;
      isAutoScrollRunning = false;
      if (scrollToggle) scrollToggle.checked = false;
      stopAutoScroll();
      processCards();
      applyBtn.textContent = "Aplicado ✓";
      applyBtn.classList.add("is-applied");
      setTimeout(() => {
        applyBtn.textContent = "Aplicar";
        applyBtn.classList.remove("is-applied");
      }, 1500);
    });
  }

  if (recentesToggle) {
    recentesToggle.addEventListener("change", event => {
      filterOnlyRecent = event.target.checked;
      processCards();
    });
  }
  if (scrollToggle) {
    scrollToggle.addEventListener("change", event => {
      isAutoScrollRunning = event.target.checked;
      if (isAutoScrollRunning) startAutoScroll();
      else {
        stopAutoScroll();
        processCards();
      }
    });
  }
}

// ─── VIVA Dock: ações e status fixos no rodapé ───────────────────────────────────────────────
function injectDock() {
  if (document.getElementById("viva-dock")) return;

  const dock = document.createElement("div");
  dock.id = "viva-dock";
  dock.className = "viva-dock viva-el";

  dock.innerHTML = `
    <div class="viva-dock-left"></div>
    <div class="viva-dock-center">
      <button id="viva-btn-show-ranking" class="viva-btn viva-btn-red-pro viva-dock-ranking ver-top-btn" type="button" title="Abre o ranking das bibliotecas mais escaladas">⚡ VER TOP ANUNCIANTES</button>
    </div>
    <div class="viva-dock-right">
      <div class="viva-dock-engine">
        <span class="viva-dock-engine-label">MOTOR VIVA</span>
        <span id="viva-motor-status" class="viva-motor-status viva-motor-viva">⚡ O(1) · ${lastCycleDurationMs || 0}ms (${activeCardData.length} ads)</span>
      </div>
    </div>
  `;

  document.body.appendChild(dock);
  const rankingBtn = dock.querySelector("#viva-btn-show-ranking");
  if (rankingBtn) {
    rankingBtn.addEventListener("click", () => {
      if (latestIntelligentRanking.length > 0) {
        showRankingOverlay(latestIntelligentRanking);
      } else {
        showAppleToast("Nenhum ranking ainda", "Use a Busca Inteligente Turbo para gerar o Top", "error");
      }
    });
  }
  if (!_vivaRankingFeatureLogShown) {
    _vivaRankingFeatureLogShown = true;
    console.log("[VIVA] Dock fixo: VER TOP ANUNCIANTES centralizado + MOTOR VIVA à direita");
  }
  chrome.storage.local.get("viva_ultimo_ranking")
    .then(data => {
      latestIntelligentRanking = Array.isArray(data.viva_ultimo_ranking) ? data.viva_ultimo_ranking : [];
    })
    .catch(error => console.error("[VIVA] Não foi possível recuperar o último ranking salvo:", error));
}

function injectScrollTopBtn() {
  if (document.getElementById("viva-scroll-btn")) return;

  const btn = document.createElement("button");
  btn.id = "viva-scroll-btn";
  btn.className = "viva-scroll-top-btn viva-el";
  btn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
      <polyline points="18 15 12 9 6 15"></polyline>
    </svg>
  `;

  btn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  document.body.appendChild(btn);

  // FIX: registra o listener de scroll UMA ÚNICA VEZ (guardado em variável de módulo).
  // Antes, cada re-injeção do botão (a cada navegação SPA na Meta) adicionava um novo
  // listener anônimo que nunca era removido, acumulando handlers de scroll para sempre.
  if (!_vivaScrollTopHandler) {
    _vivaScrollTopHandler = () => {
      const currentBtn = document.getElementById("viva-scroll-btn");
      if (!currentBtn) return;
      if (window.scrollY > 400) {
        currentBtn.classList.add("viva-visible");
      } else {
        currentBtn.classList.remove("viva-visible");
      }
    };
    window.addEventListener("scroll", _vivaScrollTopHandler, { passive: true });
  }
}

// Helper: Debounce para evitar sobrecarga de funções de renderização síncronas
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// ─── Inicialização ──────────────────────────────────────────────────────────

// FIX 4.2: fullTeardown distingue os dois usos desta função:
//   - fullTeardown=false (padrão) → "reset leve", usado na navegação SPA dentro da Ad Library
//     (troca de URL). Só limpa DOM/cache; o MutationObserver principal, o polling de URL e o
//     scroll handler PRECISAM continuar vivos, senão a extensão para de detectar a própria
//     navegação seguinte e morre depois da primeira troca de página.
//   - fullTeardown=true → desligamento real via toggle do popup. Aí sim desconecta de fato o
//     observer, limpa o polling de URL e remove o scroll handler (ver ensureVivaBackgroundServicesRunning
//     para a reconexão quando o toggle é ligado de novo).
function teardownVivaMonitor(fullTeardown = false) {
  closeRankingOverlay(false);
  // FIX: para de vez o intervalo de polling de nome/Instagram. Antes esta função só
  // removia elementos do DOM, mas nunca parava o setInterval — por isso o toggle
  // "desligar" no popup não interrompia o processamento em segundo plano.
  if (_vivaSidebarIntervalId) {
    clearInterval(_vivaSidebarIntervalId);
    _vivaSidebarIntervalId = null;
  }
  if (fullTeardown) {
    // Antes essas 3 variáveis (_vivaMainObserver, _vivaUrlIntervalId, _vivaScrollHandler) eram
    // declaradas na seção de lifecycle mas nunca recebiam valor — o observer, o polling de URL
    // e o listener de scroll continuavam vivos e consumindo ciclo mesmo com o toggle "desligado"
    // no popup (o vivaMonitorMasterEnabled só fazia o callback virar no-op, sem cortar o
    // trabalho na raiz).
    if (_vivaMainObserver) {
      try { _vivaMainObserver.disconnect(); } catch (e) {}
    }
    if (_vivaAdModalObserver) {
      try { _vivaAdModalObserver.disconnect(); } catch (e) {}
      _vivaAdModalObserver = null;
    }
    _vivaAdDialogSearchObservers.forEach(observer => {
      try { observer.disconnect(); } catch (e) {}
    });
    _vivaAdDialogSearchObservers.clear();
    if (_vivaUrlIntervalId) {
      clearInterval(_vivaUrlIntervalId);
      _vivaUrlIntervalId = null;
    }
    if (_vivaScrollHandler) {
      window.removeEventListener("scroll", _vivaScrollHandler);
    }
    // AUDITORIA #08: o listener do detector de velocidade de scroll (Fast-Scroll Bypass) agora
    // é nomeado e guardado em _vivaFastScrollHandler (ver declaração no topo do arquivo) —
    // removido aqui junto com os demais listeners de scroll no desligamento real via toggle.
    // Antes era estruturalmente impossível removê-lo (função anônima sem referência salva).
    if (_vivaFastScrollHandler) {
      window.removeEventListener("scroll", _vivaFastScrollHandler);
    }
  }
  const panel = document.getElementById("viva-sidebar");
  if (panel) panel.remove();
  const topBar = document.getElementById("viva-top-bar");
  if (topBar) topBar.remove();
  const intelligentSearch = document.getElementById("viva-busca-dropdown");
  if (intelligentSearch) intelligentSearch.remove();
  document.querySelectorAll(".viva-busca-sidebar-hidden").forEach(sidebar => {
    sidebar.classList.remove("viva-busca-sidebar-hidden");
  });
  if (_vivaBuscaOutsideClickHandler) {
    document.removeEventListener("click", _vivaBuscaOutsideClickHandler);
    _vivaBuscaOutsideClickHandler = null;
  }
  if (_vivaBuscaEscapeHandler) {
    document.removeEventListener("keydown", _vivaBuscaEscapeHandler);
    _vivaBuscaEscapeHandler = null;
  }
  // AUDITORIA #03: o overlay do modal do funil é criado em openFunnelModal() com
  // id="viva-funnel-modal-container" (ver função acima) — "viva-funnel-modal-overlay" nunca foi
  // atribuído a nenhum elemento em todo o arquivo (provavelmente um rename de "-overlay" para
  // "-container" que não se propagou para cá). Corrigido para o ID real, garantindo remoção
  // explícita e não dependente de uma rede de segurança incidental.
  const modal = document.getElementById("viva-funnel-modal-container");
  if (modal) modal.remove();
  const confirmModal = document.getElementById("viva-funnel-confirm-overlay");
  if (confirmModal) confirmModal.remove();
  const topBtn = document.getElementById("viva-scroll-btn");
  if (topBtn) topBtn.remove();
  const dock = document.getElementById("viva-dock");
  if (dock) dock.remove();

  // FIX FRAME (CRÍTICO): o .viva-card-frame TAMBÉM tem a classe .viva-el e seria removido pela
  // varredura genérica abaixo — mas o card NATIVO (nó real do React da Meta) está DENTRO dele.
  // Remover o frame sem tirar o card de dentro primeiro arrancaria o card do DOM junto,
  // quebrando a página da Meta. Por isso, desembrulha (devolve o card ao pai original) antes.
  document.querySelectorAll(".viva-card-frame").forEach(frame => {
    let cardToRestore = null;
    for (const child of frame.children) {
      if (!child.classList.contains("viva-el")) {
        cardToRestore = child;
        break;
      }
    }
    if (cardToRestore && frame.parentElement) {
      frame.parentElement.insertBefore(cardToRestore, frame);
    }
    frame.remove();
  });

  // Remove injected footers, strips, dropdowns and badges from all cards
  document.querySelectorAll(".viva-card-footer, .viva-scale-badge, .viva-el, .viva-escala-strip, .viva-card-badge-container, .viva-gear-dropdown").forEach(el => el.remove());
  // AUDITORIA #09: antes, este loop só desconectava mediaPruningObserver de cada card
  // processado — viewportProximityObserver (o gate de proximidade de viewport usado pra
  // adiar a injeção pesada de badges/rodapé, ver FIX 4.3) nunca era desconectado aqui.
  // Ele só se desregistrava sozinho dentro do próprio callback do IntersectionObserver
  // (quando detecta que o card não está mais isConnected) ou no filtro de descoberta em
  // processCards() — nenhum dos dois roda automaticamente durante um teardown. Resultado:
  // cards que perdiam o carimbo "processado" (classList/atributos removidos logo abaixo)
  // durante um teardown continuavam registrados no observer de proximidade, mesmo que o
  // nó em si permanecesse no DOM da Meta (fullTeardown=false, reset leve de navegação SPA)
  // ou fosse removido depois (fullTeardown=true). Corrigido para desconectar ambos os
  // observers no mesmo loop, no mesmo padrão.
  document.querySelectorAll("[data-viva-processed], [data-viva-id], .viva-processed").forEach(el => {
    el.removeAttribute("data-viva-processed");
    el.removeAttribute("data-viva-id");
    try { mediaPruningObserver.unobserve(el); } catch(e) {}
    try { viewportProximityObserver.unobserve(el); } catch(e) {}
    // FAXINA: as classes de fase (viva-stage-*) vivem no FRAME, não no card — e o frame
    // inteiro já é destruído/desembrulhado antes deste ponto (ver bloco FIX FRAME acima), então
    // não há nada de fase pra limpar aqui, só o carimbo de processado do card em si.
    el.classList.remove("viva-processed");
    el.classList.remove("viva-baixo-volume");
    el._vivaBaixoVolume = false;
  });
  activeCardData = [];
  cardSignatures = {};
}

function injectMediaPreconnects() {
  const cdns = [
    "https://scontent.fcnf.fbcdn.net",
    "https://video.fcnf.fbcdn.net",
    "https://connect.facebook.net"
  ];
  cdns.forEach(domain => {
    if (!document.head.querySelector(`link[href="${domain}"]`)) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = domain;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  });
  if (!document.head.querySelector(`link[rel="dns-prefetch"][href="//fbcdn.net"]`)) {
    const dns = document.createElement("link");
    dns.rel = "dns-prefetch";
    dns.href = "//fbcdn.net";
    document.head.appendChild(dns);
  }
}

async function init() {
  // FIX #12: _vivaInitialized existia apenas como declaração morta — nunca era lida nem
  // setada, então nada impedia init() de rodar mais de uma vez na mesma página (ex: extensão
  // recarregada pelo Chrome com a aba já aberta, ou qualquer injeção duplicada do content
  // script). Rodar init() duas vezes duplicaria o MutationObserver principal, o polling de
  // URL, o scroll handler e os listeners globais de focusin/focusout — cada um passaria a
  // disparar 2x por evento, silenciosamente, sem erro nenhum no console.
  if (_vivaInitialized) {
    console.log("[VIVA] init() ignorado — extensão já inicializada nesta página.");
    return;
  }
  _vivaInitialized = true;

  console.log("[VIVA] Motor otimizado O(1) + 5 cores Apple aplicadas");
  console.log("[VIVA] Extensão carregando... BUILD-CLAUDE-FIX-v7.4 (2026-09) — corrige o link ADS sendo trocado por view_all_page_id= ao abrir com a extensão ativa (marcador viva_pin=1), e injeta o botão 'Ações' também dentro do modal 'Link para o anúncio' da Meta, ancorado ao lado do 'Saiba mais', sem reparentar nenhum nó nativo");
  console.log("[VIVA] Highlight preto baixo volume aplicado");
  await loadLocalApiUrl();
  fetchMonitoredPages();

  chrome.storage.local.get(["viva_monitor_enabled"], (res) => {
    vivaMonitorMasterEnabled = res.viva_monitor_enabled !== false;
    // FIX: propaga o estado do toggle para o mundo MAIN via atributo no <html>.
    // react_sniffer.js roda isolado no mundo MAIN e não tem acesso a chrome.storage —
    // sem essa ponte, ele nunca soube que existe um "desligar" e rodava para sempre.
    document.documentElement.dataset.vivaEnabled = vivaMonitorMasterEnabled ? "true" : "false";
    if (!vivaMonitorMasterEnabled) {
      console.log("[VIVA] Extensão desativada via toggle.");
      teardownVivaMonitor(true);
      return;
    }
    injectMediaPreconnects();
    setupAdModalObserver();
    setTimeout(() => {
      injectTopBar();
      injectSidebar();
      injectScrollTopBtn();
      injectDock();
      processCards();
      setTimeout(tryTriggerAutoDiscoverInstagram, 300);
      setTimeout(tryTriggerAutoDiscoverInstagram, 800);
      setTimeout(tryTriggerAutoDiscoverInstagram, 1500);
      setTimeout(tryTriggerAutoDiscoverInstagram, 2500);
    }, 1500);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.viva_monitor_enabled !== undefined) {
      vivaMonitorMasterEnabled = changes.viva_monitor_enabled.newValue !== false;
      // FIX: mesma ponte, agora também na troca ao vivo do toggle (sem precisar recarregar a página).
      document.documentElement.dataset.vivaEnabled = vivaMonitorMasterEnabled ? "true" : "false";
      if (!vivaMonitorMasterEnabled) {
        teardownVivaMonitor(true);
      } else {
        // FIX 4.2: como o toggle "desligar" agora realmente desconecta o observer principal,
        // limpa o polling de URL e remove o scroll handler (fullTeardown=true acima), religar
        // precisa reconectá-los — antes isso não era necessário porque nada era desconectado.
        ensureVivaBackgroundServicesRunning();
        injectMediaPreconnects();
        setupAdModalObserver();
        injectTopBar();
        injectSidebar();
        injectScrollTopBtn();
        injectDock();
        lastFullScanTime = 0; // religou o toggle — força 1 varredura completa antes de confiar só no observer
        processCards();
      }
    }
  });

  // Executa processamento otimizado síncrono com base em eventos
  // FIX: guarda o handler na variável de lifecycle já existente (_vivaScrollHandler) — antes
  // ela era declarada mas nunca usada, então o teardown não tinha como remover este listener.
  const debouncedProcess = debounce(processCards, 300);
  _vivaScrollHandler = debouncedProcess;
  window.addEventListener("scroll", _vivaScrollHandler);

  // ─── Indexação única dos containers de busca da Meta (O(1) Memory Set) ──────────────────────
  // AUDITORIA #13: esta é a ÚNICA declaração de VIVA_SEARCH_ROOTS no arquivo agora — a antiga
  // declaração de escopo de módulo (que nunca era lida) foi removida do topo do arquivo. Esta
  // variável local vive pelo tempo de vida de init() (nunca recriada, já que init() só roda uma
  // vez por página graças ao guard _vivaInitialized acima) e é a que de fato alimenta
  // indexSearchContainers() e o MutationObserver principal logo abaixo.
  const VIVA_SEARCH_ROOTS = new WeakSet();

  function indexSearchContainers() {
    const searchSelectors = [
      "input[type='text']",
      "input[type='search']",
      "[role='combobox']",
      "[role='listbox']",
      "header",
      "#viva-sidebar"
    ];
    document.querySelectorAll(searchSelectors.join(",")).forEach(el => {
      let node = el;
      for (let i = 0; i < 8 && node; i++) {
        VIVA_SEARCH_ROOTS.add(node);
        node = node.parentElement;
      }
    });
  }
  indexSearchContainers();

  const headerEl = document.querySelector("header");
  if (headerEl) {
    new MutationObserver(() => indexSearchContainers()).observe(headerEl, { childList: true, subtree: false });
  }

  // Observa novos elementos adicionados no DOM para processamento imediato (sem intervalo de pooling desnecessário)
  // Observa novos elementos no DOM ignorando completamente players de vídeo, controles, tooltips e modais em O(1)
  const observer = new MutationObserver((mutations) => {
    if (!vivaMonitorMasterEnabled || rankingOverlayPaused) return;
    // FIX #1: enquanto o usuário digita/interage com GEO, Tipo de Anúncio ou a busca por
    // palavra-chave da própria Meta, pula todo o processamento pesado desta leva de mutações.
    if (isInteractingWithNativeControl) return;
    let hasNewCard = false;
    for (const mutation of mutations) {
      const t = mutation.target;
      if (!t) continue;

      // Verificação O(1) in-memory de WeakSet — sem traversal de árvore C++ em cada keypress!
      if (
        t.nodeName === "INPUT" ||
        t.nodeName === "FORM" ||
        t.nodeName === "VIDEO" ||
        VIVA_SEARCH_ROOTS.has(t)
      ) continue;

      // ─── Zero-Lag Apple Shield: Ignora em 0.00ms qualquer mutação dentro de cartões já processados ───
      if (t.closest && (t.closest(".viva-processed") || t.closest("[data-viva-id]"))) {
        continue;
      }

      if (typeof t.className === "string" && (t.className.includes("video") || t.className.includes("search"))) {
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          if (VIVA_SEARCH_ROOTS.has(node) || (node.closest && (node.closest("header") || node.closest("form") || node.closest("[role='combobox']") || node.closest("[role='listbox']") || node.closest("[role='dialog']") || node.closest("#viva-sidebar") || node.closest(".viva-processed") || node.closest("[data-viva-id]")))) {
            continue;
          }

          // Zero-Lag & Instant Media: Aplica decoding="async" na GPU instantaneamente
          if (node.nodeName === "IMG" && !node.getAttribute("decoding")) {
            node.setAttribute("decoding", "async");
          } else if (node.querySelectorAll) {
            node.querySelectorAll("img").forEach(img => {
              if (!img.getAttribute("decoding")) img.setAttribute("decoding", "async");
            });
          }

          if (node.nodeName === "DIV" || node.nodeName === "SECTION") {
            const txt = node.textContent || "";
            if (txt.includes("Patrocinado") || txt.includes("Sponsored") || /^(Ver detalhes do anúncio|View ad details|Ver resumo|View summary|Ver detalhes|View details)$/i.test(txt.trim()) || node.querySelector("img, video")) {
              if (node.querySelector("button, a, [role='button']")) {
                hasNewCard = true;
                pendingScanRoots.push(node);
                break;
              }
            }
          }
        }
      }
      if (hasNewCard) break;
    }
    if (hasNewCard) {
      debouncedProcess();
    }
  });
  // FIX: guarda a referência na variável de lifecycle já existente (_vivaMainObserver) — antes
  // ela era declarada mas nunca usada, então o toggle "desligar" não conseguia de fato
  // desconectar este observer (só devolvia no-op via vivaMonitorMasterEnabled dentro do
  // callback, mas o observer continuava recebendo e descartando mutações à toa).
  _vivaMainObserver = observer;
  const initialObserverRoot = getObserverRoot();
  _vivaMainObserver.observe(initialObserverRoot, { childList: true, subtree: true });

  if (initialObserverRoot === document.body) {
    // FIX 4.2: se div[role="main"] ainda não existia no momento do init() (carregamento muito
    // cedo), tenta reescopar assim que ela aparecer, em vez de ficar preso observando
    // document.body inteiro pelo resto da sessão.
    let upgradeAttempts = 0;
    const upgradeInterval = setInterval(() => {
      upgradeAttempts++;
      const realRoot = document.querySelector('div[role="main"]');
      if (realRoot) {
        clearInterval(upgradeInterval);
        try { _vivaMainObserver.disconnect(); } catch (e) {}
        _vivaMainObserver.observe(realRoot, { childList: true, subtree: true });
        console.log("[VIVA] Observer reescopado para div[role='main'] (era document.body no boot).");
      } else if (upgradeAttempts > 20) {
        clearInterval(upgradeInterval);
      }
    }, 500);
  }

  // Loop secundário de polling apenas para mudança de URL de navegação interna SPA da Meta
  // FIX: guarda o ID na variável de lifecycle já existente (_vivaUrlIntervalId) — antes ela
  // era declarada mas nunca usada, então este polling nunca era interrompido pelo teardown.
  // A lógica em si mora em checkUrlChangeTick() (função de módulo) para poder ser recriada por
  // ensureVivaBackgroundServicesRunning() quando o toggle é religado após um fullTeardown.
  _vivaUrlIntervalId = setInterval(checkUrlChangeTick, 2000);
}

// FIX 4.2: extraída de dentro de init() para escopo de módulo — precisa ser reutilizável tanto
// na primeira criação do polling (init) quanto na recriação após religar o toggle
// (ensureVivaBackgroundServicesRunning), sem duplicar a lógica em dois lugares.
function checkUrlChangeTick() {
  if (!vivaMonitorMasterEnabled || rankingOverlayPaused) return;
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    console.log("[VIVA] URL mudou, limpando cache local e reiniciando...");
    // FIX 4.2: reset LEVE (fullTeardown padrão false) — navegação SPA dentro da própria Ad
    // Library não pode desconectar o observer/interval/scroll, senão a extensão para de
    // detectar novas trocas de URL depois da primeira e "morre" pelo resto da sessão.
    teardownVivaMonitor();
    lastFullScanTime = 0; // força uma varredura completa de descoberta logo após a navegação SPA

    setTimeout(() => {
      injectTopBar();
      injectSidebar();
      injectScrollTopBtn();
      injectDock();
      const pageTitle = getPageNameFromHeader();
      const nameInput = document.getElementById("viva-side-name");
      if (nameInput) nameInput.value = pageTitle;
      checkMonitoredStatus(pageTitle);

      // Atualiza dinamicamente a exibição do campo do Instagram no painel lateral
      // FIX INSTAGRAM AUTO-DETECT (2026-09): antes este bloco só considerava "página de
      // anunciante" quando a URL tinha view_all_page_id= — escondendo o campo inteiro de
      // Instagram e nunca disparando a descoberta via aba "Sobre" em resultados de busca por
      // palavra-chave resolvidos para um único anunciante (o cenário relatado). Agora usa
      // isSingleAdvertiserLibraryView(), que cobre os dois formatos de URL através da presença
      // real da aba "Sobre"/"About" no cabeçalho.
      const isPage = window.location.href.includes("view_all_page_id=") || isSingleAdvertiserLibraryView();
      const igGroup = document.getElementById("viva-group-instagram");
      const igInput = document.getElementById("viva-side-instagram");
      if (igGroup) {
        if (isPage) {
          igGroup.style.display = "flex";
          if (igInput) {
            const detectedIg = getInstagramUrlFromHeader();
            igInput.value = detectedIg ? detectedIg : "Instagram não detectado";
            if (detectedIg) {
              igInput.style.opacity = "1";
              igInput.style.cursor = "pointer";
              // AUDITORIA #16 (Instagram automático): também tenta o auto-vínculo aqui, no
              // momento da navegação SPA para uma nova página de anunciante — cobre o caso de
              // o operador navegar direto para uma página já monitorada sem esperar o próximo
              // tick do polling da sidebar.
              autoAttachInstagramIfMonitored(detectedIg);
            } else {
              igInput.style.opacity = "0.5";
              igInput.style.cursor = "not-allowed";
              // AUDITORIA (correção 2026-09): não achou o Instagram na aba "Anúncios" (o
              // esperado — a Meta só renderiza esse dado na aba "Sobre") — dispara a
              // descoberta forçada em vez de deixar o campo preso em "não detectado" para
              // sempre, mesma lógica do polling da sidebar. Usa getCurrentPageIdentityKey()
              // em vez do parâmetro de URL cru, para também funcionar em buscas por
              // palavra-chave resolvidas para um único anunciante.
              const pidNav = getCurrentPageIdentityKey();
              if (pidNav) autoDiscoverInstagramViaSobreTab(pidNav);
            }
          }
        } else {
          igGroup.style.display = "none";
        }
      }
      processCards();
    }, 1000);
  }
}

// FIX 4.2: container real da grade de anúncios, usado para escopar o MutationObserver principal
// em vez de observar document.body inteiro. A Meta usa a landmark ARIA div[role="main"] de
// forma estável na Ad Library — escopar a ela corta fora mutações de chat widgets, menus globais
// e outras áreas fora da grade, sem depender de classes ofuscadas que mudam a cada deploy.
function getObserverRoot() {
  return document.querySelector('div[role="main"]') || document.body;
}

// FIX 4.2: reconecta os serviços de fundo (MutationObserver principal, polling de URL e scroll
// handler) depois de um fullTeardown real (toggle desligado no popup). Sem isso, religar a
// extensão deixaria badges parando de aparecer em cards novos, navegação SPA parando de ser
// detectada, e o scroll deixando de reprocessar cards — porque agora o toggle "desligar"
// realmente desconecta essas 3 coisas (ver teardownVivaMonitor).
function ensureVivaBackgroundServicesRunning() {
  if (_vivaMainObserver) {
    try {
      _vivaMainObserver.observe(getObserverRoot(), { childList: true, subtree: true });
    } catch (e) {}
  }
  if (!_vivaUrlIntervalId) {
    _vivaUrlIntervalId = setInterval(checkUrlChangeTick, 2000);
  }
  if (_vivaScrollHandler) {
    // addEventListener com a mesma referência de função é idempotente — nunca duplica o listener.
    window.addEventListener("scroll", _vivaScrollHandler);
  }
  // AUDITORIA #08: reconecta o listener de fast-scroll ao religar a extensão após um
  // fullTeardown real — mesmo padrão idempotente do _vivaScrollHandler acima
  // (addEventListener com a mesma referência de função nunca duplica o listener).
  if (_vivaFastScrollHandler) {
    window.addEventListener("scroll", _vivaFastScrollHandler, { passive: true });
  }
}

init();