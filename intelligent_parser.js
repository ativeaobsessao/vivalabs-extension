// Parses mixed quoted/unquoted terms into Meta Ad Library search plans.
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

function gerarFilaInteligente(linhas, options = {}) {
  if (!Array.isArray(linhas)) return [];
  return linhas.flatMap((linha, index) => {
    const original = String(linha ?? "").trim();
    if (!original) return [];
    return gerarPlanoBusca(parseLinhaInteligente(original), original, String(index), options);
  });
}
