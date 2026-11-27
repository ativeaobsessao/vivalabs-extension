// Um clique no ícone: se a aba é um post (TikTok, Instagram, YouTube Shorts), salva na hora.
document.addEventListener("DOMContentLoaded", () => {
  const box = document.getElementById("viralBox");
  const title = document.getElementById("viralTitle");
  const detail = document.getElementById("viralDetail");
  const undoBtn = document.getElementById("viralUndoBtn");
  const JOBS_KEY = "viva_viral_jobs";
  let jobId = null;

  function show(kind, texto, sub = "", desfazer = false) {
    box.hidden = false;
    box.dataset.kind = kind;
    title.textContent = texto;
    detail.textContent = sub;
    undoBtn.hidden = !desfazer;
  }

  function renderJob(job) {
    if (!job) return;
    const quem = `${VIRAL_REDES[job.plataforma]}${job.autor ? " · @" + job.autor : ""}`;
    if (job.status === "salvo") {
      return show("ok", job.podeDesfazer ? "Salvo no Nutra Monitor ✓" : "Esse post já estava salvo ✓", quem, job.podeDesfazer);
    }
    if (job.status === "pendente") {
      if (job.cancelar) return show("wait", "Desfazendo…", quem);
      return job.erro
        ? show("wait", "Na fila, tentando de novo sozinho", job.erro, true)
        : show("wait", "Salvando no Nutra Monitor…", `${quem} · pode fechar`, true);
    }
    if (job.status === "removendo") return show("wait", "Desfazendo…", job.erro || quem);
    if (job.status === "desfeito") return show("off", "Desfeito. O post não ficou salvo.", quem);
    if (job.status === "mantido") return show("ok", "Esse post já estava salvo antes", "Não foi apagado.");
    return show("err", "Não salvou", job.erro || quem);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[JOBS_KEY] && jobId) {
      renderJob((changes[JOBS_KEY].newValue || []).find(job => job.id === jobId));
    }
  });

  undoBtn.addEventListener("click", () => {
    undoBtn.hidden = true;
    chrome.runtime.sendMessage({ action: "VIRAL_UNDO", id: jobId });
  });

  async function postFromTab(tab) {
    const direto = viralParseUrl(tab.url);
    if (direto) return direto;
    if (!viralIsFeed(tab.url)) return null;
    try {
      const [injecao] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: viralFindPostOnScreen });
      const achado = injecao?.result && viralParseUrl(injecao.result.url);
      if (achado) return { ...achado, autor: achado.autor || injecao.result.autor };
    } catch (error) {
      console.warn("Não foi possível ler a aba:", error.message);
    }
    show("off", "Abra o post para salvar", "Não deu para saber qual post está na tela. Clique nele e depois no ícone.");
    return null;
  }

  async function saveCurrentPost() {
    chrome.action?.setBadgeText?.({ text: "" });
    const { viva_monitor_enabled: ligado } = await chrome.storage.local.get("viva_monitor_enabled");
    if (ligado === false) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const post = await postFromTab(tab);
    if (!post) return;
    show("wait", "Salvando no Nutra Monitor…", VIRAL_REDES[post.plataforma]);
    const resposta = await chrome.runtime.sendMessage({ action: "VIRAL_SAVE", url: post.url, autor: post.autor });
    if (!resposta?.ok) return show("err", "Não salvou", resposta?.error || "Recarregue a extensão e tente de novo.");
    jobId = resposta.id;
    const data = await chrome.storage.local.get(JOBS_KEY);
    renderJob((data[JOBS_KEY] || []).find(job => job.id === jobId));
  }

  saveCurrentPost().catch(error => show("err", "Não salvou", error.message));
});
