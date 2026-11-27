// Descobre qual post está no meio da tela num feed (usado pelo cartão da página).
// Na dúvida devolve null: é melhor não salvar do que salvar o post errado.
function viralFindPostOnScreen() {
  const centro = innerHeight / 2;
  const alturaVisivel = el => {
    const r = el.getBoundingClientRect();
    const cruzaCentro = r.top <= centro && r.bottom >= centro && r.width > 0 && r.right > 0 && r.left < innerWidth;
    return cruzaCentro ? Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) : 0;
  };
  const maisVisivel = seletor => Array.from(document.querySelectorAll(seletor))
    .map(el => ({ el, altura: alturaVisivel(el) }))
    .filter(item => item.altura > 0)
    .sort((a, b) => b.altura - a.altura)[0]?.el || null;

  const tiktok = /(^|\.)tiktok\.com$/.test(location.hostname);
  const instagram = /(^|\.)instagram\.com$/.test(location.hostname);
  let no = instagram ? maisVisivel("article") : maisVisivel("video");
  const publicacao = no;
  let idSozinho = null;
  const perfisEm = raiz => new Set(Array.from(raiz.querySelectorAll('a[href*="/@"]'))
    .map(link => link.pathname.match(/^\/@([\w.-]+)\/?$/)?.[1]).filter(Boolean));
  const tiktokPorId = (autor, id) => ({ url: `https://www.tiktok.com/@${autor}/video/${id}`, autor });

  for (let nivel = 0; no && no !== document.body && nivel < 14; nivel++, no = no.parentElement) {
    const posts = new Map();
    for (const link of no.querySelectorAll("a[href]")) {
      const achado = tiktok
        ? link.pathname.match(/^\/@([\w.-]+)\/(?:video|photo)\/(\d+)/)
        : link.pathname.match(/^\/(?:[\w.]+\/)?(?:p|reel)\/([\w-]+)/);
      if (achado) posts.set(tiktok ? achado[2] : achado[1], link.href);
    }
    if (posts.size > 1) return null;
    if (posts.size === 1) {
      const autor = instagram
        ? no.querySelector("header a[href]")?.pathname.match(/^\/([\w.]+)\/$/)?.[1] || null
        : null;
      return { url: posts.values().next().value, autor };
    }
    if (tiktok) {
      // No "Para você" o TikTok nem sempre põe o link: o id do vídeo vem no player.
      const ids = new Set();
      for (const el of [no, ...no.querySelectorAll('[id^="xgwrapper-"]')]) {
        const id = /^xgwrapper-\d+-(\d{15,})$/.exec(el.id || "");
        if (id) ids.add(id[1]);
      }
      const perfis = perfisEm(no);
      if (ids.size > 1) break; // subiu até a lista: já passou da publicação
      if (ids.size === 1) {
        idSozinho = ids.values().next().value;
        if (perfis.size === 1) return tiktokPorId(perfis.values().next().value, idSozinho);
      }
    }
  }
  if (!tiktok || !idSozinho) return null;
  // Layout em coluna: o perfil do vídeo da tela fica numa camada por cima, fora da publicação.
  const camadas = document.querySelectorAll('[data-e2e="anchoring-description-layer"]');
  if (camadas.length !== 1) return null;
  const camada = camadas[0].getBoundingClientRect();
  const meio = (camada.top + camada.bottom) / 2;
  const caixa = publicacao.closest("article")?.getBoundingClientRect() || publicacao.getBoundingClientRect();
  if (!camada.height || meio < caixa.top || meio > caixa.bottom) return null;
  const donos = perfisEm(camadas[0]);
  return donos.size === 1 ? tiktokPorId(donos.values().next().value, idSozinho) : null;
}
