/**
 * VIVA Labs - React Fiber Sniffer (MAIN World)
 * Padrão Ouro do CC SPY: Lê as propriedades em memória do React Fiber.
 */
(function() {
  function getReactFiber(dom) {
    if (!dom) return null;
    const key = Object.keys(dom).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"));
    return dom[key];
  }

  function strVal(v) {
    return v !== null && v !== undefined ? String(v) : null;
  }

  function deepFindPageId(obj, seen = new WeakSet(), depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return null;
    if (seen.has(obj)) return null;
    seen.add(obj);

    const candidates = [
      obj.pageID,
      obj.pageId,
      obj.page_id,
      obj.view_all_page_id,
      obj.advertiser_id,
      obj.actor_id
    ];

    for (const c of candidates) {
      const s = strVal(c);
      if (s && /^\d{10,20}$/.test(s)) return s;
    }

    for (let key in obj) {
      if (key === 'children' || key === '_owner' || key === 'style') continue;
      try {
        const res = deepFindPageId(obj[key], seen, depth + 1);
        if (res) return res;
      } catch (e) {}
    }
    return null;
  }

  function findPageIdInFiber(fiber) {
    let current = fiber;
    let depth = 0;
    while (current && depth < 80) {
      if (current.memoizedProps) {
        const pageId = deepFindPageId(current.memoizedProps);
        if (pageId && /^\d{10,20}$/.test(pageId)) return pageId;
      }
      current = current.return;
      depth++;
    }
    return null;
  }

  // 1. Escuta requisição sob demanda da extensão
  window.addEventListener("vivaGetPageId", (e) => {
    const cardId = e.detail && e.detail.cardId;
    if (!cardId) return;
    const card = document.querySelector(`[data-viva-id="${cardId}"]`);
    if (!card) return;

    const fiber = getReactFiber(card);
    const pageId = fiber ? findPageIdInFiber(fiber) : null;
    if (pageId) {
      card.setAttribute("data-viva-page-id", pageId);
    }

    window.dispatchEvent(new CustomEvent("vivaPageIdResponse", {
      detail: { cardId, pageId }
    }));
  });

  // 2. Auto-stamp contínuo nos cards
  // 2. Auto-stamp leve e otimizado nos cards não processados
  function autoStampCards() {
    // FIX: respeita o toggle liga/desliga da extensão. O content.js (mundo ISOLATED) escreve
    // este atributo no <html> sempre que o estado muda — sem essa checagem, este script MAIN
    // world rodava para sempre, mesmo com a extensão "desligada" no popup, pois scripts MAIN
    // world não têm acesso a chrome.storage para saber o estado do toggle sozinhos.
    if (document.documentElement.dataset.vivaEnabled === "false") return;

    const cards = document.querySelectorAll("div[class*='_9b9']:not([data-viva-page-id]), div[class*='x1y1aw1k']:not([data-viva-page-id])");
    if (cards.length === 0) return;
    const batch = Array.from(cards).slice(0, 15);
    batch.forEach(card => {
      const fiber = getReactFiber(card);
      if (fiber) {
        const pageId = findPageIdInFiber(fiber);
        if (pageId) {
          card.setAttribute("data-viva-page-id", pageId);
        }
      }
    });
  }

  setInterval(autoStampCards, 2500);
})();