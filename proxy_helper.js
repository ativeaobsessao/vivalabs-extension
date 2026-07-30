// VIVA Labs Helper - ProxySite Helper Script

// Função para extrair o domínio principal de uma URL
function getRootDomain(url) {
  try {
    let hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length > 2) {
      // Retorna penúltimo e último elemento (ex: domain.com ou domain.com.br)
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

// Verifica links de checkout conhecidos no DOM
function scanForCheckouts(domain) {
  const links = document.querySelectorAll("a[href]");
  const checkoutKeywords = [
    "checkout", "pay", "payment", "kiwify", "hotmart", "perfectpay", 
    "payt", "monetizze", "eduzz", "cart", "compra", "adquirir", "oferta"
  ];

  for (const link of links) {
    const href = link.href;
    try {
      const hrefLower = href.toLowerCase();
      // Verifica se o href contém alguma das palavras-chave
      const isCheckout = checkoutKeywords.some(kw => hrefLower.includes(kw));
      
      if (isCheckout && href.startsWith("http")) {
        // Evita salvar links da própria navegação do ProxySite
        if (!href.includes("proxysite.com") && !href.includes(window.location.hostname)) {
          console.log("[PROXY] Checkout detectado:", href);
          // Salva no storage local mapeado para o domínio de origem
          chrome.storage.local.set({ [`checkout_sniffed_${domain}`]: href }, () => {
            console.log(`[PROXY] Salvo checkout para ${domain}`);
          });
          break; // Salva o primeiro encontrado e encerra
        }
      }
    } catch (e) {
      // Ignora URLs inválidas
    }
  }
}

async function handleProxyFlow() {
  const params = new URLSearchParams(window.location.search);
  const vivaUrl = params.get("viva_url");

  if (vivaUrl) {
    // 1. Fase de Redirecionamento Inicial
    const decodedUrl = decodeURIComponent(vivaUrl);
    const domain = getRootDomain(decodedUrl);
    
    if (domain) {
      await chrome.storage.local.set({ "last_proxy_domain": domain });
    }

    // Localiza e preenche o formulário do ProxySite
    const input = document.getElementById("url-address") || document.querySelector("input[name='d']");
    const serverSelect = document.querySelector("select[name='server']");
    const form = input ? input.closest("form") : null;

    if (input && form) {
      input.value = decodedUrl;
      if (serverSelect) {
        serverSelect.value = "us1"; // Define servidor US 1
      }
      console.log("[PROXY] Preenchendo e submetendo URL para:", decodedUrl);
      form.submit();
    }
  } else {
    // 2. Fase de Leitura da Página Navegada (dentro do ProxySite)
    // Tenta obter o último domínio cadastrado
    chrome.storage.local.get("last_proxy_domain", (data) => {
      const domain = data.last_proxy_domain;
      if (domain) {
        console.log("[PROXY] Escaneando a página carregada do domínio:", domain);
        // Aguarda 2 segundos para o conteúdo dinâmico carregar
        setTimeout(() => {
          scanForCheckouts(domain);
        }, 2000);

        // Registra um MutationObserver para capturar conteúdos carregados de forma assíncrona
        const observer = new MutationObserver(() => {
          scanForCheckouts(domain);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
  }
}

// Executa a lógica
handleProxyFlow();