// VIVA Labs Helper - Social Profiles Shortcut Injector

// AUDITORIA #11: até aqui, o setInterval no fim deste arquivo rodava incondicionalmente, sem
// nenhuma checagem do toggle "Desativar" do popup — desligar a extensão lá não impedia a
// injeção destes botões em Instagram/Facebook. Este content script roda ISOLADO do content.js
// (matches diferentes no manifest.json: instagram.com/facebook.com vs. .../ads/library/*), então
// não compartilha a variável vivaMonitorMasterEnabled em memória — precisa ler chrome.storage
// por conta própria, no mesmo padrão usado em init() do content.js: lê o valor salvo uma vez ao
// carregar, e assina chrome.storage.onChanged para reagir ao vivo sem precisar recarregar a página.
let vivaSocialMasterEnabled = true;

chrome.storage.local.get(["viva_monitor_enabled"], (res) => {
  vivaSocialMasterEnabled = res.viva_monitor_enabled !== false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.viva_monitor_enabled !== undefined) {
    vivaSocialMasterEnabled = changes.viva_monitor_enabled.newValue !== false;
    // Desligou agora: remove qualquer botão já injetado, não só impede novos. Sem isso, um
    // botão injetado ANTES do toggle ser desligado continuaria na tela até a página recarregar.
    if (!vivaSocialMasterEnabled) {
      const igBtn = document.getElementById("viva-ig-btn");
      if (igBtn) igBtn.remove();
      const fbBtn = document.getElementById("viva-fb-btn");
      if (fbBtn) fbBtn.remove();
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

function injectFacebookButton() {
  if (document.getElementById("viva-fb-btn")) return;

  // O nome do usuário/página normalmente fica no título principal h1
  const pageNameHeader = document.querySelector("h1");
  if (!pageNameHeader) return;

  const pageName = pageNameHeader.textContent.trim();
  if (!pageName) return;

  // Evita rodar na página inicial do feed
  if (window.location.pathname === "/" || window.location.pathname.startsWith("/stories")) return;

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

// Executa em loop pois as redes sociais são SPAs e renderizam o DOM dinamicamente
setInterval(() => {
  if (!vivaSocialMasterEnabled) return;
  if (window.location.hostname.includes("instagram.com")) {
    injectInstagramButton();
  } else if (window.location.hostname.includes("facebook.com")) {
    injectFacebookButton();
  }
}, 2000);