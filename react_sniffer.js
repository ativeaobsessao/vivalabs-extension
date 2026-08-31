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

  // FIX PERF/ITEM 6 (2026-08): stampa um único card — usada tanto pelo evento sob demanda
  // quanto pelo MutationObserver/safety-net abaixo. Isolada aqui para não duplicar a lógica
  // de leitura do fiber em três lugares diferentes.
  function stampCardIfPossible(card) {
    if (!card || card.hasAttribute("data-viva-page-id")) return;
    const fiber = getReactFiber(card);
    if (!fiber) return;
    const pageId = findPageIdInFiber(fiber);
    if (pageId) {
      card.setAttribute("data-viva-page-id", pageId);
    }
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

  // FIX PERF/ITEM 6 — CAUSA RAIZ DA LENTIDÃO REPORTADA (2026-08):
  // A versão anterior rodava, para SEMPRE, a cada 2.5s:
  //   document.querySelectorAll("div[class*='_9b9']:not(...), div[class*='x1y1aw1k']:not(...)")
  // Seletores de atributo por SUBSTRING ([class*='...']) não têm nenhum atalho de indexação no
  // motor de CSS do navegador — ele é obrigado a checar o atributo class de CADA nó do DOM,
  // sempre, mesmo que 99% deles não sejam sequer cartões de anúncio (essas classes ofuscadas da
  // Meta aparecem espalhadas pela página inteira, não só nos cards). Numa busca com rolagem
  // infinita e milhares de nós acumulados no DOM, isso é uma varredura O(tamanho inteiro do DOM)
  // rodando sem parar, na MESMA aba onde o operador está clicando em "Ver Anúncios da Página" —
  // é essa contenção de thread principal que trava/atrasa até a abertura de uma nova aba.
  //
  // Correção: troca a fonte de "quais nós escanear" de classes ofuscadas e frágeis da Meta
  // (que também podem mudar a qualquer deploy — risco documentado) para a classe própria da
  // VIVA (.viva-processed), aplicada pelo content.js SOMENTE nos nós que ele já confirmou
  // estruturalmente serem cards de anúncio reais (texto "Patrocinado/Sponsored" + mídia). Um
  // seletor de classe exata é indexado nativamente pelo navegador (bucket lookup), então mesmo
  // reconsultá-lo é barato — mas o ganho real vem de trocar POLLING por REAÇÃO: um
  // MutationObserver com attributeFilter:['class'] só executa trabalho quando um class muda de
  // verdade (O(mutações), não O(tamanho do DOM)), então fica ocioso entre cliques/scrolls em vez
  // de varrer a página inteira a cada 2.5s incondicionalmente.
  function handleClassMutations(mutations) {
    if (document.documentElement.dataset.vivaEnabled === "false") return;
    for (const m of mutations) {
      const el = m.target;
      if (el && el.nodeType === 1 && el.classList && el.classList.contains("viva-processed")) {
        stampCardIfPossible(el);
      }
    }
  }

  const classObserver = new MutationObserver(handleClassMutations);
  classObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
    subtree: true
  });

  // Safety-net: cobre o caso raro de um card ganhar a classe antes deste script terminar de
  // registrar o observer (corrida no boot), ou qualquer mutação perdida. Seletor de classe
  // exata (.viva-processed) é barato mesmo em varredura — nada a ver em custo com o antigo
  // seletor de substring — e o batch pequeno mantém o teto de custo previsível mesmo em telas
  // com dezenas de milhares de cards acumulados.
  function safetyNetScan() {
    if (document.documentElement.dataset.vivaEnabled === "false") return;
    const cards = document.querySelectorAll(".viva-processed:not([data-viva-page-id])");
    if (cards.length === 0) return;
    const batch = Array.from(cards).slice(0, 15);
    batch.forEach(stampCardIfPossible);
  }

  // Frequência bem menor que o polling original (2.5s → 8s) porque agora é só uma rede de
  // segurança, não o mecanismo principal — o MutationObserver acima cobre o caso comum.
  setInterval(safetyNetScan, 8000);
})();