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

  // Verifica a saúde da API do Monitor
  async function checkHealth(apiUrl) {
    statusDot.className = "status-dot";
    statusText.textContent = "Verificando...";

    try {
      const response = await fetch(`${apiUrl}/api/healthz`, { method: "GET" });
      const data = await response.json();
      if (data.status === "ok") {
        statusDot.className = "status-dot online";
        statusText.textContent = "Monitor Ativo";
      } else {
        statusDot.className = "status-dot offline";
        statusText.textContent = "Status Inválido";
      }
    } catch (err) {
      statusDot.className = "status-dot offline";
      statusText.textContent = "Sem Conexão";
    }
  }
});