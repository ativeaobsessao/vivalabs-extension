// VIVA Labs Helper - Social Profiles Shortcut Injector

// FIX ITEM 5 (2026-08): este script nunca lia chrome.storage — "Desligar Monitoramento VIVA"
// no popup só cortava o content.js (Ad Library), nunca este arquivo. Resultado: o botão "Ads
// Library" continuava sendo injetado em qualquer aba de Instagram/Facebook, e o setInterval de
// varredura (ver final do arquivo) continuava rodando para sempre, mesmo com a extensão
// "desligada" — o nome do toggle prometia mais do que entregava. Agora o estado é lido de
// chrome.storage.local no boot e mantido atualizado ao vivo via chrome.storage.onChanged,
// exatamente como content.js já faz para vivaMonitorMasterEnabled.
let vivaSocialHelperEnabled = true;

// FIX ITEM 8 (2026-08): antes, mesmo desligado, o setInterval(..., 2000) continuava disparando
// pra sempre — o toggle só fazia o CORPO da função virar no-op (if (!enabled) return), mas o
// timer em si nunca parava de acordar o motor JS a cada 2s, em QUALQUER aba de Instagram/
// Facebook aberta, por horas. Agora o toggle desligado realmente dá clearInterval() — zero
// timer rodando, não só zero trabalho — e religar recria o interval do zero.
let socialHelperIntervalId = null;

function loadToggleState() {
  chrome.storage.local.get(["viva_monitor_enabled"], (res) => {
    vivaSocialHelperEnabled = res.viva_monitor_enabled !== false;
    if (vivaSocialHelperEnabled) {
      startSocialHelperLoop();
    }
  });
}
loadToggleState();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.viva_monitor_enabled !== undefined) {
    vivaSocialHelperEnabled = changes.viva_monitor_enabled.newValue !== false;
    if (!vivaSocialHelperEnabled) {
      stopSocialHelperLoop();
      // Remove qualquer botão já injetado nesta aba imediatamente — sem esperar o próximo
      // ciclo (que agora nem existe mais enquanto desligado), e sem exigir recarregar a página.
      const igBtn = document.getElementById("viva-ig-btn");
      if (igBtn) igBtn.remove();
      const fbBtn = document.getElementById("viva-fb-btn");
      if (fbBtn) fbBtn.remove();
    } else {
      startSocialHelperLoop();
    }
  }
});

function injectInstagramButton() {
  // Verifica se já injetamos o botão
  if (document.getElementById("viva-ig-btn")) return;

  // Seletor para o cabeçalho do perfil do Instagram (nome de usuário)
  // O nome do usuário normalmente fica em um h2
  const usernameHeader = document.querySelector("header h2");
  if (!usernameHeader) return;

  const username = usernameHeader.textContent.trim();
  if (!username) return;

  // Cria o botão estilo Apple / Instagram
  const button = document.createElement("button");
  button.id = "viva-ig-btn";
  button.type = "button";
  button.style.marginLeft = "12px";
  button.style.backgroundColor = "transparent";
  button.style.border = "1px solid #dbdbdb";
  button.style.color = "#262626";
  button.style.borderRadius = "8px";
  button.style.padding = "5px 12px";
  button.style.fontSize = "14px";
  button.style.fontWeight = "600";
  button.style.cursor = "pointer";
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.gap = "6px";
  button.style.transition = "background-color 0.2s";

  // Ícone de link SVG minimalista
  button.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
    Ads Library
  `;

  button.addEventListener("click", () => {
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&q=${encodeURIComponent(username)}&search_type=keyword_unordered`;
    window.open(searchUrl, "_blank");
  });

  // Insere o botão ao lado do nome do usuário
  usernameHeader.parentElement.appendChild(button);
  console.log("[SOCIAL] Botão injetado no perfil do Instagram de:", username);
}

// FIX ITEM 7 (2026-08): injectFacebookButton() usava document.querySelector("h1") puro — o
// Facebook tem <h1> em dezenas de tipos de página (Marketplace, Grupos, Watch, Reels, Gaming,
// Eventos, etc.), então o botão "Ads Library" podia grudar em QUALQUER h1 da aba, sem relação
// nenhuma com um perfil/página de anunciante. Sem depender de classes CSS ofuscadas da Meta
// (frágeis — ver item 6, mesmo problema já corrigido em react_sniffer.js), a checagem abaixo
// usa só a FORMA da URL: uma página/perfil "raiz" do Facebook é sempre um único segmento de
// path (facebook.com/NomeDaPagina ou facebook.com/profile.php?id=...) — nunca mais que isso.
// Isso exclui naturalmente sub-abas (posts, fotos, "sobre") E, com a lista explícita abaixo,
// as seções de primeiro nível que TAMBÉM são só 1 segmento mas não são páginas de anunciante.
const FB_NON_PAGE_TOP_LEVEL_PATHS = [
  "marketplace", "groups", "watch", "reels", "gaming", "events",
  "notifications", "messages", "settings", "help", "ads", "business",
  "stories", "live", "games", "pages", "bookmarks", "menu", "friends",
  "photo.php", "photo", "video.php", "login", "recover", "policies"
];

function isLikelyFacebookPageOrProfileRoot() {
  const path = window.location.pathname;
  if (path === "/" || path.startsWith("/stories")) return false;

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;

  const first = segments[0].toLowerCase();
  if (FB_NON_PAGE_TOP_LEVEL_PATHS.includes(first)) return false;

  // "profile.php" é a exceção que legitimamente tem um segundo nível (?id=...) fazendo parte
  // da identificação do perfil, não de uma sub-aba — todo o resto com mais de 1 segmento
  // (posts, fotos, "sobre", reviews...) não é o cabeçalho principal da página/perfil.
  if (segments.length > 1 && first !== "profile.php") return false;

  return true;
}

function injectFacebookButton() {
  if (document.getElementById("viva-fb-btn")) return;
  if (!isLikelyFacebookPageOrProfileRoot()) return;

  // O nome do usuário/página normalmente fica no título principal h1
  const pageNameHeader = document.querySelector("h1");
  if (!pageNameHeader) return;

  const pageName = pageNameHeader.textContent.trim();
  if (!pageName) return;

  const button = document.createElement("button");
  button.id = "viva-fb-btn";
  button.style.marginLeft = "16px";
  button.style.backgroundColor = "#e4e6eb";
  button.style.border = "none";
  button.style.color = "#050505";
  button.style.borderRadius = "8px";
  button.style.padding = "6px 12px";
  button.style.fontSize = "14px";
  button.style.fontWeight = "600";
  button.style.cursor = "pointer";
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.gap = "6px";
  button.style.verticalAlign = "middle";

  button.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
    Ads Library
  `;

  button.addEventListener("click", () => {
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&q=${encodeURIComponent(pageName)}&search_type=keyword_unordered`;
    window.open(searchUrl, "_blank");
  });

  pageNameHeader.appendChild(button);
  console.log("[SOCIAL] Botão injetado na página do Facebook de:", pageName);
}

// FIX ITEM 8: start/stop reais do loop, amarrados ao toggle mestre — não mais um setInterval
// único e incondicional criado na carga do script.
function startSocialHelperLoop() {
  if (socialHelperIntervalId) return; // já rodando, evita duplicar o timer
  socialHelperIntervalId = setInterval(() => {
    if (window.location.hostname.includes("instagram.com")) {
      injectInstagramButton();
    } else if (window.location.hostname.includes("facebook.com")) {
      injectFacebookButton();
    }
  }, 2000);
}

function stopSocialHelperLoop() {
  if (socialHelperIntervalId) {
    clearInterval(socialHelperIntervalId);
    socialHelperIntervalId = null;
  }
}