// Reconhece o link de um post viral (TikTok, Instagram, YouTube Shorts) e padroniza a URL.
// Usado pelo cartão da página e pelo background. As mesmas regras existem no servidor (viral-posts.js).

const VIRAL_REDES = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube Shorts" };

function viralParseUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch (error) { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const path = url.pathname;

  if (host === "tiktok.com") {
    const video = path.match(/^\/@([\w.-]+)\/(video|photo)\/(\d+)/);
    return video ? { plataforma: "tiktok", url: `https://www.tiktok.com/@${video[1]}/${video[2]}/${video[3]}`, autor: video[1] } : null;
  }
  if (host === "instagram.com") {
    const post = path.match(/^\/(?:([\w.]+)\/)?(?:p|reel|reels|tv)\/([\w-]+)/);
    if (!post || post[2] === "audio") return null;
    return { plataforma: "instagram", url: `https://www.instagram.com/p/${post[2]}/`, autor: post[1] || null };
  }
  if (host === "youtube.com") {
    // Só Shorts: vídeo longo aberto no YouTube não é salvo sem querer.
    const shorts = path.match(/^\/shorts\/([\w-]{6,20})/);
    return shorts ? { plataforma: "youtube", url: `https://www.youtube.com/shorts/${shorts[1]}`, autor: null } : null;
  }
  return null;
}

// Feeds em que o endereço não diz qual post está na tela.
function viralIsFeed(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch (error) { return false; }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const path = url.pathname.replace(/\/+$/, "").replace(/^\/[a-z]{2}(-[A-Za-z]{2,4})?(?=\/|$)/, "");
  if (host === "tiktok.com") return ["", "/foryou", "/following", "/friends"].includes(path);
  if (host === "instagram.com") return path === "";
  return false;
}
