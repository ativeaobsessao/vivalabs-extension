// Viva Spy - Popup Controller Script

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
      saveBtn.style.color = "#fff";
      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.backgroundColor = "";
        saveBtn.style.color = "";
      }, 1500);
    });
  });


  // ── Equipe (cofre compartilhado) ─────────────────────────────────────────────────────────
  const teamName = document.getElementById("teamName");
  const teamCode = document.getElementById("teamCode");
  const teamSaveBtn = document.getElementById("teamSaveBtn");
  const teamState = document.getElementById("teamState");
  const teamHint = document.getElementById("teamHint");

  function renderTeamState(state, configured) {
    teamState.className = "team-state";
    if (!configured) {
      teamState.textContent = "Desligado";
      return;
    }
    if (!state) {
      teamState.textContent = "Conectando…";
      return;
    }
    if (state.error) {
      teamState.classList.add("err");
      teamState.textContent = state.error;
      return;
    }
    if (state.ok) {
      teamState.classList.add("ok");
      const hora = new Date(state.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      teamState.textContent = `Sincronizado às ${hora}`;
      return;
    }
    teamState.textContent = "Conectando…";
  }

  function carregarEquipe() {
    chrome.storage.local.get(["viva_team_name", "viva_team_code", "viva_sync_state"], (data) => {
      teamName.value = data.viva_team_name || "";
      const configured = Boolean(data.viva_team_code);
      teamCode.value = configured ? "••••••••" : "";
      teamCode.dataset.saved = configured ? "1" : "";
      renderTeamState(data.viva_sync_state, configured);
      teamSaveBtn.textContent = configured ? "Sincronizar agora" : "Conectar à equipe";
    });
  }
  carregarEquipe();

  teamCode.addEventListener("focus", () => {
    if (teamCode.dataset.saved === "1" && teamCode.value.startsWith("•")) teamCode.value = "";
  });

  teamSaveBtn.addEventListener("click", () => {
    const nome = teamName.value.trim();
    const digitado = teamCode.value.trim();
    const jaSalvo = teamCode.dataset.saved === "1" && (!digitado || digitado.startsWith("•"));
    if (!jaSalvo && digitado.length < 8) {
      teamState.className = "team-state err";
      teamState.textContent = "Digite o código da equipe";
      return;
    }
    if (!nome) {
      teamState.className = "team-state err";
      teamState.textContent = "Digite seu nome";
      return;
    }
    teamSaveBtn.disabled = true;
    teamState.className = "team-state";
    teamState.textContent = "Sincronizando…";
    const gravar = jaSalvo
      ? chrome.storage.local.set({ viva_team_name: nome })
      : chrome.storage.local.set({ viva_team_name: nome, viva_team_code: digitado });
    gravar.then(() => chrome.runtime.sendMessage({ action: jaSalvo ? "TEAM_SYNC_NOW" : "TEAM_CONFIG_CHANGED" }))
      .then((resp) => {
        teamSaveBtn.disabled = false;
        carregarEquipe();
        if (resp && resp.state && resp.state.error) {
          teamHint.textContent = "Confira o código com quem criou a equipe.";
        } else {
          teamHint.textContent = "Pronto: o Centro de Inteligência agora é compartilhado.";
        }
      })
      .catch((err) => {
        teamSaveBtn.disabled = false;
        teamState.className = "team-state err";
        teamState.textContent = String(err && err.message ? err.message : err).slice(0, 80);
      });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.viva_sync_state || changes.viva_team_code)) carregarEquipe();
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