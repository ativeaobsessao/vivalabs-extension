// Aviso de oferta nova (Discord ou Telegram): depois de cada rodada do radar, manda um resumo curto
// com os criativos EM ESCALA que ainda não foram avisados. Token/webhook ficam só neste navegador
// (chrome.storage.local) — nunca vão para o cofre da equipe.
// Carregado pelo background.js via importScripts (depende de ranking_engine.js).

const NOTIFY_STORE = {
  config: "viva_notify_config",   // { tipo: "off"|"discord"|"telegram", webhook, botToken, chatId }
  sent: "viva_notified",          // chaves de criativos já avisados
};
const NOTIFY_MAX_ITENS = 8;
const NOTIFY_SENT_CAP = 3000;
const NOTIFY_RE_DISCORD = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const NOTIFY_RE_TG_TOKEN = /^\d{5,}:[\w-]{30,}$/;
const NOTIFY_RE_TG_CHAT = /^(?:-?\d{3,}|@\w{4,})$/;

let notifyDeps = { fetch: (...a) => fetch(...a), now: () => Date.now() };
function notifyInit(deps) { notifyDeps = { ...notifyDeps, ...(deps || {}) }; }

function notifNormalizarConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const tipo = ["discord", "telegram"].includes(r.tipo) ? r.tipo : "off";
  return {
    tipo,
    webhook: String(r.webhook || "").trim().slice(0, 300),
    botToken: String(r.botToken || "").trim().slice(0, 120),
    chatId: String(r.chatId || "").trim().slice(0, 60),
  };
}

// Devolve "" se estiver tudo certo; senão, a mensagem de erro para o usuário.
function notifValidar(cfg) {
  if (cfg.tipo === "discord") return NOTIFY_RE_DISCORD.test(cfg.webhook) ? "" : "O endereço do webhook do Discord parece errado (deve começar com https://discord.com/api/webhooks/…).";
  if (cfg.tipo === "telegram") {
    if (!NOTIFY_RE_TG_TOKEN.test(cfg.botToken)) return "O token do bot do Telegram parece errado (formato 123456:ABC…).";
    if (!NOTIFY_RE_TG_CHAT.test(cfg.chatId)) return "O Chat ID do Telegram parece errado (número, ex.: -100123… ou @canal).";
    return "";
  }
  return "Avisos desligados.";
}

// Texto vindo de anúncio de terceiros é dado, não comando: sem menções, links de markdown nem formatação.
function notifLimpar(texto, max) {
  return String(texto || "").replace(/[@`*_~|<>\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function notifLinkAnuncio(c) {
  if (/^https:\/\/(?:www\.)?facebook\.com\/ads\/library\//.test(String(c.url || ""))) return c.url;
  if (/^\d{8,}$/.test(String(c.id || ""))) return `https://www.facebook.com/ads/library/?id=${c.id}`;
  if (/^\d{6,}$/.test(String(c.pid || ""))) return `https://www.facebook.com/ads/library/?view_all_page_id=${c.pid}`;
  return "";
}

function notifMontarTexto(tipo, itens, total, resumo) {
  const linhas = [`🚀 Viva Spy · radar achou ${total} criativo(s) em escala novo(s)`];
  if (resumo && resumo.criativos != null) linhas[0] += ` (rodada: ${resumo.criativos} criativos lidos)`;
  itens.forEach((c, i) => {
    const partes = [`${i + 1}. ${notifLimpar(c.nome, 50) || "Anunciante"} · score ${c.score} · ${c.dup}x · ${c.dias != null ? c.dias + " dias" : "?"}`];
    const dom = notifLimpar(c.dom, 60);
    if (dom) partes.push(`   🔗 oferta: ${dom}`);
    const link = notifLinkAnuncio(c);
    if (link) partes.push(`   📚 ${tipo === "discord" ? `<${link}>` : link}`);
    linhas.push(partes.join("\n"));
  });
  if (total > itens.length) linhas.push(`… e mais ${total - itens.length} no Centro de Inteligência.`);
  const max = tipo === "discord" ? 1900 : 4000;
  let out = linhas.join("\n\n");
  if (out.length > max) out = out.slice(0, max - 2) + " …";
  return out;
}

async function notifEnviarTexto(cfg, texto) {
  const erro = notifValidar(cfg);
  if (erro) throw new Error(erro);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let resp;
    if (cfg.tipo === "discord") {
      resp = await notifyDeps.fetch(cfg.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: texto, allowed_mentions: { parse: [] }, username: "Viva Spy" }),
        signal: controller.signal,
      });
    } else {
      resp = await notifyDeps.fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text: texto, disable_web_page_preview: true }),
        signal: controller.signal,
      });
    }
    if (!resp.ok) {
      let detalhe = "";
      try { detalhe = String((await resp.text()) || "").slice(0, 120); } catch (_) { /* sem corpo */ }
      throw new Error(`${cfg.tipo === "discord" ? "Discord" : "Telegram"} recusou (${resp.status}). ${detalhe}`.trim());
    }
    return true;
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("Tempo esgotado ao enviar o aviso.");
    // nunca deixa token/webhook vazar em mensagem de erro
    let msg = String((error && error.message) || error || "Falha ao enviar");
    [cfg.botToken, cfg.webhook].filter(Boolean).forEach(seg => { msg = msg.split(seg).join("***"); });
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

async function notifLerConfig() {
  const data = await chrome.storage.local.get(NOTIFY_STORE.config);
  return notifNormalizarConfig(data[NOTIFY_STORE.config]);
}

// Botão "Testar" do popup.
async function notifTestar() {
  const cfg = await notifLerConfig();
  try {
    await notifEnviarTexto(cfg, "✅ Viva Spy conectado. Quando o radar achar criativo em escala novo, o aviso chega aqui.");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", error: error.message };
  }
}

// Depois da rodada do radar: avisa só criativos em escala que ainda não foram avisados.
async function notifRadarRodada({ inicio = 0, resumo = null } = {}) {
  const cfg = await notifLerConfig();
  if (cfg.tipo === "off" || notifValidar(cfg)) return { status: "off" };
  const agora = notifyDeps.now();
  const data = await chrome.storage.local.get([VIVA_ACERVO_KEY, NOTIFY_STORE.sent]);
  const acervo = Array.isArray(data[VIVA_ACERVO_KEY]) ? data[VIVA_ACERVO_KEY] : [];
  const jaAvisados = new Set(Array.isArray(data[NOTIFY_STORE.sent]) ? data[NOTIFY_STORE.sent] : []);
  const candidatos = [];
  for (const c of acervo) {
    if ((Number(c.lastSeen) || 0) < inicio) continue;
    const calc = scoreCriativo({ dup: c.dup, dias: diasNoAr(c, agora), adv: c.adv });
    if (!calc.emEscala) continue;
    const chave = acervoKey(c);
    if (!chave || jaAvisados.has(chave)) continue;
    candidatos.push({ ...c, score: calc.score, _chave: chave });
  }
  if (candidatos.length === 0) return { status: "nada" };
  candidatos.sort((a, b) => b.score - a.score);
  const itens = candidatos.slice(0, NOTIFY_MAX_ITENS);
  try {
    await notifEnviarTexto(cfg, notifMontarTexto(cfg.tipo, itens, candidatos.length, resumo));
  } catch (error) {
    console.warn(`[BG][NOTIFY] aviso não enviado: ${error.message}`);
    return { status: "error", error: error.message };   // não marca como avisado: tenta de novo na próxima rodada
  }
  const novo = Array.from(new Set([...jaAvisados, ...candidatos.map(c => c._chave)]));
  await chrome.storage.local.set({ [NOTIFY_STORE.sent]: novo.slice(-NOTIFY_SENT_CAP) });
  return { status: "enviado", total: candidatos.length, itens: itens.length };
}
