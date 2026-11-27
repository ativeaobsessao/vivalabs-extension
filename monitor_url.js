// Endereço do sistema de monitoramento: um lugar só para o botão do popup, funis, anúncios e posts virais.
// Cada pessoa troca no popup, em "Conexão com o monitor". Para trocar o padrão da equipe, mude a linha abaixo
// (e, se o domínio for novo, inclua-o em host_permissions no manifest.json).
const VIVA_MONITOR_PADRAO = "https://nutra-monitor.onrender.com";
const VIVA_MONITOR_DESATIVADOS = ["https://viva-labs-monitor.onrender.com"];

// Aceita o link como a pessoa colar (com /dashboard, /admin ou sem https://). Devolve só o domínio, ou null.
function vivaMonitorLer(texto) {
  const valor = String(texto || "").trim();
  if (!valor) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(valor) ? valor : `https://${valor}`);
    return url.hostname.includes(".") || url.hostname === "localhost" ? url.origin : null;
  } catch (error) {
    return null;
  }
}

function vivaMonitorUrl(salvo) {
  const url = vivaMonitorLer(salvo);
  return !url || VIVA_MONITOR_DESATIVADOS.includes(url) ? VIVA_MONITOR_PADRAO : url;
}
