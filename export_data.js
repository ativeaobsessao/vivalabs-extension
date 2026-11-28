// Exportação do acervo para planilha (XLSX e CSV) — sem bibliotecas externas.
// Usado pelo Centro de Inteligência (botão "Baixar") e pelo download automático ao bater o teto do acervo.
// Depende de ranking_engine.js (scoreCriativo, diasNoAr, tendenciaCriativo, acervoKey, agruparOfertas, agruparPaginas).
//
// O arquivo é pensado para quem vai OPERAR em cima dele: as colunas de decisão (score, escala, oferta,
// duplicados, dias) vêm primeiro, os links clicáveis no meio e os dados "técnicos" (IDs, datas) no fim.

const EXPORT_APP = "Viva Spy";
const EXPORT_STATUS_LABEL = { nova: "Nova", analise: "Em análise", minerada: "Minerada", descartada: "Descartada" };
const EXPORT_FASE_LABEL = {
  teste: "Em teste", validando: "Validando", potencial: "Potencial de escala",
  bruta: "Escala bruta", monstro: "Escala monstro", baixo: "Baixo volume",
};
const EXPORT_MAX_CELULA = 32000;   // limite do Excel é 32.767 caracteres por célula

// Cada coluna: id, título, largura (caracteres), tipo (texto|num|data|datahora|link), explicação (aba "Leia-me").
const EXPORT_COLUNAS_CRIATIVOS = [
  { id: "rank", t: "#", w: 6, tipo: "num", d: "Posição no arquivo (ordenado por score, do maior para o menor)." },
  { id: "score", t: "Score", w: 8, tipo: "num", d: "Nota de escala do criativo: duplicados×4 (até 50) + dias no ar (até 60) + anúncios da página (até 40) + bônus de escala (+40 se novo e muito duplicado, +60 se ≤14 dias e 8+ duplicados) + 8 por termo extra que o achou." },
  { id: "emEscala", t: "Em escala agora?", w: 15, tipo: "texto", d: "Sim = criativo novo (≤7 dias) com 4+ duplicados, ou ≤14 dias com 8+ duplicados. É o sinal mais forte de que alguém está pagando para escalar." },
  { id: "fase", t: "Fase", w: 18, tipo: "texto", d: "Classificação do motor Viva (em teste, validando, potencial, escala bruta, escala monstro, baixo volume), quando disponível." },
  { id: "pagina", t: "Anunciante (página)", w: 28, tipo: "texto", d: "Nome da página que anuncia." },
  { id: "dominio", t: "Oferta (domínio)", w: 24, tipo: "texto", d: "Domínio da página de destino do anúncio. Mesmo domínio em várias páginas = mesma oferta sendo escalada." },
  { id: "dup", t: "Duplicados", w: 11, tipo: "num", d: "Quantos anúncios usam o MESMO criativo + texto. O maior sinal de escala." },
  { id: "dias", t: "Dias no ar", w: 10, tipo: "num", d: "Há quantos dias o criativo está sendo veiculado (calculado na hora do download)." },
  { id: "adv", t: "Anúncios da página", w: 12, tipo: "num", d: "Quantos anúncios a página tem ativos na biblioteca (tamanho da operação)." },
  { id: "tendencia", t: "Tendência da página", w: 22, tipo: "texto", d: "\"Subindo\" = a página ganhou 5+ anúncios e pelo menos +30% desde a leitura mais antiga do histórico (até 7 dias)." },
  { id: "variacao", t: "Variação (anúncios)", w: 12, tipo: "num", d: "Quantos anúncios a página ganhou/perdeu desde a leitura base do histórico." },
  { id: "novo24", t: "Novo (24h)?", w: 11, tipo: "texto", d: "Sim = entrou no acervo nas últimas 24 horas." },
  { id: "nTermos", t: "Nº de termos", w: 10, tipo: "num", d: "Em quantas das suas buscas esse criativo apareceu. Quem aparece em vários termos costuma ser a oferta certa do nicho." },
  { id: "termos", t: "Termos / buscas", w: 30, tipo: "texto", d: "As buscas (palavras-chave) que encontraram o criativo." },
  { id: "status", t: "Status (equipe)", w: 14, tipo: "texto", d: "Etiqueta de trabalho compartilhada: Nova, Em análise, Minerada ou Descartada." },
  { id: "por", t: "Quem achou", w: 14, tipo: "texto", d: "Minerador que encontrou primeiro (quando a equipe está conectada)." },
  { id: "midia", t: "Mídia", w: 9, tipo: "texto", d: "Vídeo ou Imagem." },
  { id: "copy", t: "Texto do anúncio", w: 60, tipo: "texto", d: "Texto principal capturado (guardado com até 320 caracteres)." },
  { id: "destino", t: "URL de destino", w: 40, tipo: "texto", d: "Link para onde o anúncio manda o tráfego." },
  { id: "linkAnuncio", t: "Ver anúncio", w: 14, tipo: "link", d: "Abre o anúncio na Meta Ad Library." },
  { id: "linkPagina", t: "Ver biblioteca da página", w: 22, tipo: "link", d: "Abre todos os anúncios da página na Meta Ad Library." },
  { id: "thumb", t: "Imagem (URL)", w: 30, tipo: "texto", d: "Endereço da miniatura. Pode expirar com o tempo (links da Meta são temporários)." },
  { id: "inicio", t: "Início da veiculação", w: 17, tipo: "data", d: "Data em que o anúncio começou a rodar, segundo a Meta." },
  { id: "primeira", t: "Primeira vez visto", w: 17, tipo: "datahora", d: "Quando o Viva Spy viu este criativo pela primeira vez." },
  { id: "ultima", t: "Última vez visto", w: 17, tipo: "datahora", d: "Última vez que ele apareceu numa busca/rolagem. Se for antigo, o anúncio pode ter saído do ar." },
  { id: "idAnuncio", t: "ID do anúncio", w: 20, tipo: "texto", d: "Identificador do anúncio na Meta Ad Library." },
  { id: "idPagina", t: "ID da página", w: 18, tipo: "texto", d: "Identificador da página (view_all_page_id)." },
];

const EXPORT_COLUNAS_OFERTAS = [
  { id: "rank", t: "#", w: 6, tipo: "num" },
  { id: "score", t: "Score da oferta", w: 14, tipo: "num" },
  { id: "dominio", t: "Oferta (domínio)", w: 28, tipo: "texto" },
  { id: "criativos", t: "Criativos", w: 10, tipo: "num" },
  { id: "paginas", t: "Páginas anunciando", w: 18, tipo: "num" },
  { id: "emEscala", t: "Criativos em escala", w: 18, tipo: "num" },
  { id: "maxDup", t: "Maior duplicação", w: 16, tipo: "num" },
  { id: "mediaDias", t: "Média de dias no ar", w: 18, tipo: "num" },
  { id: "novos24", t: "Novos (24h)", w: 12, tipo: "num" },
  { id: "subindo", t: "Subindo", w: 10, tipo: "num" },
  { id: "nomesPaginas", t: "Páginas (exemplos)", w: 40, tipo: "texto" },
  { id: "termos", t: "Termos / buscas", w: 30, tipo: "texto" },
  { id: "destino", t: "Página de destino (exemplo)", w: 40, tipo: "texto" },
  { id: "melhorCopy", t: "Texto do melhor criativo", w: 60, tipo: "texto" },
];

const EXPORT_COLUNAS_PAGINAS = [
  { id: "rank", t: "#", w: 6, tipo: "num" },
  { id: "score", t: "Score da página", w: 14, tipo: "num" },
  { id: "pagina", t: "Anunciante (página)", w: 30, tipo: "texto" },
  { id: "criativos", t: "Criativos", w: 10, tipo: "num" },
  { id: "emEscala", t: "Criativos em escala", w: 18, tipo: "num" },
  { id: "maxDup", t: "Maior duplicação", w: 16, tipo: "num" },
  { id: "mediaDias", t: "Média de dias no ar", w: 18, tipo: "num" },
  { id: "adv", t: "Anúncios na biblioteca", w: 20, tipo: "num" },
  { id: "termos", t: "Termos / buscas", w: 30, tipo: "texto" },
  { id: "linkPagina", t: "Ver biblioteca da página", w: 22, tipo: "link" },
  { id: "idPagina", t: "ID da página", w: 18, tipo: "texto" },
];

function _exLinkAnuncio(c) {
  return /^\d{8,20}$/.test(String(c.id || "")) ? `https://www.facebook.com/ads/library/?id=${c.id}` : "";
}
function _exLinkPagina(pid) {
  return /^\d{8,20}$/.test(String(pid || "")) ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=${pid}` : "";
}

// Transforma o acervo (+ etiquetas da equipe) em linhas ricas, já ordenadas por score.
// `meta` = viva_team_meta ({ [chave]: { by, status, statusBy, statusMs } }).
function exportMontarLinhas(acervo, meta, agora = Date.now()) {
  const m = meta && typeof meta === "object" ? meta : {};
  const linhas = (Array.isArray(acervo) ? acervo : []).filter(c => c && typeof c === "object").map(c => {
    const dias = diasNoAr(c, agora);
    const termos = Array.isArray(c.fontes) ? c.fontes : [];
    const calc = scoreCriativo({ dup: c.dup, dias, adv: c.adv, termos: termos.length });
    const tm = m[acervoKey(c)] || {};
    const tend = tendenciaCriativo(c, agora);
    const statusId = EXPORT_STATUS_LABEL[tm.status] ? tm.status : "nova";
    return {
      score: calc.score,
      emEscala: calc.emEscala ? "Sim" : "Não",
      fase: EXPORT_FASE_LABEL[c.stage] || "",
      pagina: c.nome || "",
      dominio: c.dom || "",
      dup: Number(c.dup) || 1,
      dias: dias === null ? null : dias,
      adv: Number(c.adv) || 0,
      tendencia: tend.sobe ? `Subindo +${tend.delta} (em ${tend.dias} d)` : "—",
      variacao: (Number(c.advBase) || 0) > 0 ? tend.delta : null,
      novo24: (Number(c.firstSeen) || 0) >= agora - 24 * 3600 * 1000 ? "Sim" : "Não",
      nTermos: termos.length,
      termos: termos.join(" | "),
      status: EXPORT_STATUS_LABEL[statusId],
      por: tm.by || "",
      midia: c.video ? "Vídeo" : "Imagem",
      copy: c.copy || "",
      destino: c.dest || "",
      linkAnuncio: _exLinkAnuncio(c),
      linkPagina: _exLinkPagina(c.pid),
      thumb: c.thumb || "",
      inicio: Number(c.inicio) > 0 ? Number(c.inicio) : null,
      primeira: Number(c.firstSeen) > 0 ? Number(c.firstSeen) : null,
      ultima: Number(c.lastSeen) > 0 ? Number(c.lastSeen) : null,
      idAnuncio: c.id || "",
      idPagina: c.pid || "",
    };
  });
  linhas.sort((a, b) => (b.score - a.score) || ((b.dup || 0) - (a.dup || 0)));
  linhas.forEach((l, i) => { l.rank = i + 1; });
  return linhas;
}

function _exLinhasOfertas(acervo, agora) {
  return agruparOfertas(acervo, agora).map((o, i) => ({
    rank: i + 1, score: o.score, dominio: o.dominio, criativos: o.criativos, paginas: o.paginas, emEscala: o.emEscala,
    maxDup: o.maxDup, mediaDias: Math.round(o.mediaDias), novos24: o.novos24, subindo: o.subindo,
    nomesPaginas: o.nomesPaginas.join(" · ") + (o.paginas > o.nomesPaginas.length ? " …" : ""),
    termos: o.fontes.join(" | "), destino: o.dest, melhorCopy: o.topCopy,
  }));
}

function _exLinhasPaginas(acervo, agora) {
  return agruparPaginas(acervo, agora).map((p, i) => ({
    rank: i + 1, score: p.score, pagina: p.nome, criativos: p.criativos, emEscala: p.emEscala, maxDup: p.maxDup,
    mediaDias: Math.round(p.mediaDias), adv: p.adv, termos: p.fontes.join(" | "),
    linkPagina: _exLinkPagina(p.page_id), idPagina: p.page_id,
  }));
}

// ─── formatação de data (fuso do computador) ─────────────────────────────────────────────────
function _exPad(n) { return String(n).padStart(2, "0"); }
function exportDataTexto(ms, comHora) {
  if (!ms) return "";
  const d = new Date(ms);
  const dia = `${_exPad(d.getDate())}/${_exPad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return comHora ? `${dia} ${_exPad(d.getHours())}:${_exPad(d.getMinutes())}` : dia;
}
// Número de série do Excel (dias desde 1899-12-30), no horário local do computador.
function _exSerialExcel(ms) {
  const d = new Date(ms);
  const localMs = ms - d.getTimezoneOffset() * 60000;
  return localMs / 86400000 + 25569;
}

// ─── CSV (abre direto no Excel pt-BR: UTF-8 com BOM e separador ;) ─────────────────────────────
function _exCsvCelula(v, tipo) {
  if (v === null || v === undefined || v === "") return "";
  let s;
  if (tipo === "data") s = exportDataTexto(v, false);
  else if (tipo === "datahora") s = exportDataTexto(v, true);
  else if (tipo === "num") s = typeof v === "number" && !Number.isInteger(v) ? String(v).replace(".", ",") : String(v);
  else s = String(v).replace(/[\r\n]+/g, " ");
  // texto que começa com = + - @ vira fórmula no Excel: neutraliza (anúncio de terceiros é dado não confiável)
  if (tipo !== "num" && /^[=+\-@\t]/.test(s)) s = `'${s}`;
  if (/[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv(linhas) {
  const cols = EXPORT_COLUNAS_CRIATIVOS;
  const out = [cols.map(c => _exCsvCelula(c.t, "texto")).join(";")];
  for (const l of linhas) out.push(cols.map(c => _exCsvCelula(l[c.id], c.tipo === "link" ? "texto" : c.tipo)).join(";"));
  return "\uFEFF" + out.join("\r\n") + "\r\n";
}

// ─── XLSX (zip + XML escritos à mão) ────────────────────────────────────────────────────────────
let _exCrcTabela = null;
function _exCrc32(bytes) {
  if (!_exCrcTabela) {
    _exCrcTabela = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      _exCrcTabela[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) crc = _exCrcTabela[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function _exDeflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function _exZip(arquivos) {
  const enc = new TextEncoder();
  const partes = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  for (const arq of arquivos) {
    const nome = enc.encode(arq.nome);
    const dados = typeof arq.dados === "string" ? enc.encode(arq.dados) : arq.dados;
    const crc = _exCrc32(dados);
    let comprimido = null;
    try { comprimido = await _exDeflate(dados); } catch (_) { comprimido = null; }
    const metodo = comprimido && comprimido.length < dados.length ? 8 : 0;
    const corpo = metodo === 8 ? comprimido : dados;
    const cab = Uint8Array.from([
      0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(metodo), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(corpo.length), ...u32(dados.length), ...u16(nome.length), ...u16(0),
    ]);
    partes.push(cab, nome, corpo);
    central.push(Uint8Array.from([
      0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(metodo), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(corpo.length), ...u32(dados.length), ...u16(nome.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]), nome);
    offset += cab.length + nome.length + corpo.length;
  }
  const tamCentral = central.reduce((s, p) => s + p.length, 0);
  const fim = Uint8Array.from([0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(arquivos.length), ...u16(arquivos.length), ...u32(tamCentral), ...u32(offset), ...u16(0)]);
  const todos = [...partes, ...central, fim];
  const total = todos.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of todos) { saida.set(p, pos); pos += p.length; }
  return saida;
}

function _exXml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _exColLetra(i) {
  let n = i + 1;
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Estilos (índices usados nas células)
const EXS = { PADRAO: 0, CABECALHO: 1, DATA: 2, DATAHORA: 3, INTEIRO: 4, LINK: 5, SIM: 6, TITULO: 7, NEGRITO: 8, DECIMAL: 9 };

function _exCelula(ref, valor, tipo, linhaDestaque) {
  if (valor === null || valor === undefined || valor === "") return "";
  if (tipo === "num") {
    const n = Number(valor);
    if (!Number.isFinite(n)) return "";
    return `<c r="${ref}" s="${Number.isInteger(n) ? EXS.INTEIRO : EXS.DECIMAL}"><v>${n}</v></c>`;
  }
  if (tipo === "data") return `<c r="${ref}" s="${EXS.DATA}"><v>${_exSerialExcel(valor).toFixed(5)}</v></c>`;
  if (tipo === "datahora") return `<c r="${ref}" s="${EXS.DATAHORA}"><v>${_exSerialExcel(valor).toFixed(5)}</v></c>`;
  if (tipo === "link") {
    const url = String(valor);
    if (/^https:\/\/www\.facebook\.com\/ads\/library\/\?[\w=&%.-]+$/.test(url) && url.length < 250) {
      return `<c r="${ref}" s="${EXS.LINK}" t="str"><f>HYPERLINK("${_exXml(url)}","Abrir")</f><v>Abrir</v></c>`;
    }
    return "";
  }
  let texto = String(valor).replace(/[\r\n]+/g, " ");
  if (texto.length > EXPORT_MAX_CELULA) texto = texto.slice(0, EXPORT_MAX_CELULA) + "…";
  const estilo = linhaDestaque && texto === "Sim" ? EXS.SIM : EXS.PADRAO;
  return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${_exXml(texto)}</t></is></c>`;
}

function _exAbaTabela(colunas, linhas, opcoes) {
  const o = opcoes || {};
  const nCols = colunas.length;
  const ultimaLinha = linhas.length + 1;
  const ultimaCol = _exColLetra(nCols - 1);
  const partes = [];
  partes.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  partes.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  partes.push(`<dimension ref="A1:${ultimaCol}${ultimaLinha}"/>`);
  partes.push('<sheetViews><sheetView workbookViewId="0"' + (o.primeira ? ' tabSelected="1"' : "") + '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>');
  partes.push('<sheetFormatPr defaultRowHeight="15"/>');
  partes.push("<cols>" + colunas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w || 14}" customWidth="1"/>`).join("") + "</cols>");
  partes.push("<sheetData>");
  partes.push('<row r="1" ht="32" customHeight="1">' + colunas.map((c, i) => `<c r="${_exColLetra(i)}1" s="${EXS.CABECALHO}" t="inlineStr"><is><t>${_exXml(c.t)}</t></is></c>`).join("") + "</row>");
  for (let r = 0; r < linhas.length; r += 1) {
    const linha = linhas[r];
    const n = r + 2;
    let cels = "";
    for (let i = 0; i < nCols; i += 1) {
      const c = colunas[i];
      cels += _exCelula(`${_exColLetra(i)}${n}`, linha[c.id], c.tipo, c.id === "emEscala" || c.id === "novo24");
    }
    partes.push(`<row r="${n}">${cels}</row>`);
  }
  partes.push("</sheetData>");
  if (linhas.length > 0) partes.push(`<autoFilter ref="A1:${ultimaCol}${ultimaLinha}"/>`);
  if (o.escalaCor && linhas.length > 0) {
    const idx = colunas.findIndex(c => c.id === o.escalaCor);
    if (idx >= 0) {
      const L = _exColLetra(idx);
      partes.push(`<conditionalFormatting sqref="${L}2:${L}${ultimaLinha}"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting>`);
    }
  }
  partes.push("</worksheet>");
  return partes.join("");
}

function _exAbaTexto(linhas, larguras) {
  const partes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  partes.push('<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>');
  partes.push("<cols>" + larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + "</cols><sheetData>");
  linhas.forEach((cels, r) => {
    const n = r + 1;
    const xml = cels.map((cel, i) => {
      if (cel === null || cel === undefined || cel === "") return "";
      const obj = typeof cel === "object" ? cel : { v: cel };
      return `<c r="${_exColLetra(i)}${n}" s="${obj.s || EXS.PADRAO}" t="inlineStr"><is><t xml:space="preserve">${_exXml(String(obj.v).slice(0, EXPORT_MAX_CELULA))}</t></is></c>`;
    }).join("");
    partes.push(`<row r="${n}">${xml}</row>`);
  });
  partes.push("</sheetData></worksheet>");
  return partes.join("");
}

const EXPORT_ESTILOS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="166" formatCode="0.0"/></numFmts>'
  + '<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
  + '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="16"/><color rgb="FF1F2A44"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2A44"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="10">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function _exLeiaMe(info, linhas, nOfertas, nPaginas, agora) {
  const i = info || {};
  const L = [];
  L.push([{ v: `${EXPORT_APP} — planilha de criativos`, s: EXS.TITULO }]);
  L.push([]);
  L.push([{ v: "Gerada em", s: EXS.NEGRITO }, exportDataTexto(agora, true)]);
  L.push([{ v: "Origem", s: EXS.NEGRITO }, i.origem || "Download manual (Centro de Inteligência)"]);
  L.push([{ v: "Recorte", s: EXS.NEGRITO }, i.recorte || "Acervo inteiro"]);
  if (i.filtros) L.push([{ v: "Filtros aplicados", s: EXS.NEGRITO }, i.filtros]);
  L.push([{ v: "Criativos neste arquivo", s: EXS.NEGRITO }, String(linhas.length)]);
  L.push([{ v: "Ofertas (domínios) / Bibliotecas", s: EXS.NEGRITO }, `${nOfertas} / ${nPaginas}`]);
  if (i.versao) L.push([{ v: "Versão da extensão", s: EXS.NEGRITO }, i.versao]);
  L.push([]);
  L.push([{ v: "Como usar", s: EXS.TITULO }]);
  L.push(["1.", "Aba “Criativos”: uma linha por criativo, já ordenada pelo score. Use as setas do cabeçalho para filtrar/ordenar (por oferta, por termos, por status…)."]);
  L.push(["2.", "Aba “Ofertas”: junta os criativos pelo DOMÍNIO de destino. Muitas páginas no mesmo domínio = oferta sendo escalada por vários afiliados."]);
  L.push(["3.", "Aba “Bibliotecas”: o mesmo por anunciante (página)."]);
  L.push(["4.", "As colunas “Ver anúncio” e “Ver biblioteca da página” abrem a Meta Ad Library direto no item."]);
  L.push([]);
  L.push([{ v: "Dicionário das colunas (aba Criativos)", s: EXS.TITULO }]);
  EXPORT_COLUNAS_CRIATIVOS.forEach(c => L.push([{ v: c.t, s: EXS.NEGRITO }, c.d]));
  L.push([]);
  L.push([{ v: "Limites a ter em mente", s: EXS.TITULO }]);
  L.push(["•", "Banco da equipe: limite de 150 mil anúncios; nada é apagado sozinho — a limpeza é manual, no Centro de Inteligência."]);
  L.push(["•", "Em cada computador ficam até 10.000 criativos, e saem os que não aparecem há 30 dias."]);
  L.push(["•", "“Dias no ar” é calculado no momento do download. Links de imagem da Meta expiram com o tempo."]);
  L.push(["•", "“Em escala” é uma heurística (duplicados + tempo no ar), não garantia de lucro: valide a oferta antes de investir."]);
  return L;
}

// Gera o arquivo XLSX (Uint8Array). `linhas` vem de exportMontarLinhas; `acervoBase` = os mesmos criativos
// (para montar as abas de Ofertas e Bibliotecas). `info` = { origem, recorte, filtros, versao }.
async function exportXlsx(linhas, acervoBase, info, agora = Date.now()) {
  const ofertas = _exLinhasOfertas(acervoBase, agora);
  const paginas = _exLinhasPaginas(acervoBase, agora);
  const nomes = ["Criativos", "Ofertas", "Bibliotecas", "Leia-me"];
  const abas = [
    _exAbaTabela(EXPORT_COLUNAS_CRIATIVOS, linhas, { primeira: true, escalaCor: "score" }),
    _exAbaTabela(EXPORT_COLUNAS_OFERTAS, ofertas, { escalaCor: "score" }),
    _exAbaTabela(EXPORT_COLUNAS_PAGINAS, paginas, { escalaCor: "score" }),
    _exAbaTexto(_exLeiaMe(info, linhas, ofertas.length, paginas.length, agora), [34, 120]),
  ];
  const arquivos = [
    { nome: "[Content_Types].xml", dados: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + nomes.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { nome: "_rels/.rels", dados: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { nome: "xl/workbook.xml", dados: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' + nomes.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + "</sheets></workbook>" },
    { nome: "xl/_rels/workbook.xml.rels", dados: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + nomes.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + `<Relationship Id="rId${nomes.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { nome: "xl/styles.xml", dados: EXPORT_ESTILOS_XML },
    ...abas.map((xml, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, dados: xml })),
  ];
  return _exZip(arquivos);
}

function exportNomeArquivo(rotulo, ext, n, agora = Date.now()) {
  const d = new Date(agora);
  const carimbo = `${d.getFullYear()}-${_exPad(d.getMonth() + 1)}-${_exPad(d.getDate())}_${_exPad(d.getHours())}h${_exPad(d.getMinutes())}`;
  const limpo = String(rotulo || "acervo").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "acervo";
  return `VivaSpy_${limpo}_${carimbo}_${n}-criativos.${ext}`;
}

const EXPORT_MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv;charset=utf-8",
};

// Atalho: devolve { bytes|texto, mime, nome } pronto para baixar.
async function exportGerar(formato, acervo, meta, info, rotulo, agora = Date.now()) {
  const linhas = exportMontarLinhas(acervo, meta, agora);
  if (formato === "csv") {
    return { dados: new TextEncoder().encode(exportCsv(linhas)), mime: EXPORT_MIME.csv, nome: exportNomeArquivo(rotulo, "csv", linhas.length, agora), linhas: linhas.length };
  }
  const bytes = await exportXlsx(linhas, acervo, info, agora);
  return { dados: bytes, mime: EXPORT_MIME.xlsx, nome: exportNomeArquivo(rotulo, "xlsx", linhas.length, agora), linhas: linhas.length };
}
