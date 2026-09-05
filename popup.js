// VIVA Labs Helper - Popup Controller Script

document.addEventListener("DOMContentLoaded", () => {
  const apiUrlInput = document.getElementById("apiUrl");
  const saveBtn = document.getElementById("saveBtn");
  const openLibraryBtn = document.getElementById("openLibraryBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  // Carrega a URL da API salva anteriormente
  chrome.storage.local.get("viva_monitor_api_url", (data) => {
    if (data.viva_monitor_api_url) {
      apiUrlInput.value = data.viva_monitor_api_url;
      checkHealth(data.viva_monitor_api_url);
    } else {
      // Define padrão inicial se estiver vazio
      apiUrlInput.value = "https://viva-labs-monitor.onrender.com";
      checkHealth("https://viva-labs-monitor.onrender.com");
    }
  });

  // Salvar Configuração
  saveBtn.addEventListener("click", () => {
    let url = apiUrlInput.value.trim();
    if (!url) return;

    // Remove barra invertida do final se houver
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }

    chrome.storage.local.set({ "viva_monitor_api_url": url }, () => {
      console.log("Configuração salva:", url);
      checkHealth(url);
      
      // Feedback temporário no botão
      const originalText = saveBtn.textContent;
      saveBtn.textContent = "Salvo!";
      saveBtn.style.backgroundColor = "#34c759";
      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.backgroundColor = "#007aff";
      }, 1500);
    });
  });

  // Abrir Meta Ad Library
  openLibraryBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.facebook.com/ads/library/?active_status=active" });
  });

  // Controle de Ativação/Desativação da Extensão (Apple iOS Toggle)
  const masterToggle = document.getElementById("vivaMasterToggle");
  const toggleLabel = document.getElementById("toggleStateLabel");

  chrome.storage.local.get(["viva_monitor_enabled"], (data) => {
    const isEnabled = data.viva_monitor_enabled !== false;
    if (masterToggle) masterToggle.checked = isEnabled;
    if (toggleLabel) {
      toggleLabel.textContent = isEnabled ? "Ativado" : "Desativado";
      toggleLabel.style.color = isEnabled ? "#34c759" : "#86868b";
    }
  });

  if (masterToggle) {
    masterToggle.addEventListener("change", () => {
      const checked = masterToggle.checked;
      chrome.storage.local.set({ "viva_monitor_enabled": checked }, () => {
        if (toggleLabel) {
          toggleLabel.textContent = checked ? "Ativado" : "Desativado";
          toggleLabel.style.color = checked ? "#34c759" : "#86868b";
        }
      });
    });
  }

  // AUDITORIA #24: Verifica a saúde da API do Monitor. Antes, esta função fazia um fetch()
  // simples sem AbortController nem timeout — se o backend (Render.com, plano free) estivesse
  // hibernado, o popup ficava preso em "Verificando..." por dezenas de segundos, sem nenhum
  // feedback intermediário, inconsistente com o cuidado já tomado em content.js
  // (fetchMonitoredPages) para exatamente o mesmo endpoint/servidor. Agora usa AbortController
  // com 5000ms de timeout, no mesmo padrão de content.js, e diferencia "tempo esgotado" de
  // outros erros de rede para dar um feedback mais preciso ao usuário.
  async function checkHealth(apiUrl) {
    statusDot.className = "status-dot";
    statusText.textContent = "Verificando...";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let timedOut = false;

    try {
      const response = await fetch(`${apiUrl}/api/healthz`, {
        method: "GET",
        signal: controller.signal
      });
      const data = await response.json();
      if (data.status === "ok") {
        statusDot.className = "status-dot online";
        statusText.textContent = "Monitor Ativo";
      } else {
        statusDot.className = "status-dot offline";
        statusText.textContent = "Status Inválido";
      }
    } catch (err) {
      // AbortError é disparado tanto por timeout quanto por um abort manual — como só
      // abortamos via setTimeout aqui, distinguir por timedOut deixa a mensagem mais precisa
      // para o caso comum (backend hibernado no plano free) sem inventar falsos positivos.
      timedOut = err.name === "AbortError";
      statusDot.className = "status-dot offline";
      statusText.textContent = timedOut ? "Tempo esgotado (backend hibernado?)" : "Sem Conexão";
    } finally {
      clearTimeout(timeoutId);
    }
  }
});