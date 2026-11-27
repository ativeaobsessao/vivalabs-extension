// O post é salvo pelo cartão que aparece na página. Aqui só aparece o que não conseguiu salvar.
document.addEventListener("DOMContentLoaded", async () => {
  const box = document.getElementById("viralBox");
  const title = document.getElementById("viralTitle");
  const detail = document.getElementById("viralDetail");
  const discardBtn = document.getElementById("viralDiscardBtn");
  const JOBS_KEY = "viva_viral_jobs";

  async function render() {
    const jobs = (await chrome.storage.local.get(JOBS_KEY))[JOBS_KEY] || [];
    // Falha que depois foi salva (nova tentativa no cartão) não precisa de aviso.
    const falhas = jobs.filter((job, i) => job.status === "falhou"
      && !jobs.slice(i + 1).some(depois => depois.url === job.url && depois.status !== "falhou"));
    box.hidden = !falhas.length;
    if (!falhas.length) return;
    const ultima = falhas[falhas.length - 1];
    title.textContent = falhas.length === 1 ? "Um post viral não salvou" : `${falhas.length} posts virais não salvaram`;
    detail.textContent = `${ultima.erro || "Erro desconhecido."} ${ultima.url}`;
    discardBtn.onclick = async () => {
      discardBtn.disabled = true;
      for (const job of falhas) await chrome.runtime.sendMessage({ action: "VIRAL_UNDO", id: job.id });
      discardBtn.disabled = false;
    };
  }

  chrome.action?.setBadgeText?.({ text: "" });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[JOBS_KEY]) render();
  });
  await render();
});
