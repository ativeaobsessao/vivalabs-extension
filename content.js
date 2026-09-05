// VIVA Labs Helper - Main Content Script (Meta Ad Library)

// Auto-Clean de URL para Ver Anúncios da Página (Remove o Modal do Anúncio e abre direto na página)
function checkAndCleanAdModalUrl() {
  try {
    if (!window.location.search.includes("search_type=page") || !window.location.search.includes("view_all_page_id=")) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("search_type") === "page" && params.has("id") && params.has("view_all_page_id")) {
      params.delete("id");
      const cleanUrl = window.location.pathname + "?" + params.toString();
      window.location.replace(cleanUrl);
    }
  } catch (e) {}
}
checkAndCleanAdModalUrl();
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
let _vivaInitialized = false;      // Guard contra múltiplas inicializações

// ─── VIVA O(1) DOM Index WeakSets (escopo de módulo para acesso no teardown) ─
const VIVA_SEARCH_ROOTS = new WeakSet(); // Containers de busca e sugestões da Meta

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

window.addEventListener("scroll", () => {
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
}, { passive: true });

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
    if (url.includes("l.facebook.com/l.php")) {
      const urlObj = new URL(url);
      const target = urlObj.searchParams.get("u");
      if (target) return decodeURIComponent(target);
    }
  } catch (e) {}
  return url;
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
    const res = await fetch(`${API_URL}/api/paginas`, { signal: controller.signal });
    monitoredPages = await res.json();
    // A resposta pode chegar depois do painel já estar na tela — atualiza o botão
    // "Monitorar no VIVA Labs" / "✓ Monitorado" retroativamente, se o painel já existir.
    if (document.getElementById("viva-sidebar")) {
      const pageTitle = getPageNameFromHeader();
      if (pageTitle) checkMonitoredStatus(pageTitle);
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
  // Busca direta O(1): apenas links explícitos do Instagram. NUNCA varre spans/divs.
  // Varrer todos os spans/divs consome 5.000-20.000 nós DOM por chamada — causa de travamento.
  const igLinks = document.querySelectorAll("a[href*='instagram.com']");
  for (const a of igLinks) {
    if (a.href && !a.href.includes("facebook.com")) {
      return cleanInstagramUrl(a.href);
    }
  }
  // Fallback: handles via atributo aria-label ou title (sem querySelectorAll genérico)
  const igHandle = document.querySelector("[aria-label*='Instagram'], [title*='instagram']");
  if (igHandle) {
    const text = (igHandle.textContent || igHandle.getAttribute("aria-label") || "").trim();
    if (/^@[a-zA-Z0-9_.]+$/.test(text)) {
      return `https://www.instagram.com/${text.substring(1)}`;
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
const REGEX_PID_HTML = /(?:view_all_page_id=|page_id=|[?&]id=|"pageID":\s*"|"pageId":\s*"|"advertiserID":\s*")(\d{10,20})/i;
const REGEX_AD_ARCHIVE_TEXT = /(?:Identifica[cç][aã]o da biblioteca|Library ID|ID)[:\s]+(\d{13,18})/i;
const REGEX_AD_ARCHIVE_LINK = /[?&]id=(\d{13,18})/i;
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

// FIX REGRA DE FASE (2026-08): fase de veiculação determinada SOMENTE pelo tempo ativo do
// anúncio — nunca por duplicação. Duplicação/mesmo criativo virou sinal à parte (ver badge
// "Mesmo Criativo", inalterado), nunca critério de fase, pra nunca existir ambiguidade: um
// anúncio jovem já duplicado antes não cabia em nenhuma faixa quando duas regras concorriam.
// Três faixas mutuamente exclusivas, sem sobreposição e sem buraco — única fonte de verdade,
// reaproveitada em processCards() (badge do card) e em showTopAdvertisersModal() (ranking).
const STAGE_RANK = { teste: 0, potencial: 1, bruta: 2 };
const STAGE_INFO = {
  teste:     { label: "🧪 EM TESTE",         chipClass: "viva-escala-chip-teste" },
  potencial: { label: "📈 POTENCIAL ESCALA", chipClass: "viva-escala-chip-potencial" },
  bruta:     { label: "🔥 ESCALA BRUTA",     chipClass: "viva-escala-chip-bruta" }
};

function resolveStage(adAgeDays) {
  if (adAgeDays === null) return "teste"; // sem data confiável — trata como ainda não comprovado
  if (adAgeDays >= 7) return "bruta";
  if (adAgeDays >= 3) return "potencial";
  return "teste";
}

// ─── Single-Pass DOM Collector (Memoized per card instance) ───
const domElementsCache = new WeakMap();
function getCardDomElements(card) {
  if (domElementsCache.has(card)) return domElementsCache.get(card);
  const links = [];
  const leafNodes = [];
  let video = null;
  let img = null;
  
  const allElements = card.querySelectorAll("a, video, img, div, span, p, h3, h4");
  for (const el of allElements) {
    const nodeName = el.nodeName;
    if (nodeName === "A" && el.href) {
      links.push(el);
    } else if (nodeName === "VIDEO" && !video) {
      video = el;
    } else if (nodeName === "IMG" && !img) {
      img = el;
    } else if (nodeName === "DIV" || nodeName === "SPAN" || nodeName === "P" || nodeName === "H3" || nodeName === "H4") {
      if (el.children.length === 0) {
        leafNodes.push(el);
      }
    }
  }
  const cache = { links, leafNodes, video, img };
  domElementsCache.set(card, cache);
  return cache;
}

// AUDITORIA #02 (crítico — O(n²) -> O(n)): getAdCount(advertiserName) foi removida. Fazia
// activeCardData.filter() completo (O(n)) a cada chamada, e era chamada uma vez por item dentro
// de outro loop O(n) em processCards() — O(n²) por ciclo. A contagem por anunciante agora é
// acumulada em O(n) único, no mesmo passe que já monta cardSignatures/mediaSignatures/
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
  for (const a of links) {
    if (a.href.includes("l.facebook.com/l.php")) {
      try {
        const urlObj = new URL(a.href);
        const targetUrl = urlObj.searchParams.get("u");
        if (targetUrl) {
          const decoded = decodeURIComponent(targetUrl);
          if (!decoded.includes("instagram.com") && !decoded.includes("facebook.com")) return decoded;
        }
      } catch (e) {}
    }
  }
  for (const a of links) {
    const href = a.href;
    if (href.startsWith("http") && !href.includes("facebook.com") && !href.includes("instagram.com")) return href;
  }
  return null;
}

function extractMediaUrl(card) {
  const { video, img } = getCardDomElements(card);
  if (video && video.src && !video.src.startsWith("blob:")) return video.src;
  if (img && img.src && !img.src.startsWith("data:")) {
    if (img.naturalWidth > 100 || img.width > 100 || img.src.includes("fna.fbcdn")) return img.src;
  }
  return null;
}

function parseMetaDate(text) {
  const monthsPt = { jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5, jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11 };
  const monthsEn = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const matchPt = text.match(REGEX_META_DATE_PT);
  if (matchPt) return new Date(parseInt(matchPt[3]), monthsPt[matchPt[2].toLowerCase().replace(".", "").substring(0, 3)] || 0, parseInt(matchPt[1]));
  const matchEn = text.match(REGEX_META_DATE_EN);
  if (matchEn) return new Date(parseInt(matchEn[3]), monthsEn[matchEn[1].toLowerCase().substring(0, 3)] || 0, parseInt(matchEn[2]));
  return null;
}

function extractCardTexts(card) {
  const advertiserName = extractAdvertiserName(card) || "";
  const advLower = advertiserName.toLowerCase();

  const isMetaNoise = (txt) => {
    if (!txt || txt.length < 2) return true;
    const l = txt.toLowerCase();
    return l.includes("identificação da biblioteca") ||
           l.includes("veiculação iniciada") ||
           l.includes("anúncios usam") ||
           l.includes("plataformas") ||
           l.includes("ver resumo") ||
           l.includes("ver detalhes") ||
           l === advLower ||
           l === "patrocinado" ||
           l === "sponsored" ||
           l.includes("dias ativo") ||
           l.includes("escala potencial") ||
           l.includes("campanha normal") ||
           l.includes("funil whatsapp") ||
           l.includes("copiar copies");
  };

  let primaryText = "";
  let title = "";
  let description = "";

  const { leafNodes } = getCardDomElements(card);
  const validLeafNodes = leafNodes.filter(el => {
    if (el.querySelector("img, video, svg, button, input")) return false;
    const txt = el.textContent.trim();
    return !isMetaNoise(txt) && txt.length > 2;
  });

  // 1. ZONA A: TEXTO PRINCIPAL (Primary Text - parágrafos longos)
  const primaryCandidates = validLeafNodes.filter(el => {
    const txt = el.textContent.trim();
    if (REGEX_SIMPLE_DOMAIN.test(txt)) return false;
    return txt.length > 25;
  });

  if (primaryCandidates.length > 0) {
    primaryCandidates.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
    primaryText = primaryCandidates[0].textContent.trim();
  }

  // 2. ZONA B: TÍTULO / HEADLINE (Zero getComputedStyle — Heurística O(1) de tags semânticas, classes e posição)
  const boldElements = validLeafNodes.filter(el => {
    const nodeName = el.nodeName;
    const styleBold = el.style.fontWeight === "bold" || el.style.fontWeight === "700" || parseInt(el.style.fontWeight || "0") >= 600;
    const classBold = typeof el.className === "string" && (el.className.includes("bold") || el.className.includes("font-semibold") || el.className.includes("font-bold"));
    const isSemanticBold = nodeName === "STRONG" || nodeName === "B" || nodeName === "H3" || nodeName === "H4";
    const txt = el.textContent.trim();
    return (isSemanticBold || styleBold || classBold) && txt !== primaryText && txt.length < 120;
  });

  if (boldElements.length > 0) {
    title = boldElements[boldElements.length - 1].textContent.trim();
  } else {
    // Fallback estrutural: se não achou tag/classe bold explícita, pega o último texto curto abaixo de 100 caracteres antes do final do card
    const shortLeafs = validLeafNodes.filter(el => {
      const txt = el.textContent.trim();
      return txt !== primaryText && txt.length < 100 && !REGEX_ONLY_DOMAIN.test(txt);
    });
    if (shortLeafs.length > 0) {
      title = shortLeafs[shortLeafs.length - 1].textContent.trim();
    }
  }

  // 3. ZONA C: DESCRIÇÃO DO LINK (texto secundário curto no rodapé CTA)
  const descCandidates = validLeafNodes.filter(el => {
    const txt = el.textContent.trim();
    return txt !== primaryText &&
           txt !== title &&
           txt.length < 150 &&
           !REGEX_ONLY_DOMAIN.test(txt);
  });

  if (descCandidates.length > 0) {
    description = descCandidates[descCandidates.length - 1].textContent.trim();
  }

  return { primaryText, title, description };
}

function extractPageId(card) {
  const fiberId = card.getAttribute("data-viva-page-id");
  if (fiberId && REGEX_ONLY_DIGITS.test(fiberId)) {
    return fiberId;
  }

  const { links } = getCardDomElements(card);
  for (const a of links) {
    if (a.href.includes("/ads/library/") || a.href.includes("view_all_page_id=") || a.href.includes("page_id=") || a.href.includes("id=")) {
      try {
        const u = new URL(a.href, window.location.origin);
        const pid = u.searchParams.get("view_all_page_id") || u.searchParams.get("page_id") || u.searchParams.get("id");
        if (pid && REGEX_ONLY_DIGITS.test(pid)) return pid;
      } catch (e) {}
    }
  }

  const htmlMatch = card.outerHTML.match(REGEX_PID_HTML);
  if (htmlMatch && htmlMatch[1]) {
    return htmlMatch[1];
  }

  return null;
}

function extractAdArchiveId(card) {
  const textMatch = card.textContent.match(REGEX_AD_ARCHIVE_TEXT);
  if (textMatch && textMatch[1]) return textMatch[1];
  const linkMatch = card.innerHTML.match(REGEX_AD_ARCHIVE_LINK);
  if (linkMatch && linkMatch[1]) return linkMatch[1];
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
  const { primaryText, title, description } = extractCardTexts(card);
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

// AUDITORIA #12 (Fase 2 — correção do grid quebrado sob a arquitetura de frame): a heurística
// antiga ("sobe 1 nível se o pai imediato tem exatamente 1 filho") assumia profundidade fixa e
// quebrava sempre que a Meta muda a estrutura por baixo — cada frame podia acabar configurando
// o PRÓPRIO container como grid, virando "1 item por linha" empilhado verticalmente (exatamente
// o sintoma relatado: cards não ficam lado a lado). findFrameCell() sobe a árvore a partir do
// FRAME e só para quando encontra um nível cujo pai de fato tem MAIS de um frame (ou descendente
// de frame/card) como filho direto — não assume profundidade fixa, então se adapta sozinha se a
// estrutura da Meta mudar de novo no futuro.
function findFrameCell(frame) {
  let cell = frame;
  let depth = 0;
  while (cell.parentElement && depth < 8) {
    const parent = cell.parentElement;
    let frameSiblings = 0;
    for (const child of parent.children) {
      if (child.classList.contains("viva-card-frame") || child.querySelector(".viva-processed")) {
        frameSiblings++;
        if (frameSiblings > 1) break;
      }
    }
    if (frameSiblings > 1) return { cell, parent };
    cell = parent;
    depth++;
  }
  return { cell: frame, parent: cell.parentElement };
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

function processCards() {
  if (!vivaMonitorMasterEnabled) return;
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
  document.querySelectorAll(".viva-card-footer, .viva-escala-strip, .viva-card-badge-container").forEach(el => {
    if (!el.isConnected || (!el.closest(".viva-card-frame") && !el.closest(".viva-processed") && !el.closest("[data-viva-id]"))) {
      el.remove();
    }
  });

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
    return { card, data };
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
    // Fase determinada só pelo tempo — ver comentário FIX REGRA DE FASE junto de resolveStage().
    item.stage = resolveStage(data.adAgeDays);
    
    let shouldShow = true;
    if (minPageAds > 0 && adsCount < minPageAds) shouldShow = false;
    if (minDupAds > 0 && effectiveDupCount < minDupAds) shouldShow = false;
    // FIX ITEM 11: as duas condições de hideRecent/hideNonScaled saíram daqui — variáveis
    // removidas (nunca ligadas por nenhum controle de UI, sempre false na prática).
    if (filterOnlyRecent && (data.adAgeDays === null || data.adAgeDays > 3)) shouldShow = false;
    item.shouldShow = shouldShow;
  });

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
      // Extermina qualquer engrenagem ou rodapé órfão que esteja flutuando fora de cartões reais
      document.querySelectorAll(".viva-card-footer").forEach(f => {
        if (!f.closest(".viva-card-frame") && !f.closest(".viva-processed") && !f.closest("[data-viva-id]")) f.remove();
      });

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
        // FIX FRAME/GRID (AUDITORIA #12 Fase 2): a "célula" da grade é o .viva-card-frame que
        // envolve o card, e o container real que precisa virar grid é encontrado subindo a
        // árvore até achar o nível com MAIS DE UM frame irmão — nunca mais assumindo
        // profundidade fixa (ver findFrameCell()).
        const frame = getOrCreateCardFrame(item.card);
        const { cell, parent } = findFrameCell(frame);

        const reflowState = item.shouldShow ? "show" : "hide";
        if (cell._vivaReflowState !== reflowState) {
          cell._vivaReflowState = reflowState;
          if (item.shouldShow) {
            cell.style.setProperty("display", "block", "important");
            // AUDITORIA #12: só contra-ataca position:absolute se a Meta REALMENTE estiver
            // posicionando esse card por coordenadas (a técnica de virtualização que esse
            // override foi escrito pra contornar). Forçar position:relative/top/left
            // incondicionalmente — mesmo quando a Meta já não usa mais absolute — briga com o
            // próprio layout dela sem necessidade.
            const computedPosition = getComputedStyle(cell).position;
            if (computedPosition === "absolute" || computedPosition === "fixed") {
              cell.style.setProperty("position", "relative", "important");
              cell.style.setProperty("top", "auto", "important");
              cell.style.setProperty("left", "auto", "important");
              cell.style.setProperty("transform", "none", "important");
            }
            cell.style.setProperty("margin", "0", "important");
          } else {
            cell.style.setProperty("display", "none", "important");
          }
        }

        // FIX GRID HORIZONTAL: CSS Grid com coluna mínima fixa (300px) garante múltiplas
        // colunas sempre, independente da largura do conteúdo interno do card nativo.
        if (item.shouldShow && parent && !_vivaConfiguredFlexParents.has(parent)) {
          _vivaConfiguredFlexParents.add(parent);
          // AUDITORIA #12: só força grid se o container ainda NÃO estiver organizando os
          // frames em grade por conta própria. Se a Meta já faz isso nativamente, sobrescrever
          // por cima é provavelmente o que quebrava a grade quando a estrutura dela mudou —
          // melhor confiar no layout que já funciona.
          const parentStyle = getComputedStyle(parent);
          const alreadyWraps = (parentStyle.display === "flex" || parentStyle.display === "grid") && parentStyle.flexWrap !== "nowrap";
          if (!alreadyWraps) {
            parent.style.setProperty("display", "grid", "important");
            parent.style.setProperty("grid-template-columns", "repeat(auto-fill, 300px)", "important");
            parent.style.setProperty("justify-content", "center", "important");
            parent.style.setProperty("gap", "16px", "important");
          }
        }
      });

      // ─── Continua com a injeção de badges nos cards visíveis ───────────────────
      activeCardData.forEach(item => {
        const card = item.card;
        const data = item.data;
        // FIX FRAME: a moldura de escala precisa envolver a caixa inteira, não mais só o card
        // nativo por dentro — "toda a card" pedida, não uma faixa espremida no meio do conteúdo.
        const frame = getOrCreateCardFrame(card);

        // Única fonte de verdade para a fase (ver STAGE_INFO/resolveStage) — sem sistema
        // paralelo de "níveis" antigo, pra nunca ter duas regras de escala competindo.
        frame.classList.remove("viva-stage-teste", "viva-stage-potencial", "viva-stage-bruta");
        frame.classList.add(`viva-stage-${item.stage}`);

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
    const renderSig = `${item.effectiveDupCount}-${item.twinCount}-${data.adAgeDays}-${data.isWhatsApp}-${item.shouldShow}`;
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

      if (data.destUrl) {
        urlInput.addEventListener("click", (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(data.destUrl).then(() => {
            urlInput.classList.add("viva-url-input-copied");
            const originalVal = urlInput.value;
            urlInput.value = "Copiado e abrindo! ✓";
            
            setTimeout(() => {
              urlInput.classList.remove("viva-url-input-copied");
              urlInput.value = originalVal;
            }, 1200);
          });
          window.open(data.destUrl, "_blank");
        });
      } else {
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

        // FIX SOBERANIA/PORTAL (2026-08): o dropdown "Ações" deixou de ser filho do card
        // (position:absolute dentro de .viva-card-frame) e virou um PORTAL — anexado direto
        // em <body>, position:fixed, z-index máximo (ver content.css). Isso resolve de vez a
        // sobreposição visual com o card da linha de baixo depois de muito scroll: antes, cada
        // .viva-card-frame tinha seu próprio stacking context (contain:layout), então o
        // dropdown de um card disputava camadas com o card vizinho e podia perder essa disputa
        // dependendo da posição na grade. Como portal, ele nunca mais é descendente de NENHUM
        // card — não tem mais com quem disputar z-index.
        //
        // Checagem de "toggle" (clicar de novo fecha) agora usa uma tag de propriedade
        // (_vivaOwnerBtn) em vez de gearContainer.querySelector(...), já que o dropdown não
        // mora mais dentro do gearContainer.
        const existingDropdown = document.querySelector(".viva-gear-dropdown");
        const wasThisButtonsDropdown = existingDropdown && existingDropdown._vivaOwnerBtn === gearBtn;
        document.querySelectorAll(".viva-gear-dropdown").forEach(d => d.remove());
        if (wasThisButtonsDropdown) return; // este clique era pra FECHAR — já fechamos acima.

        // Constrói o menu sob demanda na memória RAM (Lazy Rendering - 0ms overhead)
        const dropdown = document.createElement("div");
        dropdown.className = "viva-gear-dropdown viva-el viva-active";
        dropdown._vivaOwnerBtn = gearBtn;
        dropdown.addEventListener("click", (evt) => evt.stopPropagation());

        // 1. Ver Anúncios da Página
        const itemVerAds = document.createElement("button");
        itemVerAds.className = "viva-dropdown-item";
        itemVerAds.innerHTML = `👁️ Ver Anúncios da Página`;
        itemVerAds.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          dropdown.remove();
          let resolvedPageId = card.getAttribute("data-viva-page-id") || data.pageId || extractPageId(card);
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
        itemFunnel.innerHTML = `🔀 Salvar no Funil`;
        itemFunnel.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          dropdown.remove();
          openFunnelModal(data.destUrl || "", data.advertiserName);
        });
        dropdown.appendChild(itemFunnel);

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
        itemCopy.addEventListener("click", (evt) => {
          evt.stopPropagation();
          dropdown.remove();
          let blocks = [];
          if (data.primaryText) blocks.push(`TEXTO PRINCIPAL\n${data.primaryText}`);
          if (data.title) blocks.push(`TÍTULO/HEADLINE\n${data.title}`);
          if (data.description) blocks.push(`DESCRIÇÃO\n${data.description}`);
          const copyText = blocks.length > 0 ? blocks.join("\n\n") : "Nenhum texto detectado neste anúncio";
          navigator.clipboard.writeText(copyText).then(() => alert("Copies copiadas com sucesso!"));
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

        // FIX PORTAL: anexa em <body> (não mais em gearContainer) e posiciona via JS logo em
        // seguida — precisa estar no DOM primeiro para offsetWidth/offsetHeight ficarem
        // mensuráveis dentro de positionGearDropdown().
        document.body.appendChild(dropdown);
        positionGearDropdown(dropdown, gearBtn);

        // FIX PORTAL: como o dropdown agora é position:fixed (relativo à viewport, não mais ao
        // botão que o abriu), rolar a página o deixaria "flutuando" longe do gear que o abriu.
        // Fecha automaticamente no primeiro scroll — padrão de UX comum em menus/popovers, e
        // mais seguro/barato do que reposicionar a cada frame de scroll.
        const closeOnScroll = () => {
          dropdown.remove();
          window.removeEventListener("scroll", closeOnScroll, true);
        };
        window.addEventListener("scroll", closeOnScroll, { capture: true, passive: true });
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
  });

    } catch (err) {
      console.error("[VIVA] Erro no GPU Sync Batch:", err);
    } finally {
      isBatching = false;
      clearTimeout(batchingWatchdogTimeout);
      lastCycleDurationMs = Math.round((performance.now() - cycleStartTime) * 100) / 100;
      const healthEl = document.getElementById("viva-engine-health");
      if (healthEl) {
        healthEl.innerHTML = `⚡ O(1) · ${lastCycleDurationMs}ms (${activeCardData.length} ads)`;
      }
      if (pendingBatchCards) {
        pendingBatchCards = false;
        processCards();
      }
    }
  });
}

function getOfficialMetaTotalResults() {
  // Soma todas as duplicações nativas da Meta reportadas nos cards processados na tela
  let totalAdsSum = 0;
  activeCardData.forEach(item => {
    totalAdsSum += (item.data.metaAdCount || 1);
  });
  return totalAdsSum || activeCardData.length || 1;
}

function openFunnelModal(landingUrl, advertiserContext) {
  const existing = document.getElementById("viva-funnel-modal-container");
  if (existing) existing.remove();

  const activeName = advertiserContext || getPageNameFromHeader() || extractCleanDomain(landingUrl) || "Anunciante";
  const slug = toSlug(activeName);

  // Lista dinâmica de N etapas do funil (inicia com rótulo vazio)
  let steps = [
    { id: 1, tipo: "vsl", rotulo: "", url: landingUrl }
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
        <span class="viva-funnel-step-badge">${getOfficialMetaTotalResults()} criativos ativos</span>
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
      card.querySelector(".step-rotulo").addEventListener("input", (e) => { step.rotulo = e.target.value.trim(); });
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

  overlay.querySelector("#viva-funnel-add-step").addEventListener("click", () => {
    steps.push({
      id: Date.now(),
      tipo: "checkout",
      rotulo: "",
      url: ""
    });
    renderSteps();
    container.scrollTop = container.scrollHeight;
  });

  overlay.querySelector("#viva-funnel-cancel").addEventListener("click", () => overlay.remove());

  overlay.querySelector("#viva-funnel-review").addEventListener("click", () => {
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
            url: window.location.href,
            tipo: window.location.href.includes("view_all_page_id=") ? "pagina" : "dominio",
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
          const matchedPlayer = monitoredPages.find(p => {
            if (!p) return false;
            const pNome = (p.nome || "").toLowerCase().trim();
            const aNome = (activeName || "").toLowerCase().trim();
            if (pNome && pNome === aNome) return true;
            if (p.slug && (p.slug === authoritativeSlug || p.slug === slug)) return true;
            const pageId = new URLSearchParams(window.location.search).get("view_all_page_id");
            if (pageId && p.url && p.url.includes(pageId)) return true;
            return false;
          });
          if (matchedPlayer) {
            if (matchedPlayer.slug) authoritativeSlug = matchedPlayer.slug;
            if (matchedPlayer.id || matchedPlayer._id) authoritativeId = matchedPlayer.id || matchedPlayer._id;
          }
        }

        // 2º Passo: Salva todas as N etapas do funil vinculadas ao slug/ID autoritativo do servidor
        let successCount = 0;
        let lastErrorMsg = "";

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


function injectSidebar() {
  if (document.getElementById("viva-sidebar")) return;

  const sidebar = document.createElement("div");
  sidebar.id = "viva-sidebar";
  sidebar.className = "viva-sidebar viva-el";

  sidebar.innerHTML = `
    <div class="viva-sidebar-header">
      <div style="display:flex; align-items:center; gap:8px;">
        <h3 class="viva-sidebar-title">VIVA Labs Monitor <span style="font-size:9px; opacity:0.5; font-weight:400;">v6-fix</span></h3>
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
          <div class="viva-segmented-control">
            <button id="viva-tab-page" class="viva-segmented-btn active">🏢 Por Página</button>
            <button id="viva-tab-domain" class="viva-segmented-btn">🌐 Por Domínio/URL</button>
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
              <label class="viva-label">Instagram Link <span style="font-weight:400; color:#86868b">(opcional)</span></label>
              <input type="text" id="viva-side-instagram" class="viva-input" placeholder="Aguardando aba 'Sobre' ou cole link..." style="width:100%; box-sizing: border-box;">
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
        </div>
      </div>

      <div class="viva-divider"></div>

      <!-- Seção 3: Ranking e Inteligência de Escala -->
      <div class="viva-panel-section">
        <button class="viva-btn viva-btn-red-pro" id="viva-btn-show-ranking" title="Exibe o ranking em tempo real dos maiores anunciantes na tela">
          🏆 Ver Top Anunciantes
        </button>
        <div style="margin-top: 12px; display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--viva-muted); padding-top: 8px; border-top: 1px dashed var(--viva-border);">
          <span>Motor VIVA:</span>
          <span id="viva-engine-health" style="font-weight: 600; color: #34C759;" title="Tempo real do último ciclo do processador O(1) e contagem de anúncios no cache">⚡ O(1) · 0.0ms</span>
        </div>
      </div>

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

  // Segmented Control Tabs (Por Página vs Por Domínio/URL)
  const tabPage = document.getElementById("viva-tab-page");
  const tabDomain = document.getElementById("viva-tab-domain");
  const pageView = document.getElementById("viva-tracker-page-view");
  const domainView = document.getElementById("viva-tracker-domain-view");

  if (tabPage && tabDomain && pageView && domainView) {
    tabPage.addEventListener("click", () => {
      tabPage.classList.add("active");
      tabDomain.classList.remove("active");
      pageView.style.display = "block";
      domainView.style.display = "none";
    });
    tabDomain.addEventListener("click", () => {
      tabDomain.classList.add("active");
      tabPage.classList.remove("active");
      pageView.style.display = "none";
      domainView.style.display = "block";

      const domainInput = document.getElementById("viva-side-domain");
      if (domainInput && !domainInput.value) {
        const detected = detectActiveDomainOrUrl();
        if (detected) domainInput.value = detected;
      }
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
    if (!vivaMonitorMasterEnabled) return;
    // Poll Page Name
    if (nameInput && (!nameInput.value || nameInput.value === "Competidor Meta")) {
      const pageTitle = getPageNameFromHeader();
      if (pageTitle && pageTitle.trim() && pageTitle !== "Carregando...") {
        nameInput.value = pageTitle;
        checkMonitoredStatus(pageTitle);
      }
    }

    // Poll Instagram (Agnóstico, não depende mais de view_all_page_id)
    if (igInput && !hasFoundIg) {
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
  }, 2000);

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
      const cardsRendered = activeCardData.length || 0;

      showAppleConfirmModal({
        nome,
        tipo: "Página de Anunciante",
        geo: geo || "BR",
        nicho: nicho || "Geral",
        instagram: igUrlToSend || "Não vinculado",
        totalMetaAds: totalMetaAds,
        cardsRendered: cardsRendered
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
      const cardsRendered = activeCardData.length || 0;

      showAppleConfirmModal({
        nome: dominio,
        tipo: "Domínio / Funil URL",
        geo: geo || "ALL",
        nicho: nicho || "Funil Web",
        instagram: ig || "Não vinculado",
        totalMetaAds: totalMetaAds,
        cardsRendered: cardsRendered
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
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">GEO • Nicho:</span>
            <span class="viva-confirm-value">${vivaEscapeHtml(info.geo)} • ${vivaEscapeHtml(info.nicho)}</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Instagram:</span>
            <span class="viva-confirm-value" title="${vivaEscapeHtml(info.instagram)}">${vivaEscapeHtml(info.instagram.replace("https://www.", "").replace("https://", ""))}</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Total Oficial (Meta):</span>
            <span class="viva-confirm-value" style="color:#007AFF;">${info.totalMetaAds} anúncios ativos</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Cards Carregados:</span>
            <span class="viva-confirm-value" style="font-weight:500; color:var(--viva-muted);">${info.cardsRendered} cards na tela</span>
          </div>
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

  // 6. Top Anunciantes Ranking Modal (Apple Red Pro Trigger)
  const rankingBtn = document.getElementById("viva-btn-show-ranking");
  if (rankingBtn) {
    rankingBtn.addEventListener("click", () => {
      showTopAdvertisersModal();
    });
  }
}

function showTopAdvertisersModal() {
  const existing = document.getElementById("viva-ranking-overlay");
  if (existing) existing.remove();

  const advMap = {};
  activeCardData.forEach(item => {
    const name = item.data.advertiserName || "Desconhecido";
    if (!advMap[name]) {
      advMap[name] = {
        name: name,
        count: 0,
        maxDup: item.effectiveDupCount || 1,
        maxAge: item.data.adAgeDays || 0,
        maxStage: item.stage,
        pageId: item.card.getAttribute("data-viva-page-id") || item.data.pageId || extractPageId(item.card) || null,
        adArchiveId: extractAdArchiveId(item.card) || null
      };
    } else {
      if (!advMap[name].pageId) {
        advMap[name].pageId = item.card.getAttribute("data-viva-page-id") || item.data.pageId || extractPageId(item.card) || null;
      }
      if (!advMap[name].adArchiveId) {
        advMap[name].adArchiveId = extractAdArchiveId(item.card) || null;
      }
    }
    advMap[name].count += 1;
    if (item.effectiveDupCount > advMap[name].maxDup) advMap[name].maxDup = item.effectiveDupCount;
    if (item.data.adAgeDays > advMap[name].maxAge) advMap[name].maxAge = item.data.adAgeDays;
    // Ranking mostra a fase MAIS ALTA entre os anúncios do anunciante (bruta > potencial > teste).
    if (STAGE_RANK[item.stage] > STAGE_RANK[advMap[name].maxStage]) {
      advMap[name].maxStage = item.stage;
    }
  });

  const advList = Object.values(advMap).sort((a, b) => (b.count * b.maxDup) - (a.count * a.maxDup));

  const overlay = document.createElement("div");
  overlay.id = "viva-ranking-overlay";
  overlay.className = "viva-confirm-overlay viva-el";

  let listHtml = "";
  if (advList.length === 0) {
    listHtml = `<div style="text-align: center; padding: 24px; color: var(--viva-muted); font-size: 13px;">Nenhum anunciante detectado na tela ainda. Role a página para carregar anúncios.</div>`;
  } else {
    advList.slice(0, 15).forEach((adv, index) => {
      let targetUrl;
      if (adv.pageId) {
        targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&search_type=page&view_all_page_id=${encodeURIComponent(adv.pageId)}`;
      } else if (adv.adArchiveId) {
        targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&id=${encodeURIComponent(adv.adArchiveId)}&is_targeted_country=false&media_type=all&search_type=page`;
      } else {
        targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&q=${encodeURIComponent('"' + adv.name + '"')}&search_type=keyword_exact_phrase`;
      }

      const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `#${index + 1}`;
      const rankStageInfo = STAGE_INFO[adv.maxStage];
      const badgeClass = rankStageInfo.chipClass;
      const badgeText = rankStageInfo.label;
      listHtml += `
        <div class="viva-ranking-item" title="Clique para abrir a Biblioteca deste anunciante em nova aba" data-target-url="${vivaEscapeHtml(targetUrl)}" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--viva-border); border-radius: 10px; margin-bottom: 6px; background: rgba(255,255,255,0.6); transition: all 0.2s;">
          <div style="display: flex; align-items: center; gap: 12px; max-width: 65%;">
            <span style="font-size: 16px; font-weight: 700; width: 28px; text-align: center; color: var(--viva-text);">${medal}</span>
            <div style="display: flex; flex-direction: column; overflow: hidden;">
              <span style="font-weight: 600; font-size: 13.5px; color: var(--viva-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px;">
                ${vivaEscapeHtml(adv.name)} <span style="font-size: 11px; color: var(--viva-accent); font-weight: 700;">↗</span>
              </span>
              <span style="font-size: 11px; color: var(--viva-muted);">Ativo no DOM: ${adv.count} cards • Pico de Variações: ${adv.maxDup}x</span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="viva-escala-chip ${badgeClass}" style="font-size: 10px; padding: 3px 8px;">${badgeText}</span>
          </div>
        </div>
      `;
    });
  }

  overlay.innerHTML = `
    <div class="viva-confirm-card" style="width: 520px; max-height: 82vh; display: flex; flex-direction: column; padding: 24px;" onclick="event.stopPropagation()">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid var(--viva-border); padding-bottom: 14px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 22px;">🏆</span>
          <div>
            <div class="viva-confirm-title" style="font-size: 18px; margin: 0;">Top Anunciantes na Tela</div>
            <div class="viva-confirm-sub" style="font-size: 12px; margin: 2px 0 0 0;">Ranking em tempo real baseado no volume de escala e variações ativas.</div>
          </div>
        </div>
        <button id="viva-ranking-close" style="background: none; border: none; font-size: 20px; cursor: pointer; color: var(--viva-muted); padding: 4px;">✕</button>
      </div>
      <div style="overflow-y: auto; flex: 1; padding-right: 4px; max-height: 52vh;">
        ${listHtml}
      </div>
      <div style="margin-top: 18px; pt-3; border-top: 1px solid var(--viva-border); display: flex; justify-content: flex-end;">
        <button class="viva-confirm-btn viva-confirm-btn-confirm" id="viva-ranking-btn-ok" style="width: 100%; background: linear-gradient(135deg, #FF3B30 0%, #D70015 100%); border: none; box-shadow: 0 4px 12px rgba(215, 0, 21, 0.28);">Fechar Ranking</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("viva-visible"));

  // AUDITORIA #06: usa data-target-url + listener delegado, não mais onclick="window.open(...)"
  // inline com URL interpolada crua no atributo — evita quebrar o HTML/injetar markup caso a
  // URL alguma vez contenha aspas simples não previstas pelo .replace() manual anterior.
  overlay.querySelectorAll(".viva-ranking-item[data-target-url]").forEach(el => {
    el.addEventListener("click", () => {
      const url = el.getAttribute("data-target-url");
      if (url) window.open(url, "_blank");
    });
  });

  const closeOverlay = () => {
    overlay.classList.remove("viva-visible");
    setTimeout(() => overlay.remove(), 250);
  };

  overlay.addEventListener("click", closeOverlay);
  const closeBtn = overlay.querySelector("#viva-ranking-close");
  const okBtn = overlay.querySelector("#viva-ranking-btn-ok");
  if (closeBtn) closeBtn.addEventListener("click", closeOverlay);
  if (okBtn) okBtn.addEventListener("click", closeOverlay);
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
      isMonitored = monitoredPages.some(p => p.url.includes(pageId));
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



// ─── VIVA Dock: barra fixa no rodapé com os filtros de tela ─────────────────────────────────
// Extraído da sidebar (Controle & Filtros) para ficar sempre visível, independente de scroll,
// e pra deixar claro visualmente que os filtros são cumulativos: Mínimo de Ads Ativos e
// Recentes, por exemplo, podem estar ativos ao mesmo tempo — nenhum exclui o outro. A lógica
// de combinação em processCards() já era assim (ifs sequenciais que só desligam shouldShow,
// nunca resetam); aqui só reorganiza ONDE os controles vivem, o comportamento é idêntico.
function injectDock() {
  if (document.getElementById("viva-dock")) return;

  const dock = document.createElement("div");
  dock.id = "viva-dock";
  dock.className = "viva-dock viva-el";

  dock.innerHTML = `
    <div class="viva-dock-group">
      <label class="viva-dock-label" for="viva-dock-min-page" title="Quantidade total de anúncios que o anunciante está rodando (indica volume).">Mín. Ads Ativos</label>
      <input type="number" id="viva-dock-min-page" class="viva-dock-input" min="0" placeholder="0">
    </div>

    <div class="viva-dock-group">
      <label class="viva-dock-label" for="viva-dock-min-dup" title="Quantidade de vezes que o MESMO criativo se repete (indica agressividade na escala).">Mín. Duplicados</label>
      <input type="number" id="viva-dock-min-dup" class="viva-dock-input" min="0" placeholder="0">
    </div>

    <button class="viva-btn viva-btn-primary viva-dock-apply-btn" id="viva-dock-apply" type="button">Aplicar</button>

    <div class="viva-dock-divider"></div>

    <div class="viva-dock-toggle-group" title="Mostra somente anúncios com até 3 dias de veiculação ativa">
      <label class="viva-switch viva-switch-sm">
        <input type="checkbox" id="viva-dock-recentes">
        <span class="viva-slider"></span>
      </label>
      <span class="viva-dock-toggle-label">Recentes (≤ 3 dias)</span>
    </div>

    <div class="viva-dock-toggle-group" title="Rola a página sozinho até o fim da biblioteca para carregar tudo">
      <label class="viva-switch viva-switch-sm">
        <input type="checkbox" id="viva-dock-autoscroll">
        <span class="viva-slider"></span>
      </label>
      <span class="viva-dock-toggle-label">Auto-Scroll</span>
    </div>
  `;

  document.body.appendChild(dock);
  setupDockInteractions();
}

function setupDockInteractions() {
  const minPageInput = document.getElementById("viva-dock-min-page");
  const minDupInput = document.getElementById("viva-dock-min-dup");
  const applyBtn = document.getElementById("viva-dock-apply");
  const recentesToggle = document.getElementById("viva-dock-recentes");
  const scrollToggle = document.getElementById("viva-dock-autoscroll");

  // FIX SINCRONIA: ao recriar o dock (ex.: navegação SPA dentro da Ad Library), os campos
  // nascem refletindo o estado JS atual — nunca zerados — para deixar visualmente óbvio que
  // os filtros continuam ativos e são cumulativos, não um substituindo o outro.
  if (minPageInput) minPageInput.value = minPageAds > 0 ? minPageAds : "";
  if (minDupInput) minDupInput.value = minDupAds > 0 ? minDupAds : "";
  if (recentesToggle) recentesToggle.checked = filterOnlyRecent;
  if (scrollToggle) scrollToggle.checked = isAutoScrollRunning;

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      minPageAds = parseInt(minPageInput.value, 10) || 0;
      minDupAds = parseInt(minDupInput.value, 10) || 0;

      // Mesmo efeito colateral de antes: aplicar filtro manual para o auto-scroll.
      isAutoScrollRunning = false;
      if (scrollToggle) scrollToggle.checked = false;
      stopAutoScroll();

      processCards();

      applyBtn.textContent = "Aplicado ✓";
      applyBtn.style.backgroundColor = "var(--viva-success)";
      setTimeout(() => {
        applyBtn.textContent = "Aplicar";
        applyBtn.style.backgroundColor = "var(--viva-accent)";
      }, 1500);
    });
  }

  // Recentes e Auto-Scroll aplicam direto no "change" — sem precisar clicar em Aplicar, e sem
  // desligar nenhum outro filtro. São cumulativos com Mín. Ads Ativos/Duplicados.
  if (recentesToggle) {
    recentesToggle.addEventListener("change", (e) => {
      filterOnlyRecent = e.target.checked;
      processCards();
    });
  }

  if (scrollToggle) {
    scrollToggle.addEventListener("change", (e) => {
      isAutoScrollRunning = e.target.checked;
      if (isAutoScrollRunning) {
        startAutoScroll();
      } else {
        stopAutoScroll();
        processCards();
      }
    });
  }
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
    if (_vivaUrlIntervalId) {
      clearInterval(_vivaUrlIntervalId);
      _vivaUrlIntervalId = null;
    }
    if (_vivaScrollHandler) {
      window.removeEventListener("scroll", _vivaScrollHandler);
    }
  }
  const panel = document.getElementById("viva-sidebar");
  if (panel) panel.remove();
  const modal = document.getElementById("viva-funnel-modal-overlay");
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
  document.querySelectorAll("[data-viva-processed], [data-viva-id], .viva-processed").forEach(el => {
    el.removeAttribute("data-viva-processed");
    el.removeAttribute("data-viva-id");
    try { mediaPruningObserver.unobserve(el); } catch(e) {}
    // FAXINA: as classes de fase (viva-stage-*) vivem no FRAME, não no card — e o frame
    // inteiro já é destruído/desembrulhado antes deste ponto (ver bloco FIX FRAME acima), então
    // não há nada de fase pra limpar aqui, só o carimbo de processado do card em si.
    el.classList.remove("viva-processed");
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
  console.log("[VIVA] Extensão carregando... BUILD-CLAUDE-FRAME-v6 (2026-09-04) — frame architecture + O(1) advertiser counts + XSS escaping + adaptive grid cell finder");
  // FIX 4.1: loadLocalApiUrl() é só storage local (instantâneo). fetchMonitoredPages() é
  // deliberadamente NÃO aguardado (fire-and-forget) — roda em paralelo com timeout próprio e
  // nunca atrasa a sidebar, o observer ou o processamento de cards.
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
    setTimeout(() => {
      injectSidebar();
      injectScrollTopBtn();
      injectDock();
      processCards();
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
    if (!vivaMonitorMasterEnabled) return;
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
  if (!vivaMonitorMasterEnabled) return;
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    console.log("[VIVA] URL mudou, limpando cache local e reiniciando...");
    // FIX 4.2: reset LEVE (fullTeardown padrão false) — navegação SPA dentro da própria Ad
    // Library não pode desconectar o observer/interval/scroll, senão a extensão para de
    // detectar novas trocas de URL depois da primeira e "morre" pelo resto da sessão.
    teardownVivaMonitor();
    lastFullScanTime = 0; // força uma varredura completa de descoberta logo após a navegação SPA

    setTimeout(() => {
      injectSidebar();
      injectScrollTopBtn();
      injectDock();
      const pageTitle = getPageNameFromHeader();
      const nameInput = document.getElementById("viva-side-name");
      if (nameInput) nameInput.value = pageTitle;
      checkMonitoredStatus(pageTitle);

      // Atualiza dinamicamente a exibição do campo do Instagram no painel lateral
      const isPage = window.location.href.includes("view_all_page_id=");
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
            } else {
              igInput.style.opacity = "0.5";
              igInput.style.cursor = "not-allowed";
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
}

init();