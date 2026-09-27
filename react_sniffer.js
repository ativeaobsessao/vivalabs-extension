/**
 * VIVA Labs - React Fiber Sniffer (MAIN World)
 * Padrão Ouro do CC SPY: Lê as propriedades em memória do React Fiber.
 */
(function() {
  // ─── Interceptor Global de Rede (Captura silenciosa de GraphQL / XHR / Fetch) ───
  function formatInstagramUrl(val) {
    if (!val || typeof val !== 'string') return null;
    let s = val.trim();
    if (!s) return null;
    if (s.includes("instagram.com/")) {
      const match = s.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)/i);
      if (match && match[1] && !["p", "reel", "stories", "explore", "about", "developer", "accounts", "direct"].includes(match[1].toLowerCase())) {
        return `https://www.instagram.com/${match[1]}`;
      }
      return s.startsWith("http") ? s : `https://${s}`;
    }
    s = s.replace(/^@/, '');
    if (/^[a-zA-Z0-9_.]{2,40}$/.test(s) && !["null", "undefined", "true", "false", "facebook", "meta", "instagram"].includes(s.toLowerCase())) {
      return `https://www.instagram.com/${s}`;
    }
    return null;
  }

  function deepFindInstagram(obj, seen = new WeakSet(), depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return null;
    if (seen.has(obj)) return null;
    seen.add(obj);

    const candidates = [
      obj.instagram_url,
      obj.instagram_profile,
      obj.instagram_handle,
      obj.instagram_username,
      obj.ig_username,
      obj.ig_handle,
      obj.instagram_account,
      obj.instagramProfile,
      obj.instagramUrl,
      obj.instagramUsername,
      obj.instagram_profile_url,
      obj.instagram_name,
      obj.ig_url,
      obj.instagram_actor_name,
      obj.page_instagram_handle,
      obj.page_instagram_name,
      obj.page_instagram_url,
      obj.instagram_user,
      obj.social_links,
      obj.social_profiles
    ];

    for (const c of candidates) {
      if (c && typeof c === 'string') {
        const formatted = formatInstagramUrl(c);
        if (formatted) return formatted;
      } else if (c && typeof c === 'object') {
        const nested = deepFindInstagram(c, seen, depth + 1);
        if (nested) return nested;
      }
    }

    for (let key in obj) {
      if (key === 'children' || key === '_owner' || key === 'style') continue;
      try {
        const val = obj[key];
        if (typeof val === 'string') {
          if (val.includes("instagram.com/")) {
            const formatted = formatInstagramUrl(val);
            if (formatted) return formatted;
          }
          const lowerKey = key.toLowerCase();
          if ((lowerKey.includes("instagram") || lowerKey.includes("ig_handle") || lowerKey.includes("ig_user")) && val.length > 1 && val.length < 50) {
            const formatted = formatInstagramUrl(val);
            if (formatted) return formatted;
          }
        } else if (typeof val === 'object' && val !== null) {
          const res = deepFindInstagram(val, seen, depth + 1);
          if (res) return res;
        }
      } catch (e) {}
    }
    return null;
  }

  function tryExtractInstagramFromJson(text) {
    if (!text || typeof text !== 'string') return null;
    if (!text.includes("instagram") && !text.includes("ig_")) return null;

    try {
      const urlMatch = text.match(/https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)/i);
      if (urlMatch && urlMatch[1] && !["p", "reel", "stories", "explore", "about", "developer", "accounts", "direct"].includes(urlMatch[1].toLowerCase())) {
        return `https://www.instagram.com/${urlMatch[1]}`;
      }

      const cleanText = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
      const json = JSON.parse(cleanText);
      const found = deepFindInstagram(json);
      if (found) return found;
    } catch (e) {
      const handleMatch = text.match(/"(?:instagram_handle|instagram_username|ig_username|instagram_profile_url|instagram_name)":\s*"([^"]+)"/i);
      if (handleMatch && handleMatch[1]) {
        return formatInstagramUrl(handleMatch[1]);
      }
    }
    return null;
  }

  try {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        clone.text().then(text => {
          const ig = tryExtractInstagramFromJson(text);
          if (ig && !document.documentElement.dataset.vivaDetectedInstagram) {
            document.documentElement.dataset.vivaDetectedInstagram = ig;
            window.dispatchEvent(new CustomEvent("vivaInstagramDetected", { detail: { instagram: ig } }));
          }
        }).catch(() => {});
      } catch (e) {}
      return response;
    };

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._url = url;
      return originalXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener("load", function() {
        try {
          const ig = tryExtractInstagramFromJson(this.responseText);
          if (ig && !document.documentElement.dataset.vivaDetectedInstagram) {
            document.documentElement.dataset.vivaDetectedInstagram = ig;
            window.dispatchEvent(new CustomEvent("vivaInstagramDetected", { detail: { instagram: ig } }));
          }
        } catch (e) {}
      });
      return originalXhrSend.apply(this, args);
    };
  } catch (err) {
    console.warn("[VIVA-SNIFFER] Network hooks bypass:", err);
  }

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

  // FIX PERF/ITEM 6 (2026-08): stampa um único card — usada pelo MutationObserver/safety-net
  // abaixo. Isolada aqui para não duplicar a lógica de leitura do fiber em mais de um lugar.
  function stampCardIfPossible(card) {
    if (!card || card.hasAttribute("data-viva-page-id")) return;
    const fiber = getReactFiber(card);
    if (!fiber) return;
    const pageId = findPageIdInFiber(fiber);
    if (pageId) {
      card.setAttribute("data-viva-page-id", pageId);
    }
  }

  // AUDITORIA #15: a ponte de evento sob demanda "vivaGetPageId" / "vivaPageIdResponse" foi
  // removida. O content.js (mundo ISOLATED) nunca chegou a disparar o CustomEvent
  // "vivaGetPageId" em nenhum ponto do arquivo — ele depende inteiramente do mecanismo
  // contínuo abaixo (MutationObserver reagindo a mudanças de classe + safetyNetScan) para
  // obter data-viva-page-id, o que já cobre 100% dos casos de uso reais. Manter um listener e
  // um dispatchEvent sem nenhum consumidor é código morto puro — não muda comportamento
  // algum remover, e evita a confusão de uma segunda via de acesso "sob demanda" que nunca é
  // usada na prática.

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

  // ─── FIX ITEM 10 (2026-09) — teardown real do MutationObserver e do setInterval ────────────
  // ANTES: o classObserver.observe(...) era chamado uma única vez, incondicionalmente, e o
  // setInterval(safetyNetScan, 8000) também — nenhum dos dois tinha uma referência guardada em
  // variável nem forma de ser desligado. A checagem `dataset.vivaEnabled === "false"` dentro de
  // handleClassMutations()/safetyNetScan() só impedia o TRABALHO PESADO de rodar quando a
  // extensão estava desligada — mas o observer continuava recebendo (e descartando) toda
  // mutação de classe da página, e o setInterval continuava disparando pra sempre a cada 8s,
  // fazendo uma leitura de atributo e voltando a dormir. Como este script roda no mundo MAIN
  // (isolado das variáveis internas de content.js por design — é assim que ele consegue ler o
  // React Fiber da própria Meta), content.js nunca teve uma referência direta a esse observer/
  // timer para poder chamar disconnect()/clearInterval() neles a partir de fora.
  //
  // CORREÇÃO: document.dispatchEvent(CustomEvent) é a ponte real entre os dois mundos — um
  // evento disparado no documento compartilhado é visível por listeners de QUALQUER um dos dois
  // mundos, mesmo que as variáveis JS de cada lado continuem 100% isoladas entre si. content.js
  // agora dispara "viva:mainWorldToggle" (ver notifyMainWorldToggle() em content.js) sempre que
  // o toggle muda de estado; este arquivo escuta esse evento e efetivamente desconecta o
  // observer e limpa o interval quando desligado — e os recria quando religado — em vez de
  // deixá-los girando indefinidamente em modo "quase parado".
  //
  // Guardas idempotentes (vivaClassObserverActive / safetyNetIntervalId) evitam tanto observar
  // duas vezes o mesmo MutationObserver quanto empilhar mais de um setInterval, caso o evento de
  // "ligado" chegue mais de uma vez seguida (ex.: toggle clicado rapidamente).
  let vivaClassObserverActive = false;
  function startClassObserver() {
    if (vivaClassObserverActive) return;
    classObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true
    });
    vivaClassObserverActive = true;
  }
  function stopClassObserver() {
    if (!vivaClassObserverActive) return;
    classObserver.disconnect();
    vivaClassObserverActive = false;
  }

  let safetyNetIntervalId = null;
  function startSafetyNet() {
    if (safetyNetIntervalId) return;
    // Frequência bem menor que o polling original (2.5s → 8s) porque agora é só uma rede de
    // segurança, não o mecanismo principal — o MutationObserver acima cobre o caso comum.
    safetyNetIntervalId = setInterval(safetyNetScan, 8000);
  }
  function stopSafetyNet() {
    if (safetyNetIntervalId) {
      clearInterval(safetyNetIntervalId);
      safetyNetIntervalId = null;
    }
  }

  // Escuta a ponte de content.js: liga/desliga observer + timer de verdade a cada mudança de
  // estado do toggle, em vez de só confiar na checagem estática dentro das próprias funções.
  document.addEventListener("viva:mainWorldToggle", (e) => {
    const enabled = !!(e.detail && e.detail.enabled);
    if (enabled) {
      startClassObserver();
      startSafetyNet();
    } else {
      stopClassObserver();
      stopSafetyNet();
    }
  });

  // Estado inicial: honra o atributo já presente no <html> no exato momento em que este script
  // roda — cobre a corrida em que a extensão já foi desligada ANTES deste script terminar de
  // carregar (nesse caso o evento "viva:mainWorldToggle" pode já ter disparado antes do listener
  // acima existir, e este script não pode depender só dele para decidir seu estado inicial). Se
  // o atributo ainda não existir (primeira carga da página, chrome.storage.local.get de
  // content.js ainda não respondeu), o padrão é "ligado" — mesmo comportamento de sempre.
  if (document.documentElement.dataset.vivaEnabled !== "false") {
    startClassObserver();
    startSafetyNet();
  }
})();