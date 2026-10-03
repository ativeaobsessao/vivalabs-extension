// Parses mixed quoted/unquoted terms into Meta Ad Library search plans.
function parseBuscaInput(rawText) {
  const entries = String(rawText || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length >= 2)
    .map(original => ({
      original,
      term: original.replace(/["“”]/g, "").trim(),
    }))
    .filter(entry => entry.term.length >= 2);
  if (entries.length === 0) return { modo: "vazio" };

  if (entries.length === 1) {
    return {
      modo: "normal",
      termoOriginal: entries[0].original,
      termoBusca: entries[0].term,
      linhasReais: 1,
    };
  }

  return {
    modo: "turbo",
    termosOriginais: entries.map(entry => entry.original),
    termosBusca: entries.map(entry => entry.term),
    linhasReais: entries.length,
    tempoEstimado: entries.length * 60,
  };
}

function buildAdLibraryUrl(termo) {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: "ALL",
    is_targeted_country: "false",
    media_type: "all",
    q: String(termo || ""),
    search_type: "keyword_unordered",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function parseLinhaInteligente(linha) {
  const regex = /"([^"]+)"|(\S+)/g;
  const tokens = [];
  let match;
  while ((match = regex.exec(String(linha))) !== null) {
    if (match[1]) tokens.push({ term: match[1].trim(), exact: true });
    else if (match[2]) tokens.push({ term: match[2].trim(), exact: false });
  }
  return tokens.filter(token => token.term.length > 0);
}

function gerarPlanoBusca(tokens, linhaOriginal, lineId = "0", options = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const includeBroad = options.broad !== false;
  const includeExact = options.exact !== false;
  const amplo = tokens.map(token => token.term).join(" ");
  const baseUrl = "https://www.facebook.com/ads/library/";
  const makeUrl = (query) => {
    const params = new URLSearchParams({
      active_status: "active",
      ad_type: "all",
      country: "ALL",
      q: query,
      search_type: "keyword_unordered",
    });
    return `${baseUrl}?${params.toString()}`;
  };
  const plans = includeBroad ? [{
    q: amplo,
    tipo: "amplo_base",
    termo: amplo,
    linhaOriginal,
    lineId,
    planId: `${lineId}:base`,
    url: makeUrl(amplo),
  }] : [];

  (includeExact ? tokens.filter(token => token.exact) : []).forEach((token, index) => {
    const query = `"${token.term}"`;
    plans.push({
      q: query,
      tipo: "exato_filtro",
      termo: token.term,
      linhaOriginal,
      lineId,
      planId: `${lineId}:exact:${index}`,
      url: makeUrl(query),
    });
  });

  return plans;
}

function gerarFilaInteligente(linhas) {
  if (!Array.isArray(linhas)) return [];
  const parsed = parseBuscaInput(linhas.join("\n"));
  if (parsed.modo !== "turbo") return [];
  return parsed.termosBusca.map((termo, index) => {
    const linhaOriginal = parsed.termosOriginais[index];
    const lineId = String(index);
    return {
      q: termo,
      tipo: "linha",
      termo,
      linhaOriginal,
      lineId,
      planId: `${lineId}:base`,
      url: buildAdLibraryUrl(termo),
    };
  });
}
