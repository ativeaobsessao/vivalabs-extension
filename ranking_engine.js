// VIVA Labs Helper - Motor de ranking (carregado no background E no content script).
// Funções PURAS (sem DOM, sem chrome.*) — fáceis de testar com `node`.

// ─── Legado: score de página (mantido por compatibilidade) ───────────────────────────────────
function calcularScore(pagina) {
  let score = 0;

  const adsScore = Math.min((Number(pagina.qtd_ads) || 1) * 8, 80);
  score += adsScore;

  const mediaDias = Number(pagina.media_dias ?? pagina.dias_ativo) || 0;
  score += Math.min(mediaDias * 1.8, 70);

  if (pagina.tem_recente) score += 25;

  const escala = pagina.escala_tipo || pagina.escala;
  if (escala === "ESCALA BRUTA") score += 50;
  else if (escala === "POTENCIAL ESCALA") score += 25;
  else if (escala === "CAMPANHA NORMAL") score += 5;
  else if (escala === "BAIXO VOLUME") score -= 20;

  const linhasDistintas = Number(pagina.linhas_distintas)
    || (Array.isArray(pagina.linhas) ? pagina.linhas.length : 0);
  if (linhasDistintas > 1) score += (linhasDistintas - 1) * 35;

  score += Math.min((Number(pagina.qtd_duplicados) || 0) * 6, 30);
  return Math.round(score);
}

function gerarRankingFinal(mapaPaginas) {
  return Array.from(mapaPaginas.values())
    .map(pagina => ({ ...pagina, score: calcularScore(pagina) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
}

// ─── Acervo de criativos (Centro de Inteligência) ────────────────────────────────────────────
const VIVA_ACERVO_KEY = "viva_acervo";
const VIVA_ACERVO_MAX = 2000;                       // teto de criativos guardados (cabe folgado nos 10MB do storage)
const VIVA_ACERVO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // criativos não revistos há 30 dias saem do acervo
const VIVA_DAY_MS = 24 * 60 * 60 * 1000;

// Score de escala de UM criativo. Lógica pensada para o operador de DR:
//  - duplicados (quantos anúncios usam o MESMO criativo+texto) é o sinal mais forte de escala;
//  - dias no ar mostra que o criativo sobrevive (alguém está pagando por ele);
//  - tamanho da biblioteca (anúncios do anunciante) mostra operação grande;
//  - "em escala agora": criativo NOVO que já tem muitos duplicados = está sendo escalado agora.
// Retorna { score, emEscala }.
const VIVA_FONTES_MAX = 20;       // termos de busca lembrados por criativo
const VIVA_TERMOS_BONUS = 8;      // pontos por termo EXTRA que também achou o criativo (máx. 6 extras)

function scoreCriativo({ dup, dias, adv, termos }) {
  const d = Math.max(1, Number(dup) || 1);
  const known = dias !== null && dias !== undefined && Number.isFinite(Number(dias));
  const days = known ? Math.max(0, Number(dias)) : 0;
  const a = Math.max(0, Number(adv) || 0);

  let score = Math.min(d, 50) * 4 + Math.min(days, 60) + Math.min(a, 40);
  let emEscala = false;
  if (known && days <= 7 && d >= 4) {
    emEscala = true;
    score += 40;
  } else if (known && days <= 14 && d >= 8) {
    emEscala = true;
    score += 60;
  }
  // Assertividade: quem aparece em vários dos seus termos-chave provavelmente é a oferta do nicho.
  score += Math.min(Math.max(0, (Number(termos) || 1) - 1), 6) * VIVA_TERMOS_BONUS;
  return { score: Math.round(score), emEscala };
}

// Dias no ar calculados "ao vivo" a partir da data de início (se existir), senão o snapshot.
function diasNoAr(criativo, agora = Date.now()) {
  if (criativo && Number.isFinite(Number(criativo.inicio)) && Number(criativo.inicio) > 0) {
    return Math.max(0, Math.ceil((agora - Number(criativo.inicio)) / VIVA_DAY_MS));
  }
  if (criativo && criativo.dias !== null && criativo.dias !== undefined && Number.isFinite(Number(criativo.dias))) {
    return Number(criativo.dias);
  }
  return null;
}

function acervoKey(criativo) {
  if (!criativo) return "";
  if (criativo.id) return `id:${criativo.id}`;
  if (criativo.sig) return `sig:${criativo.pid || criativo.nome || ""}|${criativo.sig}`;
  return "";
}

function _trimText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Normaliza/limita um criativo vindo do content script (nunca confia no tamanho dos campos).
function sanitizarCriativo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = /^\d{8,20}$/.test(String(raw.id || "")) ? String(raw.id) : "";
  const pid = /^\d{8,20}$/.test(String(raw.pid || "")) ? String(raw.pid) : "";
  const sig = _trimText(raw.sig, 160);
  if (!id && !sig) return null;
  const inicio = Number(raw.inicio);
  const dias = raw.dias === null || raw.dias === undefined ? null : Number(raw.dias);
  return {
    id,
    pid,
    sig,
    nome: _trimText(raw.nome, 120) || "Anunciante sem nome",
    copy: _trimText(raw.copy, 320),
    dest: _trimText(raw.dest, 300),
    dom: _trimText(raw.dom, 120),
    thumb: /^https?:\/\//i.test(String(raw.thumb || "")) ? String(raw.thumb).slice(0, 900) : "",
    video: Boolean(raw.video),
    url: /^https:\/\/[a-z0-9.-]*facebook\.com\//i.test(String(raw.url || "")) ? String(raw.url).slice(0, 600) : "",
    dup: Math.max(1, Math.min(9999, Number(raw.dup) || 1)),
    dias: Number.isFinite(dias) && dias >= 0 ? dias : null,
    inicio: Number.isFinite(inicio) && inicio > 0 ? inicio : 0,
    adv: Math.max(0, Math.min(999999, Number(raw.adv) || 0)),
    stage: _trimText(raw.stage, 16),
    fonte: _trimText(raw.fonte, 80),
  };
}

// Junta os criativos novos ao acervo existente. Devolve { acervo, adicionados, atualizados }.
function mesclarAcervo(existente, novos, agora = Date.now(), max = VIVA_ACERVO_MAX) {
  const mapa = new Map();
  for (const item of Array.isArray(existente) ? existente : []) {
    if (!item || typeof item !== "object") continue;
    if (agora - (Number(item.lastSeen) || 0) > VIVA_ACERVO_TTL_MS) continue;
    const key = acervoKey(item);
    if (key) mapa.set(key, item);
  }

  let adicionados = 0;
  let atualizados = 0;
  for (const bruto of Array.isArray(novos) ? novos : []) {
    const novo = sanitizarCriativo(bruto);
    if (!novo) continue;
    const key = acervoKey(novo);
    const atual = mapa.get(key);
    const fontes = new Set(atual && Array.isArray(atual.fontes) ? atual.fontes : []);
    if (novo.fonte) fontes.add(novo.fonte);
    const fontesLista = Array.from(fontes).slice(-VIVA_FONTES_MAX);

    const dup = Math.max(atual ? atual.dup : 1, novo.dup);
    const inicio = novo.inicio || (atual ? atual.inicio : 0) || 0;
    const dias = novo.dias !== null ? novo.dias : (atual ? atual.dias : null);
    const adv = Math.max(atual ? atual.adv : 0, novo.adv);
    const merged = {
      id: novo.id || (atual ? atual.id : ""),
      pid: novo.pid || (atual ? atual.pid : ""),
      sig: novo.sig || (atual ? atual.sig : ""),
      nome: novo.nome !== "Anunciante sem nome" ? novo.nome : (atual ? atual.nome : novo.nome),
      copy: novo.copy || (atual ? atual.copy : ""),
      dest: novo.dest || (atual ? atual.dest : ""),
      dom: novo.dom || (atual ? atual.dom : ""),
      thumb: novo.thumb || (atual ? atual.thumb : ""),
      video: novo.video || Boolean(atual && atual.video),
      url: novo.url || (atual ? atual.url : ""),
      dup,
      dias,
      inicio,
      adv,
      stage: novo.stage || (atual ? atual.stage : ""),
      fontes: fontesLista,
      firstSeen: atual ? atual.firstSeen : agora,
      lastSeen: agora,
      advBase: atual ? (Number(atual.advBase) || 0) : 0,
      advBaseMs: atual ? (Number(atual.advBaseMs) || 0) : 0,
    };
    const diasAtuais = diasNoAr(merged, agora);
    const calc = scoreCriativo({ dup: merged.dup, dias: diasAtuais, adv: merged.adv });
    merged.score = calc.score;
    merged.emEscala = calc.emEscala;
    if (atual) atualizados += 1;
    else adicionados += 1;
    mapa.set(key, merged);
  }

  let acervo = Array.from(mapa.values());
  if (acervo.length > max) {
    acervo.sort((a, b) => (b.score - a.score) || (b.lastSeen - a.lastSeen));
    acervo = acervo.slice(0, max);
  }
  return { acervo, adicionados, atualizados };
}

// Junta ao acervo local os registros COMPLETOS vindos do cofre da equipe (Supabase).
// Diferente de mesclarAcervo, NÃO "renova" o lastSeen (item antigo de outro minerador continua
// antigo) e respeita o que já existe: dup/adv = maior, firstSeen = menor, lastSeen = maior.
function mesclarRemotos(existente, remotos, agora = Date.now(), max = VIVA_ACERVO_MAX) {
  const mapa = new Map();
  for (const item of Array.isArray(existente) ? existente : []) {
    if (!item || typeof item !== "object") continue;
    if (agora - (Number(item.lastSeen) || 0) > VIVA_ACERVO_TTL_MS) continue;
    const key = acervoKey(item);
    if (key) mapa.set(key, item);
  }
  let adicionados = 0;
  let atualizados = 0;
  for (const linha of Array.isArray(remotos) ? remotos : []) {
    const rec = linha && linha.rec;
    const base = sanitizarCriativo(rec);
    if (!base) continue;
    const key = acervoKey(base);
    if (!key) continue;
    const lastRemoto = Number(rec.lastSeen) || 0;
    if (agora - lastRemoto > VIVA_ACERVO_TTL_MS) continue;
    const atual = mapa.get(key);
    const firstRemoto = Number(rec.firstSeen) || lastRemoto || agora;
    const fontes = new Set(atual && Array.isArray(atual.fontes) ? atual.fontes : []);
    (Array.isArray(rec.fontes) ? rec.fontes : []).forEach(f => { const t = _trimText(f, 80); if (t) fontes.add(t); });
    const remotoMaisNovo = !atual || lastRemoto >= (Number(atual.lastSeen) || 0);
    const pick = (a, b) => (remotoMaisNovo ? (a || b) : (b || a));
    const A = atual || {};
    const merged = {
      id: pick(base.id, A.id) || "",
      pid: pick(base.pid, A.pid) || "",
      sig: pick(base.sig, A.sig) || "",
      nome: remotoMaisNovo && base.nome !== "Anunciante sem nome" ? base.nome : (A.nome || base.nome),
      copy: pick(base.copy, A.copy) || "",
      dest: pick(base.dest, A.dest) || "",
      dom: pick(base.dom, A.dom) || "",
      thumb: pick(base.thumb, A.thumb) || "",
      video: Boolean(base.video || A.video),
      url: pick(base.url, A.url) || "",
      dup: Math.max(A.dup || 1, base.dup),
      dias: remotoMaisNovo ? (base.dias !== null ? base.dias : (A.dias ?? null)) : (A.dias ?? base.dias),
      inicio: base.inicio || A.inicio || 0,
      adv: Math.max(A.adv || 0, base.adv),
      stage: pick(base.stage, A.stage) || "",
      fontes: Array.from(fontes).slice(-VIVA_FONTES_MAX),
      firstSeen: Math.min(Number(A.firstSeen) || firstRemoto, firstRemoto),
      lastSeen: Math.max(Number(A.lastSeen) || 0, lastRemoto),
    };
    const baseMsRemoto = Number(rec.advBaseMs) || 0;
    const baseMsLocal = Number(A.advBaseMs) || 0;
    if (baseMsRemoto >= baseMsLocal && baseMsRemoto > 0) {
      merged.advBase = Math.max(0, Number(rec.advBase) || 0);
      merged.advBaseMs = baseMsRemoto;
    } else {
      merged.advBase = Number(A.advBase) || 0;
      merged.advBaseMs = baseMsLocal;
    }
    const calc = scoreCriativo({ dup: merged.dup, dias: diasNoAr(merged, agora), adv: merged.adv });
    merged.score = calc.score;
    merged.emEscala = calc.emEscala;
    if (atual) atualizados += 1;
    else adicionados += 1;
    mapa.set(key, merged);
  }
  let acervo = Array.from(mapa.values());
  if (acervo.length > max) {
    acervo.sort((a, b) => (b.score - a.score) || (b.lastSeen - a.lastSeen));
    acervo = acervo.slice(0, max);
  }
  return { acervo, adicionados, atualizados };
}

// ── Histórico diário por biblioteca (para detectar quem está SUBINDO) ──────────────────────────
// hist = { [pid]: { n: nome, s: [[diaIndex, adsNaBiblioteca], ...] } } — um número por dia, 14 dias.
const VIVA_HIST_KEY = "viva_hist";
const VIVA_HIST_DIAS = 14;
const VIVA_HIST_MAX_PAGINAS = 4000;
const VIVA_TEND_MIN_DELTA = 5;     // precisa ter ganhado pelo menos 5 anúncios...
const VIVA_TEND_MIN_RAZAO = 1.3;   // ...e ao menos +30% sobre a base

function histDia(ms) {
  const d = new Date(ms);
  return Math.floor((ms - d.getTimezoneOffset() * 60000) / VIVA_DAY_MS);
}

// Registra o maior nº de anúncios visto hoje por biblioteca. Devolve um hist novo (não muta o original).
function histRegistrar(hist, criativos, agora = Date.now()) {
  const novo = {};
  const hoje = histDia(agora);
  const corte = hoje - VIVA_HIST_DIAS;
  for (const [pid, h] of Object.entries(hist && typeof hist === "object" ? hist : {})) {
    const s = (Array.isArray(h && h.s) ? h.s : []).filter(par => Array.isArray(par) && par[0] > corte);
    if (s.length) novo[pid] = { n: String((h && h.n) || ""), s };
  }
  for (const c of Array.isArray(criativos) ? criativos : []) {
    const pid = c && /^\d{8,20}$/.test(String(c.pid || "")) ? String(c.pid) : "";
    const adv = Number(c && c.adv) || 0;
    if (!pid || adv <= 0) continue;
    const atual = novo[pid] || { n: "", s: [] };
    const s = atual.s.map(par => par.slice());
    const ultimo = s[s.length - 1];
    if (ultimo && ultimo[0] === hoje) ultimo[1] = Math.max(ultimo[1], adv);
    else s.push([hoje, adv]);
    novo[pid] = { n: String(c.nome || atual.n || "").slice(0, 80), s: s.slice(-VIVA_HIST_DIAS) };
  }
  const pids = Object.keys(novo);
  if (pids.length > VIVA_HIST_MAX_PAGINAS) {
    pids.sort((a, b) => novo[b].s[novo[b].s.length - 1][0] - novo[a].s[novo[a].s.length - 1][0]);
    const mantidos = {};
    pids.slice(0, VIVA_HIST_MAX_PAGINAS).forEach(pid => { mantidos[pid] = novo[pid]; });
    return mantidos;
  }
  return novo;
}

// Base de comparação: a leitura MAIS ANTIGA entre 1 e 7 dias atrás (ontem ou antes).
function histBase(hist, pid, agora = Date.now()) {
  const h = hist && hist[pid];
  if (!h || !Array.isArray(h.s)) return null;
  const hoje = histDia(agora);
  const candidatos = h.s.filter(par => par[0] <= hoje - 1 && par[0] >= hoje - 7);
  if (!candidatos.length) return null;
  const [dia, adv] = candidatos[0];
  return { adv, ms: agora - (hoje - dia) * VIVA_DAY_MS };
}

// Está subindo? (também usada pelo Centro para mostrar o selo)
function tendenciaCriativo(c, agora = Date.now()) {
  const base = Number(c && c.advBase) || 0;
  const adv = Number(c && c.adv) || 0;
  if (base <= 0 || adv <= 0) return { sobe: false, delta: 0, dias: 0 };
  const delta = adv - base;
  const dias = Math.max(1, Math.round((agora - (Number(c.advBaseMs) || agora)) / VIVA_DAY_MS));
  return { sobe: delta >= VIVA_TEND_MIN_DELTA && adv >= base * VIVA_TEND_MIN_RAZAO, delta, dias };
}

// Grava advBase/advBaseMs nos criativos a partir do histórico. Devolve { acervo, mudou: [chaves] }.
function aplicarTendencias(acervo, hist, agora = Date.now()) {
  const mudou = [];
  const lista = (Array.isArray(acervo) ? acervo : []).map(c => {
    if (!c || !c.pid) return c;
    const base = histBase(hist, c.pid, agora);
    const advBase = base ? base.adv : 0;
    const advBaseMs = base ? base.ms : 0;
    if ((Number(c.advBase) || 0) === advBase && (Number(c.advBaseMs) || 0) === advBaseMs) return c;
    // a base só "anda" quando muda de dia (evita reenviar o mesmo registro à toa)
    if (Math.abs((Number(c.advBaseMs) || 0) - advBaseMs) < VIVA_DAY_MS / 2 && (Number(c.advBase) || 0) === advBase) return c;
    const novo = { ...c, advBase, advBaseMs };
    const chave = acervoKey(novo);
    if (chave) mudou.push(chave);
    return novo;
  });
  return { acervo: lista, mudou };
}

// Agrupa o acervo por biblioteca (anunciante) e ranqueia.
function agruparPaginas(acervo, agora = Date.now()) {
  const grupos = new Map();
  for (const c of Array.isArray(acervo) ? acervo : []) {
    const chave = c.pid || `n:${String(c.nome || "").toLowerCase()}`;
    let g = grupos.get(chave);
    if (!g) {
      g = {
        page_id: c.pid || "",
        nome: c.nome || "Anunciante sem nome",
        criativos: 0,
        emEscala: 0,
        maxDup: 1,
        somaDias: 0,
        comDias: 0,
        adv: 0,
        topScore: 0,
        fontes: new Set(),
      };
      grupos.set(chave, g);
    }
    const dias = diasNoAr(c, agora);
    const calc = scoreCriativo({ dup: c.dup, dias, adv: c.adv });
    g.criativos += 1;
    if (calc.emEscala) g.emEscala += 1;
    g.maxDup = Math.max(g.maxDup, c.dup || 1);
    if (dias !== null) {
      g.somaDias += dias;
      g.comDias += 1;
    }
    g.adv = Math.max(g.adv, c.adv || 0);
    g.topScore = Math.max(g.topScore, calc.score);
    (c.fontes || []).forEach(f => g.fontes.add(f));
  }
  return Array.from(grupos.values())
    .map(g => ({
      page_id: g.page_id,
      nome: g.nome,
      criativos: g.criativos,
      emEscala: g.emEscala,
      maxDup: g.maxDup,
      mediaDias: g.comDias ? g.somaDias / g.comDias : 0,
      adv: g.adv,
      fontes: Array.from(g.fontes),
      score: Math.round(g.topScore + Math.min(g.criativos, 20) * 3 + g.emEscala * 10),
    }))
    .sort((a, b) => b.score - a.score);
}
