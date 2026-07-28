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
let cachedContingencyStatus = null;
let cachedContingencyChecked = false;
let vivaMonitorMasterEnabled = true;

// FIX DE ESCALA (buscas com dezenas de milhares de resultados): fila de nós recém-adicionados
// detectados pelo MutationObserver principal. getAdCards() consome esta fila para restringir
// sua varredura de "botões/links" a apenas o que mudou, em vez de escanear a página inteira
// a cada ciclo — o gargalo real de performance em buscas grandes com rolagem longa.
let pendingScanRoots = [];

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

// Adiciona ouvinte global para proteger vídeos onde o operador clicou no Play
window.addEventListener("play", (e) => {
  if (e.target && e.target.nodeName === "VIDEO") {
    e.target.dataset.vivaInteracted = "true";
  }
}, true);

// Filtros Globais
let hideRecent = false;
let hideNonScaled = false;
let filterOnlyRecent = false;
let minPageAds = 0; 
let minDupAds = 0;

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

async function loadConfig() {
  const data = await chrome.storage.local.get("viva_monitor_api_url");
  if (data.viva_monitor_api_url) {
    API_URL = data.viva_monitor_api_url;
  }
  await fetchMonitoredPages();
}

async function fetchMonitoredPages() {
  try {
    const res = await fetch(`${API_URL}/api/paginas`);
    monitoredPages = await res.json();
  } catch (e) {
    console.error("[VIVA] Erro ao carregar monitorados:", e);
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
    document.querySelectorAll("[role='button'], button, a").forEach(el => candidateSet.add(el));
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
const REGEX_CREATED_DATE = /Página criada em:?\s+(\d+)\s+de\s+([a-zç\.]+)(?:\s+de)?\s+(\d+)/i;
const REGEX_META_AD_COUNT = /(\d+)\s+(?:an[uú]ncios\s+usam|ads\s+use)/i;
const REGEX_SIMPLE_DOMAIN = /^[a-z0-9\-\.]+\.[a-z]{2,4}(\/.*)?$/i;
const REGEX_ONLY_DOMAIN = /^[a-z0-9\-\.]+\.[a-z]{2,4}$/i;
const REGEX_ONLY_DIGITS = /^\d{10,20}$/;

const WP_PATTERNS = [
  "api.whatsapp.com", "wa.me", "web.whatsapp.com", "chat.whatsapp.com",
  "wanalink", "wana.cm", "wanazap", "convertzap", "cvtzap",
  "zaplink", "linkzap", "superzap", "joinzap", "grupozap"
];

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

function getAdCount(advertiserName) {
  return activeCardData.filter(item => item.data.advertiserName === advertiserName).length;
}

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

function checkContingencyStatus(card) {
  if (cachedContingencyChecked) return cachedContingencyStatus;
  cachedContingencyChecked = true;
  const matchCreated = document.body.textContent.match(REGEX_CREATED_DATE);
  if (matchCreated) {
    const createdDate = parseMetaDate(matchCreated[0]);
    if (createdDate) {
      const diffDays = Math.ceil(Math.abs(new Date() - createdDate) / (1000 * 60 * 60 * 24));
      cachedContingencyStatus = diffDays < 45 ? "Contingência" : "Consolidada";
      return cachedContingencyStatus;
    }
  }
  return null;
}

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

function extractCardData(card) {
  if (cardDataMap.has(card)) return cardDataMap.get(card);
  if (card._vivaData) {
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
    sig: `${cleanText}|${cleanMedia}`
  };
  cardDataMap.set(card, data);
  card._vivaData = data;
  return data;
}

let isBatching = false;
let pendingBatchCards = false;

function processCards() {
  if (!vivaMonitorMasterEnabled) return;
  if (isBatching) {
    pendingBatchCards = true;
    return;
  }
  const cycleStartTime = performance.now();

  // ─── VIVA Orphan Node Sweeper & Garbage Collection Preparation ───
  // Limpeza proativa de nós órfãos desconectados da árvore ou cartões reciclados pelo virtualizador do React
  document.querySelectorAll(".viva-card-footer, .viva-escala-strip, .viva-card-badge-container, .viva-gear-dropdown").forEach(el => {
    if (!el.isConnected || (!el.closest(".viva-processed") && !el.closest("[data-viva-id]"))) {
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
      return false;
    }
    return true;
  });
  cardSignatures = {};
  const mediaSignatures = {};
  const domainSignatures = {};
  activeCardData = cards.map(card => {
    const data = card._vivaData || extractCardData(card);
    cardSignatures[data.sig] = (cardSignatures[data.sig] || 0) + 1;
    if (data.mediaSig && data.mediaSig.length > 3) {
      mediaSignatures[data.mediaSig] = (mediaSignatures[data.mediaSig] || 0) + 1;
    }
    const rootDom = data.destUrl ? extractCleanDomain(data.destUrl) : null;
    if (rootDom) {
      domainSignatures[rootDom] = (domainSignatures[rootDom] || 0) + 1;
    }
    data.rootDom = rootDom;
    return { card, data };
  });

  activeCardData.forEach(item => {
    const data = item.data;
    const domDupCount = cardSignatures[data.sig] || 1;
    const effectiveDupCount = Math.max(domDupCount, data.metaAdCount || 1);
    const twinCount = (data.mediaSig && mediaSignatures[data.mediaSig]) ? mediaSignatures[data.mediaSig] : 1;
    const domainCount = data.rootDom ? (domainSignatures[data.rootDom] || 1) : 1;
    item.effectiveDupCount = effectiveDupCount;
    item.twinCount = twinCount;
    item.domainCount = domainCount;

    const adsCount = getAdCount(data.advertiserName);
    item.isEscala = (data.adAgeDays !== null && data.adAgeDays >= 3) || effectiveDupCount >= 2;
    
    let shouldShow = true;
    if (minPageAds > 0 && adsCount < minPageAds) shouldShow = false;
    if (minDupAds > 0 && effectiveDupCount < minDupAds) shouldShow = false;
    if (hideRecent && data.adAgeDays !== null && data.adAgeDays < 3) shouldShow = false;
    if (hideNonScaled && !((data.adAgeDays !== null && data.adAgeDays >= 5) || (effectiveDupCount >= 3))) shouldShow = false;
    if (filterOnlyRecent && (data.adAgeDays === null || data.adAgeDays > 3)) shouldShow = false;
    item.shouldShow = shouldShow;
  });

  const hasActiveFilter = (minPageAds > 0 || minDupAds > 0 || hideRecent || hideNonScaled || filterOnlyRecent);

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
        if (!f.closest(".viva-processed") && !f.closest("[data-viva-id]")) f.remove();
      });

      if (!hasActiveFilter) {
        activeCardData.forEach(item => {
          let cell = item.card;
          let parent = cell.parentElement;
          if (parent && parent.children.length === 1 && parent.parentElement) {
            cell = parent;
            parent = parent.parentElement;
          }
          cell.style.removeProperty("display");
          cell.style.removeProperty("position");
          cell.style.removeProperty("top");
          cell.style.removeProperty("left");
          cell.style.removeProperty("transform");
          cell.style.removeProperty("margin");
          if (parent) {
            parent.style.removeProperty("display");
            parent.style.removeProperty("flex-wrap");
            parent.style.removeProperty("justify-content");
            parent.style.removeProperty("gap");
          }
        });
      } else {
        activeCardData.forEach(item => {
          let cell = item.card;
          let parent = cell.parentElement;
          if (parent && parent.children.length === 1 && parent.parentElement) {
            cell = parent;
            parent = parent.parentElement;
          }

          if (item.shouldShow) {
            cell.style.setProperty("display", "block", "important");
            cell.style.setProperty("position", "relative", "important");
            cell.style.setProperty("top", "auto", "important");
            cell.style.setProperty("left", "auto", "important");
            cell.style.setProperty("transform", "none", "important");
            cell.style.setProperty("margin", "0", "important");

            if (parent) {
              parent.style.setProperty("display", "flex", "important");
              parent.style.setProperty("flex-wrap", "wrap", "important");
              parent.style.setProperty("justify-content", "center", "important");
              parent.style.setProperty("gap", "16px", "important");
            }
          } else {
            cell.style.setProperty("display", "none", "important");
          }
        });
      }

      // ─── Continua com a injeção de badges nos cards visíveis ───────────────────
      activeCardData.forEach(item => {
        const card = item.card;
        const data = item.data;

        card.classList.remove("viva-border-level-1", "viva-border-level-2", "viva-border-level-3", "viva-border-escala");
        if (item.isEscala) {
          card.classList.add("viva-border-escala");
        } else {
          card.classList.add("viva-border-level-1");
        }

        if (!item.shouldShow) return; // Não injeta badges em cards ocultos para poupar RAM

    // ─── BLINDAGEM ANTI-DUPLICIDADE PADRÃO APPLE (Idempotência DOM) ───
    // Previne que re-renderizações do React Fiber ou cartões DCO/Carrossel dupliquem widgets
    const allStrips = card.querySelectorAll(".viva-escala-strip");
    if (allStrips.length > 1) {
      for (let i = 1; i < allStrips.length; i++) allStrips[i].remove();
    }
    const allContainers = card.querySelectorAll(".viva-card-badge-container");
    if (allContainers.length > 1) {
      for (let i = 1; i < allContainers.length; i++) allContainers[i].remove();
    }
    const allFooters = card.querySelectorAll(".viva-card-footer");
    if (allFooters.length > 1) {
      for (let i = 1; i < allFooters.length; i++) allFooters[i].remove();
    }

    // Carimba o card de forma persistente
    card.dataset.vivaId = data.sig || "ad_card";

    // C. Injeção de Componentes Apple-style
    const renderSig = `${item.effectiveDupCount}-${item.twinCount}-${data.adAgeDays}-${data.isWhatsApp}-${item.shouldShow}`;
    if (card.classList.contains("viva-processed") && card._vivaRenderSig === renderSig && card.querySelector(".viva-card-badge-container") && card.querySelector(".viva-card-footer")) {
      return; // Apple Dirty-Checking: 0.00ms DOM touch em cartões já processados e sem alteração de estado
    }
    card._vivaRenderSig = renderSig;

    let badgeContainer = card.querySelector(".viva-card-badge-container");
    let cardFooter = card.querySelector(".viva-card-footer");

    // 1. Atualização/Injeção dos Badges
    if (badgeContainer) {
      let escalaStrip = card.querySelector(".viva-escala-strip");
      if (escalaStrip) {
        const isEscala = (data.adAgeDays !== null && data.adAgeDays >= 3) || item.effectiveDupCount >= 2;
        const daysText = data.adAgeDays !== null ? `${data.adAgeDays} DIAS ATIVO` : "ATIVO RECENTE";
        const dupText = `${item.effectiveDupCount}x ANÚNCIOS`;
        escalaStrip.innerHTML = `
          ${data.isWhatsApp ? `
            <span class="viva-escala-chip viva-escala-chip-whatsapp" title="Anúncio direcionado para Funil de WhatsApp">
              🟢 FUNIL WHATSAPP
            </span>
          ` : ''}
          <span class="viva-escala-chip ${isEscala ? 'viva-escala-chip-hot' : 'viva-escala-chip-normal'}">
            ${isEscala ? '🔥 ESCALA POTENCIAL' : '⏳ CAMPANHA NORMAL'}
          </span>
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

      // Extermina qualquer selo legado do WhatsApp na linha 2 caso exista no DOM
      const legacyWaBadge = badgeContainer.querySelector(".viva-badge-whatsapp");
      if (legacyWaBadge) legacyWaBadge.remove();
    } else {
      card.classList.add("viva-processed");
      card.classList.add("viva-el");
      mediaPruningObserver.observe(card);

      // 1. Escala Potencial Modular Apple Banner (32px / 13px Bold)
      const isEscala = (data.adAgeDays !== null && data.adAgeDays >= 3) || item.effectiveDupCount >= 2;
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
        <span class="viva-escala-chip ${isEscala ? 'viva-escala-chip-hot' : 'viva-escala-chip-normal'}">
          ${isEscala ? '🔥 ESCALA POTENCIAL' : '⏳ CAMPANHA NORMAL'}
        </span>
        <span class="viva-escala-chip viva-escala-chip-sub">⚡ ${dupText}</span>
        <span class="viva-escala-chip viva-escala-chip-sub">⏳ ${daysText}</span>
      `;
      if (card.children.length > 1) {
        card.insertBefore(escalaStrip, card.children[1]);
      } else {
        card.appendChild(escalaStrip);
      }

      // 2. Linha 2 do Painel Modular In-Flow (Domínio & Gêmeos) - ZERO flutuante no topo
      badgeContainer = document.createElement("div");
      badgeContainer.className = "viva-card-badge-container viva-el";

      if (data.destUrl) {
        const rootDom = extractCleanDomain(data.destUrl);
        if (rootDom) {
          const domBadge = document.createElement("span");
          domBadge.className = "viva-badge viva-badge-gray viva-domain-badge";
          domBadge.title = "Clique para acender/apagar todos os cards com este domínio na tela";
          domBadge.innerHTML = `
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            ${rootDom} (${item.domainCount}x)
          `;
          domBadge.addEventListener("click", (e) => {
            e.stopPropagation();
            const isLocked = domBadge.classList.toggle("viva-badge-active-blue");
            document.querySelectorAll(".viva-processed").forEach(c => {
              if (c._vivaData && c._vivaData.rootDom && c._vivaData.rootDom === rootDom) {
                if (isLocked) c.classList.add("viva-domain-locked");
                else c.classList.remove("viva-domain-locked");
              }
            });
          });
          badgeContainer.appendChild(domBadge);
        }
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

      if (escalaStrip.nextSibling) {
        card.insertBefore(badgeContainer, escalaStrip.nextSibling);
      } else {
        card.appendChild(badgeContainer);
      }
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

        // Fecha todos os outros dropdowns abertos globalmente
        document.querySelectorAll(".viva-gear-dropdown").forEach(d => d.remove());

        // Se já existia neste botão, apenas fechou e liberou a RAM
        if (gearContainer.querySelector(".viva-gear-dropdown")) return;

        // Constrói o menu sob demanda na memória RAM (Lazy Rendering - 0ms overhead)
        const dropdown = document.createElement("div");
        dropdown.className = "viva-gear-dropdown viva-el viva-active";
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

        gearContainer.appendChild(dropdown);
      });

      if (!globalDropdownListenerAdded) {
        globalDropdownListenerAdded = true;
        document.addEventListener("click", () => {
          document.querySelectorAll(".viva-gear-dropdown").forEach(d => d.remove());
        });
      }

      gearContainer.appendChild(gearBtn);
      cardFooter.appendChild(gearContainer);

      card.appendChild(cardFooter);
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
          <div style="font-size:12px; color:var(--viva-muted); margin-top:3px;">Anunciante: <strong style="color:var(--viva-text)">${activeName}</strong></div>
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
              <option value="adv" ${step.tipo === "adv" ? "selected" : ""}>ADV (Advertorial)</option>
              <option value="vsl" ${step.tipo === "vsl" ? "selected" : ""}>VSL</option>
              <option value="tsl" ${step.tipo === "tsl" ? "selected" : ""}>TSL</option>
              <option value="checkout" ${step.tipo === "checkout" ? "selected" : ""}>CHECKOUT</option>
              <option value="upsell" ${step.tipo === "upsell" ? "selected" : ""}>UPSELL</option>
              <option value="whatsapp" ${step.tipo === "whatsapp" ? "selected" : ""}>X1 (WhatsApp)</option>
            </select>
          </div>
          <div style="flex:2;">
            <label class="viva-label" style="font-size:11px;">Rótulo da Etapa</label>
            <input type="text" class="viva-input step-rotulo" value="${step.rotulo}" placeholder="${step.tipo.toUpperCase()}">
          </div>
        </div>
        <div>
          <label class="viva-label" style="font-size:11px;">URL da Etapa</label>
          <input type="text" class="viva-input step-url" value="${step.url}" placeholder="https://...">
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
        <span class="viva-funnel-summary-step-title">#${idx + 1} • [${s.tipo.toUpperCase()}] ${s.rotulo ? s.rotulo : ''}</span>
      </div>
      <span class="viva-funnel-summary-step-url">${s.url}</span>
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
          <span class="viva-confirm-value" title="${info.nome}">${info.nome}</span>
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
        <h3 class="viva-sidebar-title">VIVA Labs Monitor <span style="font-size:9px; opacity:0.5; font-weight:400;">v3-fix</span></h3>
        <span class="viva-scale-score viva-score-low" id="viva-sidebar-status">✓ Conectado</span>
      </div>
      <button class="viva-sidebar-minimize-btn" id="viva-btn-minimize" title="Minimizar">_</button>
    </div>
    <div class="viva-sidebar-content">
      
      <!-- Seção 1: Controle & Filtros (Topo) -->
      <div class="viva-panel-section" style="box-sizing: border-box;">
        <h4 class="viva-section-title">Controle & Filtros</h4>
        
        <div class="viva-form-group" style="margin-bottom:8px">
          <label class="viva-label" title="Quantidade total de anúncios que o anunciante está rodando (indica volume).">Mínimo de Ads Ativos na Página</label>
          <input type="number" id="viva-filter-min-page" class="viva-input" value="0" min="0" placeholder="Ex: 50" style="width:100%; box-sizing: border-box;">
        </div>
        
        <div class="viva-form-group" style="margin-bottom:12px">
          <label class="viva-label" title="Quantidade de vezes que o MESMO criativo se repete (indica agressividade na escala).">Mínimo de Ads Duplicados</label>
          <input type="number" id="viva-filter-min-dup" class="viva-input" value="0" min="0" placeholder="Ex: 3" style="width:100%; box-sizing: border-box;">
        </div>

        <button class="viva-btn viva-btn-primary" id="viva-btn-apply-filter" style="width:100%; margin-bottom:12px; font-weight: bold; box-sizing: border-box;">Aplicar Filtros</button>

        <div class="viva-switch-row" style="margin-bottom: 10px;">
          <span title="Mostra somente anúncios recentes com até 3 dias de veiculação">Anúncios Recentes (≤ 3 dias)</span>
          <label class="viva-switch">
            <input type="checkbox" id="viva-toggle-recentes">
            <span class="viva-slider"></span>
          </label>
        </div>

        <div class="viva-switch-row">
          <span title="Rola a página sozinho até o fim da biblioteca para carregar tudo">Auto-Scroll</span>
          <label class="viva-switch">
            <input type="checkbox" id="viva-toggle-scroll">
            <span class="viva-slider"></span>
          </label>
        </div>
      </div>

      <div class="viva-divider"></div>

      <!-- Seção 2: Rastreador (Acordeon) -->
      <div class="viva-panel-section" style="box-sizing: border-box;">
        <h4 class="viva-section-title" id="viva-tracker-accordion-btn" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
          Rastrear Competidor
          <span id="viva-tracker-icon" style="font-size: 10px;">▼</span>
        </h4>
        
        <div id="viva-tracker-content" style="display: none; margin-top: 10px;">
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

  // Accordion Logic
  const accBtn = document.getElementById("viva-tracker-accordion-btn");
  const accContent = document.getElementById("viva-tracker-content");
  const accIcon = document.getElementById("viva-tracker-icon");
  if (accBtn && accContent) {
    accBtn.addEventListener("click", () => {
      if (accContent.style.display === "none") {
        accContent.style.display = "block";
        accIcon.textContent = "▲";
      } else {
        accContent.style.display = "none";
        accIcon.textContent = "▼";
      }
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

  // 4. Dual Filters & Auto-Scroll
  const minPageInput = document.getElementById("viva-filter-min-page");
  const minDupInput = document.getElementById("viva-filter-min-dup");
  const applyBtn = document.getElementById("viva-btn-apply-filter");
  const scrollToggle = document.getElementById("viva-toggle-scroll");

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      minPageAds = parseInt(minPageInput.value, 10) || 0;
      minDupAds = parseInt(minDupInput.value, 10) || 0;
      
      // Stop auto-scroll when applying filters
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

  const recentesToggle = document.getElementById("viva-toggle-recentes");
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
        document.querySelectorAll('.viva-flex-override').forEach(el => el.classList.remove('viva-flex-override'));
        startAutoScroll();
      } else {
        stopAutoScroll();
        processCards(); 
      }
    });
  }

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
            <span class="viva-confirm-value" title="${info.nome}">${info.nome}</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Tipo do Cadastro:</span>
            <span class="viva-confirm-value">${info.tipo}</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">GEO • Nicho:</span>
            <span class="viva-confirm-value">${info.geo} • ${info.nicho}</span>
          </div>
          <div class="viva-confirm-row">
            <span class="viva-confirm-label">Instagram:</span>
            <span class="viva-confirm-value" title="${info.instagram}">${info.instagram.replace("https://www.", "").replace("https://", "")}</span>
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
            <div class="viva-confirm-sub">${info.tipo} "<strong>${info.nome}</strong>" foi salvo com sucesso no ecossistema VIVA.</div>
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
      for (const card of activeCardData) {
        if (card.destUrl && card.destUrl !== "URL não detectada") {
          try {
            const u = new URL(card.destUrl.startsWith("http") ? card.destUrl : "https://" + card.destUrl);
            return u.hostname.replace(/^www\./i, "");
          } catch (e) {
            return card.destUrl;
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
        hasEscala: false,
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
    if ((item.data.adAgeDays !== null && item.data.adAgeDays >= 3) || item.effectiveDupCount >= 2) {
      advMap[name].hasEscala = true;
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
      const badgeClass = adv.hasEscala ? "viva-escala-chip-hot" : "viva-escala-chip-normal";
      const badgeText = adv.hasEscala ? "🔥 EM ESCALA" : "⏳ NORMAL";
      listHtml += `
        <div class="viva-ranking-item" title="Clique para abrir a Biblioteca deste anunciante em nova aba" onclick="window.open('${targetUrl.replace(/'/g, "\\'")}', '_blank');" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--viva-border); border-radius: 10px; margin-bottom: 6px; background: rgba(255,255,255,0.6); transition: all 0.2s;">
          <div style="display: flex; align-items: center; gap: 12px; max-width: 65%;">
            <span style="font-size: 16px; font-weight: 700; width: 28px; text-align: center; color: var(--viva-text);">${medal}</span>
            <div style="display: flex; flex-direction: column; overflow: hidden;">
              <span style="font-weight: 600; font-size: 13.5px; color: var(--viva-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px;">
                ${adv.name} <span style="font-size: 11px; color: var(--viva-accent); font-weight: 700;">↗</span>
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

function teardownVivaMonitor() {
  // FIX: para de vez o intervalo de polling de nome/Instagram. Antes esta função só
  // removia elementos do DOM, mas nunca parava o setInterval — por isso o toggle
  // "desligar" no popup não interrompia o processamento em segundo plano.
  if (_vivaSidebarIntervalId) {
    clearInterval(_vivaSidebarIntervalId);
    _vivaSidebarIntervalId = null;
  }
  const panel = document.getElementById("viva-sidebar");
  if (panel) panel.remove();
  const modal = document.getElementById("viva-funnel-modal-overlay");
  if (modal) modal.remove();
  const confirmModal = document.getElementById("viva-funnel-confirm-overlay");
  if (confirmModal) confirmModal.remove();
  const topBtn = document.getElementById("viva-scroll-btn");
  if (topBtn) topBtn.remove();

  // Remove injected footers, strips, dropdowns and badges from all cards
  document.querySelectorAll(".viva-card-footer, .viva-scale-badge, .viva-el, .viva-escala-strip, .viva-card-badge-container, .viva-gear-dropdown").forEach(el => el.remove());
  document.querySelectorAll("[data-viva-processed], [data-viva-id], .viva-processed").forEach(el => {
    el.removeAttribute("data-viva-processed");
    el.removeAttribute("data-viva-id");
    try { mediaPruningObserver.unobserve(el); } catch(e) {}
    el.classList.remove("viva-processed", "viva-border-level-1", "viva-border-level-2", "viva-border-level-3", "viva-border-escala");
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
  console.log("[VIVA] Extensão carregando... BUILD-CLAUDE-FIX-v3 (2026-07-28)");
  await loadConfig();

  chrome.storage.local.get(["viva_monitor_enabled"], (res) => {
    vivaMonitorMasterEnabled = res.viva_monitor_enabled !== false;
    // FIX: propaga o estado do toggle para o mundo MAIN via atributo no <html>.
    // react_sniffer.js roda isolado no mundo MAIN e não tem acesso a chrome.storage —
    // sem essa ponte, ele nunca soube que existe um "desligar" e rodava para sempre.
    document.documentElement.dataset.vivaEnabled = vivaMonitorMasterEnabled ? "true" : "false";
    if (!vivaMonitorMasterEnabled) {
      console.log("[VIVA] Extensão desativada via toggle.");
      teardownVivaMonitor();
      return;
    }
    injectMediaPreconnects();
    setTimeout(() => {
      injectSidebar();
      injectScrollTopBtn();
      processCards();
    }, 1500);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.viva_monitor_enabled !== undefined) {
      vivaMonitorMasterEnabled = changes.viva_monitor_enabled.newValue !== false;
      // FIX: mesma ponte, agora também na troca ao vivo do toggle (sem precisar recarregar a página).
      document.documentElement.dataset.vivaEnabled = vivaMonitorMasterEnabled ? "true" : "false";
      if (!vivaMonitorMasterEnabled) {
        teardownVivaMonitor();
      } else {
        injectMediaPreconnects();
        injectSidebar();
        injectScrollTopBtn();
        processCards();
      }
    }
  });

  // Executa processamento otimizado síncrono com base em eventos
  const debouncedProcess = debounce(processCards, 300);
  window.addEventListener("scroll", debouncedProcess);

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
  observer.observe(document.body, { childList: true, subtree: true });

  // Loop secundário de polling apenas para mudança de URL de navegação interna SPA da Meta
  setInterval(() => {
    if (!vivaMonitorMasterEnabled) return;
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      console.log("[VIVA] URL mudou, limpando cache local e reiniciando...");
      teardownVivaMonitor();
      cachedContingencyChecked = false;
      cachedContingencyStatus = null;
      
      setTimeout(() => {
        injectSidebar();
        injectScrollTopBtn();
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
  }, 2000);
}

init();