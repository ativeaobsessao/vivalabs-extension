// Centro de Inteligência — regras puras (sem DOM, sem rede). Usadas pela tela (modo sem banco),
// pelo service worker e pelos testes. O SQL (SUPABASE_ATUALIZACAO_150K.sql) repete estas regras; o
// teste qa/testes/intel_sql.test.js confere que os dois dão o mesmo resultado.
// Depende de ranking_engine.js (scoreCriativo, diasNoAr, tendenciaCriativo, acervoKey, domínios).

const INTEL_LIMITE = 150000;          // anúncios no banco da equipe
const INTEL_ATENCAO = 120000;         // a partir daqui a tela avisa que está acabando
const INTEL_BYTES_ATENCAO = 450e6;    // o plano gratuito do banco trava em 500 MB
const INTEL_REARME = 0.97;            // abaixo de 97% do limite, o aviso volta a poder disparar
const INTEL_PAGINA = 48;
const INTEL_TRECHO = 120;             // caracteres do anúncio considerados na busca
const INTEL_NICHOS = ["Emagrecimento", "Diabetes", "Menopausa", "Renda extra", "Rejuvenescimento", "Relacionamento", "Outro"];
const INTEL_ORDENS = ["score", "dup", "dias", "novos", "menor"];
const INTEL_SELOS = { agora: "Escalando agora", monstro: "Escala monstro", bruta: "Escala bruta" };

// A ordem importa: quem casa primeiro vence (ex.: "ozempic para diabetes" é Diabetes).
const INTEL_REGRAS_NICHO = [
  ["Diabetes", "diabet|blood sugar|glucose|insulin|a1c|glicose|glicemia"],
  ["Menopausa", "menopaus|perimenopaus|hot flash|fogacho|calorões"],
  ["Emagrecimento", "weight|fat burn|belly|slimming|ozempic|mounjaro|glp-?1|keto|metabolism|emagrec|perder peso|gordura|barriga"],
  ["Relacionamento", "relationship|your ex|get him back|get her back|seduc|seduç|marriage|dating|relacionamento|reconquist|casamento"],
  ["Renda extra", "make money|side hustle|passive income|work from home|extra income|renda extra|ganhar dinheiro|trabalhar em casa"],
  ["Rejuvenescimento", "wrinkle|anti-?aging|collagen|younger|rejuvenesc|ruga|colágeno|skin"],
].map(([nome, palavras]) => [nome, new RegExp(`(^|[^\\p{L}\\p{N}])(${palavras})`, "u")]);

function intelNichoDoTexto(texto) {
  const t = String(texto || "").toLowerCase();
  const regra = INTEL_REGRAS_NICHO.find(([, re]) => re.test(t));
  return regra ? regra[0] : "Outro";
}

// Correção manual > termos de busca > texto do anúncio.
function intelNicho(c, manual) {
  if (INTEL_NICHOS.includes(manual)) return manual;
  const porTermo = intelNichoDoTexto((Array.isArray(c.fontes) ? c.fontes : []).join(" "));
  if (porTermo !== "Outro") return porTermo;
  return intelNichoDoTexto([c.nome, c.copy, c.dom].filter(Boolean).join(" "));
}

// Um selo por card. Prioridade: escalando agora > monstro > bruta.
function intelSelo(emEscala, dias, dup) {
  if (emEscala) return "agora";
  if (dias !== null && dias >= 30) return "monstro";
  if ((dias !== null && dias >= 15) || dup >= 3) return "bruta";
  return "";
}

function intelDominio(c) {
  const dom = normalizarDominioOferta(c.dom || c.dest);
  return dom && !dominioIgnorado(dom) ? dom : "";
}

// Registro do acervo local → item da tela (mesmo formato que o banco devolve).
function intelItem(c, meta, manual, agora = Date.now()) {
  const dias = diasNoAr(c, agora);
  const termos = Array.isArray(c.fontes) ? c.fontes.length : 0;
  const calc = scoreCriativo({ dup: c.dup, dias, adv: c.adv, termos });
  const m = meta || {};
  const status = ["nova", "analise", "minerada", "descartada"].includes(m.status) ? m.status : "nova";
  return {
    key: acervoKey(c), rec: c, by: m.by || "", status, statusBy: m.statusBy || "",
    score: calc.score, scoreBase: scoreCriativo({ dup: c.dup, dias, adv: c.adv }).score,
    dias, selo: intelSelo(calc.emEscala, dias, Number(c.dup) || 1), nicho: intelNicho(c, manual),
  };
}

function intelFiltrosPadrao() {
  return {
    escala: "todos", nicho: "", dias: "", formato: "", busca: "", status: "ativas",
    copiasMin: 0, advMin: 0, termo: "", quem: "", novos24: false, subindo: false, pid: "", nomeExato: "", dom: "",
  };
}

// Aceita qualquer entrada (link, filtro salvo) e devolve só valores válidos.
function intelFiltrosNormalizar(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const base = intelFiltrosPadrao();
  const um = (v, validos, padrao) => (validos.includes(v) ? v : padrao);
  const texto = v => String(v || "").slice(0, 200);
  const inteiro = v => Math.max(0, Math.min(999999, Math.floor(Number(v) || 0)));
  return {
    escala: um(r.escala, ["todos", "agora", "bruta", "monstro"], base.escala),
    nicho: um(r.nicho, INTEL_NICHOS, ""),
    dias: um(r.dias, ["1-7", "8-14", "15-29", "30+"], ""),
    formato: um(r.formato, ["video", "imagem"], ""),
    busca: texto(r.busca),
    status: um(r.status, ["ativas", "todas", "nova", "analise", "minerada", "descartada"], base.status),
    copiasMin: inteiro(r.copiasMin), advMin: inteiro(r.advMin),
    termo: texto(r.termo), quem: texto(r.quem),
    novos24: r.novos24 === true || r.novos24 === "true",
    subindo: r.subindo === true || r.subindo === "true",
    pid: /^\d{8,20}$/.test(String(r.pid || "")) ? String(r.pid) : "",
    nomeExato: texto(r.nomeExato), dom: texto(r.dom),
  };
}

// Só o que difere do padrão (vai no link e no pedido ao banco).
function intelFiltrosEnxutos(filtros) {
  const padrao = intelFiltrosPadrao();
  return Object.fromEntries(Object.entries(filtros).filter(([k, v]) => v !== padrao[k]));
}

// Filtros salvos na tela antiga continuam valendo.
function intelFiltrosDoModeloAntigo(ui) {
  const u = ui || {};
  const a = u.adv || {};
  const dias = a.diasMin >= 30 ? "30+" : a.diasMin >= 15 ? "15-29" : a.diasMax > 0 && a.diasMax <= 7 ? "1-7" : a.diasMax > 0 && a.diasMax <= 14 ? "8-14" : "";
  const escala = { escala: "agora", monstro: "monstro", bruta: "bruta" }[u.filtro] || "todos";
  return intelFiltrosNormalizar({
    escala, dias, formato: a.midia, busca: u.busca || a.dominio, status: u.status, copiasMin: a.dup, advMin: a.adv,
    termo: u.fonte || (Array.isArray(u.termos) ? u.termos[0] : ""), novos24: u.filtro === "novos24", subindo: u.filtro === "subindo",
  });
}

function intelPassaStatus(item, status) {
  if (status === "ativas") return item.status !== "descartada";
  return status === "todas" || item.status === status;
}

function intelPassaDias(dias, faixa) {
  if (!faixa) return true;
  if (dias === null) return false;
  if (faixa === "1-7") return dias <= 7;
  if (faixa === "8-14") return dias >= 8 && dias <= 14;
  if (faixa === "15-29") return dias >= 15 && dias <= 29;
  return dias >= 30;
}

function intelPassa(item, f, agora) {
  const c = item.rec;
  const fontes = Array.isArray(c.fontes) ? c.fontes : [];
  if (!intelPassaStatus(item, f.status) || !intelPassaDias(item.dias, f.dias)) return false;
  if (f.escala !== "todos" && item.selo !== f.escala) return false;
  if (f.nicho && item.nicho !== f.nicho) return false;
  if (f.formato && Boolean(c.video) !== (f.formato === "video")) return false;
  if (f.busca) {
    const alvo = `${c.nome || ""} ${intelDominio(c)} ${String(c.copy || "").slice(0, INTEL_TRECHO)}`.toLowerCase();
    if (!alvo.includes(f.busca.toLowerCase())) return false;
  }
  if ((Number(c.dup) || 1) < f.copiasMin || (Number(c.adv) || 0) < f.advMin) return false;
  if (f.termo && !fontes.includes(f.termo)) return false;
  if (f.quem && item.by !== f.quem) return false;
  if (f.novos24 && (Number(c.firstSeen) || 0) < agora - 86400000) return false;
  if (f.subindo && !tendenciaCriativo(c, agora).sobe) return false;
  if (f.pid && c.pid !== f.pid) return false;
  if (f.nomeExato && !(!c.pid && String(c.nome || "").toLowerCase() === f.nomeExato.toLowerCase())) return false;
  return !f.dom || intelDominio(c) === f.dom;
}

function intelOrdenar(itens, ordem) {
  const porScore = (a, b) => (b.score - a.score) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const comparar = {
    dup: (a, b) => ((Number(b.rec.dup) || 1) - (Number(a.rec.dup) || 1)) || porScore(a, b),
    dias: (a, b) => ((b.dias ?? -1) - (a.dias ?? -1)) || porScore(a, b),
    novos: (a, b) => ((a.dias ?? 1e9) - (b.dias ?? 1e9)) || porScore(a, b),
    menor: (a, b) => (a.score - b.score) || porScore(a, b),
  }[ordem] || porScore;
  return itens.slice().sort(comparar);
}

function intelChaveGrupo(item, tipo) {
  if (tipo === "ofertas") return intelDominio(item.rec);
  return item.rec.pid || `n:${String(item.rec.nome || "").toLowerCase()}`;
}

function intelResumoGrupo(grupo, membros, tipo, agora) {
  const melhor = intelOrdenar(membros, "score")[0];
  const comDias = membros.filter(m => m.dias !== null);
  const conta = teste => membros.filter(teste).length;
  const r = {
    grupo, criativos: membros.length,
    emEscala: conta(m => m.selo === "agora"),
    maxDup: Math.max(...membros.map(m => Number(m.rec.dup) || 1)),
    mediaDias: comDias.length ? Math.round(comDias.reduce((s, m) => s + m.dias, 0) / comDias.length) : 0,
    adv: Math.max(...membros.map(m => Number(m.rec.adv) || 0)),
    paginas: new Set(membros.map(m => intelChaveGrupo(m, "paginas"))).size,
    pid: melhor.rec.pid || "", nome: melhor.rec.nome || "", thumb: melhor.rec.thumb || "", dest: melhor.rec.dest || "",
  };
  const novos = conta(m => (Number(m.rec.firstSeen) || 0) >= agora - 86400000);
  const subindo = conta(m => tendenciaCriativo(m.rec, agora).sobe);
  const extra = tipo === "ofertas" ? Math.min(r.paginas, 10) * 8 + Math.min(novos, 5) * 2 + Math.min(subindo, 5) * 5 : 0;
  r.score = Math.max(...membros.map(m => m.scoreBase)) + Math.min(r.criativos, 20) * 3 + r.emEscala * 10 + extra;
  return r;
}

function intelGrupos(itens, tipo, agora = Date.now()) {
  const mapa = new Map();
  itens.forEach(item => {
    const chave = intelChaveGrupo(item, tipo);
    if (!chave) return;
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push(item);
  });
  return Array.from(mapa, ([chave, membros]) => intelResumoGrupo(chave, membros, tipo, agora))
    .sort((a, b) => (b.score - a.score) || (b.criativos - a.criativos) || (a.grupo < b.grupo ? -1 : 1));
}

// "estourou" é pela contagem (limite combinado). O disco só acende o alerta amarelo: apagar libera
// espaço para reuso, mas o tamanho informado pelo banco não encolhe na hora.
function intelNivelEspaco(total, bytes) {
  const n = Number(total) || 0;
  if (n >= INTEL_LIMITE) return "estourou";
  return n >= INTEL_ATENCAO || (Number(bytes) || 0) >= INTEL_BYTES_ATENCAO ? "atencao" : "ok";
}

function intelNumero(n) {
  return (Number(n) || 0).toLocaleString("pt-BR");
}
