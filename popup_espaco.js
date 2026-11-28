// Aviso de espaço do banco no ícone da extensão. Abrir o ícone conta como "acesso": se o banco passou
// de 150 mil, o background baixa a planilha completa neste momento. Depende de intel_core.js.
document.addEventListener("DOMContentLoaded", async () => {
  const box = document.getElementById("espacoBox");
  const titulo = document.getElementById("espacoTitulo");
  const detalhe = document.getElementById("espacoDetalhe");
  const BANCO_KEY = "viva_vault_info";
  const ESPACO_KEY = "viva_espaco";

  async function render() {
    const data = await chrome.storage.local.get([BANCO_KEY, ESPACO_KEY]);
    const banco = data[BANCO_KEY];
    const nivel = banco ? intelNivelEspaco(banco.total, banco.bytes) : "ok";
    box.hidden = nivel === "ok";
    if (box.hidden) return;
    box.dataset.nivel = nivel;
    const estourou = nivel === "estourou";
    titulo.textContent = estourou ? "O banco passou de 150 mil anúncios" : "O espaço do banco está acabando";
    const planilha = data[ESPACO_KEY] && data[ESPACO_KEY].baixadoEm ? " A planilha completa foi baixada em Downloads/VivaSpy." : "";
    detalhe.textContent = `${intelNumero(banco.total)} de 150 mil. Apague os anúncios que não fazem parte do modelo de negócio${estourou ? " ou assine o plano pago do banco" : ""}.${estourou ? planilha : ""}`;
  }

  document.getElementById("espacoAbrir").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ action: "INTEL_OPEN" });
    window.close();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[BANCO_KEY] || changes[ESPACO_KEY])) render();
  });
  await render();
  chrome.runtime.sendMessage({ action: "ESPACO_ACESSO" }).catch(() => {});
});
