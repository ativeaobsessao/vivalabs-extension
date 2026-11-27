// Viva Spy - Popup Controller Script

document.addEventListener("DOMContentLoaded", () => {
  const apiUrlInput = document.getElementById("apiUrl");
  const saveBtn = document.getElementById("saveBtn");
  const openLibraryBtn = document.getElementById("openLibraryBtn");
  const openMonitorBtn = document.getElementById("openMonitorBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  // Endereço do sistema de monitoramento em uso (o salvo ou o padrão da equipe)
  chrome.storage.local.get("viva_monitor_api_url", (data) => {
    useMonitorUrl(vivaMonitorUrl(data.viva_monitor_api_url));
  });

  function useMonitorUrl(url) {
    apiUrlInput.value = url;
    openMonitorBtn.title = `${url}/dashboard`;
    checkHealth(url);
  }

  // Lê o endereço na hora do clique, para valer mesmo logo depois de trocar.
  openMonitorBtn.addEventListener("click", () => {
    chrome.storage.local.get("viva_monitor_api_url", (data) => {
      chrome.tabs.create({ url: `${vivaMonitorUrl(data.viva_monitor_api_url)}/dashboard` });
    });
  });

  // Salvar Configuração
  saveBtn.addEventListener("click", () => {
    const digitado = apiUrlInput.value.trim();
    if (!digitado) return;
    const lido = vivaMonitorLer(digitado);
    if (!lido) {
      statusDot.className = "status-dot offline";
      statusText.textContent = "Endereço inválido";
      return;
    }
    const url = vivaMonitorUrl(lido);

    chrome.storage.local.set({ "viva_monitor_api_url": url }, () => {
      console.log("Configuração salva:", url);
      useMonitorUrl(url);
      
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

  // ── Radar diário ──────────────────────────────────────────────────────────────────────────
  const radarToggle = document.getElementById("radarToggle");
  const radarKeywords = document.getElementById("radarKeywords");
  const radarCountry = document.getElementById("radarCountry");
  const radarEvery = document.getElementById("radarEvery");
  const radarLang = document.getElementById("radarLang");
  const radarRunBtn = document.getElementById("radarRunBtn");
  const radarStopBtn = document.getElementById("radarStopBtn");
  const radarState = document.getElementById("radarState");

  function horaCurta(ms) {
    const d = new Date(ms);
    const hoje = new Date();
    const hh = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === hoje.toDateString() ? `hoje às ${hh}` : `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${hh}`;
  }

  function desenharRadar(config, state) {
    const c = config || {};
    const s = state || {};
    radarToggle.checked = c.on === true;
    if (document.activeElement !== radarKeywords) radarKeywords.value = c.keywords || "";
    radarCountry.value = c.country || "US";
    radarEvery.value = String(c.everyH || 6);
    radarLang.value = c.language || "en";
    radarState.className = "radar-state";
    radarStopBtn.hidden = s.status !== "running";
    radarRunBtn.disabled = s.status === "running";
    const partes = [];
    if (s.status === "running") partes.push("Rodando agora… as janelinhas abrem e fecham sozinhas.");
    else if (c.on && s.status === "error" && s.lastError) { radarState.classList.add("err"); partes.push(s.lastError); }
    else if (c.on && s.nextRunAt) partes.push(`Ligado · próxima rodada ${horaCurta(s.nextRunAt)}.`);
    else if (c.on) partes.push("Ligado.");
    else partes.push("Desligado. Ao ligar, o Chrome abre janelinhas sozinho, uma por vez.");
    const r = s.lastSummary;
    if (r && s.status !== "running") {
      partes.push(`Última (${horaCurta(r.at)}): ${r.criativos} criativos · ${r.emEscala} em escala · ${r.novos} novos · ${r.subindo} subindo.`);
    }
    radarState.textContent = partes.join(" ");
  }

  function carregarRadar() {
    chrome.storage.local.get(["viva_radar_config", "viva_radar_state"], (data) => {
      desenharRadar(data.viva_radar_config, data.viva_radar_state);
    });
  }

  function salvarRadar() {
    const config = {
      on: radarToggle.checked,
      keywords: radarKeywords.value,
      country: radarCountry.value,
      language: radarLang.value,
      everyH: Number(radarEvery.value) || 6,
    };
    chrome.storage.local.set({ viva_radar_config: config }, () => {
      chrome.runtime.sendMessage({ action: "RADAR_CONFIG_CHANGED" }, () => { void chrome.runtime.lastError; carregarRadar(); });
    });
  }

  radarToggle.addEventListener("change", () => {
    if (radarToggle.checked && !radarKeywords.value.trim()) {
      radarToggle.checked = false;
      radarState.className = "radar-state err";
      radarState.textContent = "Escreva pelo menos uma palavra-chave antes de ligar.";
      return;
    }
    salvarRadar();
  });
  radarKeywords.addEventListener("blur", salvarRadar);
  radarCountry.addEventListener("change", salvarRadar);
  radarEvery.addEventListener("change", salvarRadar);
  radarLang.addEventListener("change", salvarRadar);
  radarRunBtn.addEventListener("click", () => {
    if (!radarKeywords.value.trim()) {
      radarState.className = "radar-state err";
      radarState.textContent = "Escreva pelo menos uma palavra-chave.";
      return;
    }
    if (!radarToggle.checked) radarToggle.checked = true;
    chrome.storage.local.set({
      viva_radar_config: { on: true, keywords: radarKeywords.value, country: radarCountry.value, language: radarLang.value, everyH: Number(radarEvery.value) || 6 },
    }, () => {
      chrome.runtime.sendMessage({ action: "RADAR_RUN_NOW" }, () => { void chrome.runtime.lastError; carregarRadar(); });
    });
  });
  radarStopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "RADAR_STOP_RUN" }, () => { void chrome.runtime.lastError; carregarRadar(); });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.viva_radar_state) carregarRadar();
  });
  carregarRadar();

  // ── Aviso de oferta nova (Discord / Telegram) ───────────────────────────────────────────────
  const notifyTipo = document.getElementById("notifyTipo");
  const notifyWebhook = document.getElementById("notifyWebhook");
  const notifyToken = document.getElementById("notifyToken");
  const notifyChat = document.getElementById("notifyChat");
  const notifyDiscord = document.getElementById("notifyDiscord");
  const notifyTelegram = document.getElementById("notifyTelegram");
  const notifyTestBtn = document.getElementById("notifyTestBtn");
  const notifyState = document.getElementById("notifyState");

  function mostrarCamposNotify() {
    notifyDiscord.hidden = notifyTipo.value !== "discord";
    notifyTelegram.hidden = notifyTipo.value !== "telegram";
    notifyTestBtn.hidden = notifyTipo.value === "off";
  }
  function lerFormNotify() {
    return { tipo: notifyTipo.value, webhook: notifyWebhook.value.trim(), botToken: notifyToken.value.trim(), chatId: notifyChat.value.trim() };
  }
  function salvarNotify(depois) {
    chrome.storage.local.set({ viva_notify_config: lerFormNotify() }, () => { if (depois) depois(); });
  }
  chrome.storage.local.get(["viva_notify_config"], (data) => {
    const c = data.viva_notify_config || {};
    notifyTipo.value = ["discord", "telegram"].includes(c.tipo) ? c.tipo : "off";
    notifyWebhook.value = c.webhook || "";
    notifyToken.value = c.botToken || "";
    notifyChat.value = c.chatId || "";
    mostrarCamposNotify();
  });
  notifyTipo.addEventListener("change", () => { mostrarCamposNotify(); salvarNotify(); });
  [notifyWebhook, notifyToken, notifyChat].forEach(el => el.addEventListener("blur", () => salvarNotify()));
  notifyTestBtn.addEventListener("click", () => {
    notifyState.className = "radar-state";
    notifyState.textContent = "Enviando teste…";
    notifyTestBtn.disabled = true;
    salvarNotify(() => {
      chrome.runtime.sendMessage({ action: "NOTIFY_TEST" }, (resp) => {
        void chrome.runtime.lastError;
        notifyTestBtn.disabled = false;
        if (resp && resp.status === "ok") notifyState.textContent = "✓ Mensagem de teste enviada. Confira no seu canal.";
        else { notifyState.className = "radar-state err"; notifyState.textContent = (resp && resp.error) || "Não consegui enviar o teste."; }
      });
    });
  });

  // ── Planilha automática (XLSX/CSV) ────────────────────────────────────────────────────────
  const exportAuto = document.getElementById("exportAuto");
  const exportFormato = document.getElementById("exportFormato");
  const exportNowBtn = document.getElementById("exportNowBtn");
  const exportState = document.getElementById("exportState");

  function desenharExport(config, estado, acervo) {
    const c = config || {};
    exportAuto.checked = c.auto !== false;
    exportFormato.value = c.formato === "csv" ? "csv" : "xlsx";
    exportState.className = "radar-state";
    const total = Array.isArray(acervo) ? acervo.length : 0;
    const partes = [`Acervo: ${total.toLocaleString("pt-BR")} de 10.000 criativos.`];
    if (c.auto === false) partes.push("Download automático desligado.");
    else partes.push("Baixa sozinho ao chegar em 10.000 (pasta Downloads/VivaSpy).");
    const e = estado || {};
    if (e.lastError && e.lastErrorAt) { exportState.classList.add("err"); partes.push(`Falha no último download: ${e.lastError}`); }
    else if (e.lastAt) partes.push(`Último arquivo: ${horaCurta(e.lastAt)} · ${Number(e.lastCount || 0).toLocaleString("pt-BR")} criativos.`);
    exportState.textContent = partes.join(" ");
  }
  function carregarExport() {
    chrome.storage.local.get(["viva_export_config", "viva_export_state", "viva_acervo"], (data) => {
      desenharExport(data.viva_export_config, data.viva_export_state, data.viva_acervo);
    });
  }
  function salvarExport() {
    chrome.storage.local.set({ viva_export_config: { auto: exportAuto.checked, formato: exportFormato.value } }, carregarExport);
  }
  exportAuto.addEventListener("change", salvarExport);
  exportFormato.addEventListener("change", salvarExport);
  exportNowBtn.addEventListener("click", () => {
    exportNowBtn.disabled = true;
    exportState.className = "radar-state";
    exportState.textContent = "Gerando arquivo…";
    chrome.runtime.sendMessage({ action: "EXPORT_NOW" }, (resp) => {
      void chrome.runtime.lastError;
      exportNowBtn.disabled = false;
      if (resp && resp.status === "ok") carregarExport();
      else { exportState.className = "radar-state err"; exportState.textContent = (resp && resp.error) || "Não consegui baixar agora."; }
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.viva_export_state || changes.viva_acervo)) carregarExport();
  });
  carregarExport();

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