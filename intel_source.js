// De onde o Centro lê: o BANCO da equipe (150 mil, filtra e pagina no servidor) ou, enquanto ele não
// estiver ligado, o acervo deste computador. As duas fontes têm a MESMA interface.
// Depende de ranking_engine.js, intel_core.js e team_sync.js (teamConfig, teamRpc).

const INTEL_LOTE_ACAO = 1000;
const INTEL_NICHOS_LOCAIS_KEY = "viva_nichos_manuais";

function intelLotes(lista, tamanho = INTEL_LOTE_ACAO) {
  return Array.from({ length: Math.ceil(lista.length / tamanho) }, (_, i) => lista.slice(i * tamanho, (i + 1) * tamanho));
}

async function intelLerLocal(chave, padrao) {
  const data = await chrome.storage.local.get(chave);
  return data[chave] === undefined || data[chave] === null ? padrao : data[chave];
}

// Tira do computador o que foi apagado (e impede que volte na próxima coleta).
async function intelApagarNoComputador(alvo) {
  const r = await chrome.runtime.sendMessage({ action: "ACERVO_DELETE", bloquear: true, ...alvo });
  if (r && r.status === "error") throw new Error(r.error || "Não consegui apagar neste computador.");
  return r || {};
}

// Alvo de bloqueio ('p:ID', 'n:nome' ou 'd:domínio') → formato da lista de bloqueio local.
function intelAlvoLocal(alvo) {
  if (alvo.startsWith("d:")) return { dominios: [alvo.slice(2)] };
  return { paginas: [alvo.startsWith("p:") ? alvo.slice(2) : `n:${alvo.slice(2).toLowerCase()}`] };
}

function intelAlvoDaPagina(rec) {
  if (rec.pid) return `p:${rec.pid}`;
  return rec.nome ? `n:${rec.nome}` : "";
}

// ── Banco da equipe ──────────────────────────────────────────────────────────────────────────────
async function intelLerTudoDoBanco(rpc, chaves) {
  const quero = new Set(chaves);
  const achados = [];
  let cursor = 0;
  for (let pagina = 0; pagina < 1000 && quero.size; pagina += 1) {
    const linhas = await rpc("viva_pull", { p_since: cursor, p_limit: INTEL_LOTE_ACAO });
    if (!Array.isArray(linhas) || !linhas.length) break;
    cursor = linhas.reduce((max, l) => Math.max(max, Number(l.seq) || 0), cursor);
    linhas.forEach(l => { if (l && l.rec && quero.delete(l.key)) achados.push(l); });
    if (linhas.length < INTEL_LOTE_ACAO) break;
  }
  return achados;
}

function intelFonteBanco(cfg) {
  const rpc = (fn, args) => teamRpc(fn, { p_token: cfg.code, ...(args || {}) });
  const vistos = new Map(); // itens já mostrados, para exportar a seleção sem ler o banco todo
  const lembrar = itens => itens.forEach(i => vistos.set(i.key, i));
  const filtros = f => intelFiltrosEnxutos(f);
  return {
    modo: "banco",
    nome: cfg.name,
    info: () => rpc("viva_info"),
    opcoes: () => rpc("viva_opcoes"),
    async buscar(f, ordem, pagina) {
      const r = await rpc("viva_buscar", { p_filtros: filtros(f), p_ordem: ordem, p_pagina: pagina, p_tamanho: INTEL_PAGINA });
      lembrar(r.itens);
      return r;
    },
    grupos: (tipo, f, pagina) => rpc("viva_grupos", { p_tipo: tipo, p_filtros: filtros(f), p_pagina: pagina, p_tamanho: INTEL_PAGINA }),
    chaves: (f, limite = 20000) => rpc("viva_chaves", { p_filtros: filtros(f), p_limite: limite }),
    async marcar(keys, status) {
      for (const lote of intelLotes(keys)) await rpc("viva_marcar", { p_keys: lote, p_status: status, p_by: cfg.name });
    },
    async apagar(keys) {
      let n = 0;
      for (const lote of intelLotes(keys)) n += await rpc("viva_apagar", { p_keys: lote });
      await intelApagarNoComputador({ chaves: keys });
      return n;
    },
    async apagarDescartados(aoAndar) {
      let apagados = 0;
      for (let volta = 0; volta < 200; volta += 1) {
        const r = await rpc("viva_apagar_descartados", { p_limite: 2000 });
        apagados += r.apagados;
        if (aoAndar) aoAndar(apagados, r.restam);
        if (!r.restam || !r.apagados) break;
      }
      return apagados;
    },
    async bloquear(alvo) {
      const n = await rpc("viva_bloquear", { p_alvo: alvo });
      await intelApagarNoComputador(intelAlvoLocal(alvo));
      return n;
    },
    async desbloquear() {
      await rpc("viva_desbloquear");
      await chrome.runtime.sendMessage({ action: "LIXEIRA_CLEAR" });
    },
    definirNicho: (key, nicho) => rpc("viva_definir_nicho", { p_key: key, p_nicho: nicho || null }),
    async registros(keys) {
      if (keys.every(k => vistos.has(k))) return keys.map(k => vistos.get(k));
      return intelLerTudoDoBanco(rpc, keys);
    },
  };
}

// ── Só este computador ───────────────────────────────────────────────────────────────────────────
async function intelItensLocais() {
  const [acervo, meta, manuais] = await Promise.all([
    intelLerLocal(VIVA_ACERVO_KEY, []), intelLerLocal("viva_team_meta", {}), intelLerLocal(INTEL_NICHOS_LOCAIS_KEY, {}),
  ]);
  const agora = Date.now();
  return acervo.filter(c => c && acervoKey(c)).map(c => intelItem(c, meta[acervoKey(c)], manuais[acervoKey(c)], agora));
}

function intelPaginar(lista, pagina) {
  return { total: lista.length, itens: lista.slice(pagina * INTEL_PAGINA, (pagina + 1) * INTEL_PAGINA) };
}

function intelMaisUsados(valores, limite) {
  const conta = new Map();
  valores.forEach(v => conta.set(v, (conta.get(v) || 0) + 1));
  return Array.from(conta).sort((a, b) => b[1] - a[1]).slice(0, limite).map(([v]) => v);
}

function intelFonteLocal(aviso) {
  const filtrados = async f => { const agora = Date.now(); return (await intelItensLocais()).filter(i => intelPassa(i, f, agora)); };
  return {
    modo: "local",
    aviso,
    async info() {
      const itens = await intelItensLocais();
      const lixeira = lixeiraNormalizar(await intelLerLocal(VIVA_LIXEIRA_KEY, null));
      return {
        total: itens.length, bytes: 0,
        descartados: itens.filter(i => i.status === "descartada").length,
        bloqueados: lixeira.chaves.length + lixeira.paginas.length + lixeira.dominios.length,
      };
    },
    async opcoes() {
      const itens = await intelItensLocais();
      return {
        termos: intelMaisUsados(itens.flatMap(i => i.rec.fontes || []), 60),
        quem: intelMaisUsados(itens.map(i => i.by).filter(Boolean), 40),
      };
    },
    async buscar(f, ordem, pagina) { return intelPaginar(intelOrdenar(await filtrados(f), ordem), pagina); },
    async grupos(tipo, f, pagina) { return intelPaginar(intelGrupos(await filtrados(f), tipo), pagina); },
    async chaves(f) { return intelOrdenar(await filtrados(f), "score").map(i => i.key); },
    async marcar(keys, status) {
      const r = await chrome.runtime.sendMessage({ action: "TEAM_SET_STATUS_LOTE", keys, novoStatus: status });
      if (r && r.status === "error") throw new Error(r.error);
    },
    async apagar(keys) { return (await intelApagarNoComputador({ chaves: keys })).removidos || 0; },
    async apagarDescartados() {
      const keys = (await intelItensLocais()).filter(i => i.status === "descartada").map(i => i.key);
      return keys.length ? this.apagar(keys) : 0;
    },
    async bloquear(alvo) { return (await intelApagarNoComputador(intelAlvoLocal(alvo))).removidos || 0; },
    async desbloquear() { await chrome.runtime.sendMessage({ action: "LIXEIRA_CLEAR" }); },
    async definirNicho(key, nicho) {
      const manuais = await intelLerLocal(INTEL_NICHOS_LOCAIS_KEY, {});
      const { [key]: _antigo, ...resto } = manuais;
      await chrome.storage.local.set({ [INTEL_NICHOS_LOCAIS_KEY]: nicho ? { ...resto, [key]: nicho } : resto });
    },
    async registros(keys) {
      const quero = new Set(keys);
      return (await intelItensLocais()).filter(i => quero.has(i.key));
    },
  };
}

// Escolhe a fonte. Falha de rede NÃO cai para o computador em silêncio: o erro sobe para a tela.
async function intelCriarFonte() {
  const cfg = await teamConfig();
  if (!cfg) return intelFonteLocal("sem-equipe");
  const fonte = intelFonteBanco(cfg);
  try {
    const info = await fonte.info();
    return info && Number(info.versao) >= 2 ? fonte : intelFonteLocal("sem-sql");
  } catch (error) {
    if (/could not find the function|PGRST202|does not exist|schema cache/i.test(String(error.message))) return intelFonteLocal("sem-sql");
    throw error;
  }
}
