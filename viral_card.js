// Cartão "Salvar post viral" por cima do TikTok, Instagram e YouTube Shorts.
// Depende de viral_url.js (reconhece o link) e viral_page.js (acha o post no meio de um feed).
(() => {
  if (window.top !== window || window.__vivaViralCard) return;
  window.__vivaViralCard = true;

  const JOBS_KEY = "viva_viral_jobs";
  const NICHOS_KEY = "viva_viral_nichos";
  const MIN_KEY = "viva_viral_card_min";
  const GEO_KEY = "viva_viral_geo";
  const ON_KEY = "viva_monitor_enabled";
  const INTERVALO_MS = 700;
  const LEITURAS_DE_IDIOMA = 8;
  const LEITURAS_SEM_POST = 3;
  const URL_INICIAL = location.href;
  const IDIOMAS = {
    en: "Inglês", es: "Espanhol", pt: "Português", fr: "Francês", de: "Alemão", it: "Italiano",
    nl: "Holandês", pl: "Polonês", sv: "Sueco", da: "Dinamarquês", no: "Norueguês", fi: "Finlandês",
    ro: "Romeno", cs: "Tcheco", el: "Grego", hu: "Húngaro", tr: "Turco", ru: "Russo", ar: "Árabe",
    he: "Hebraico", hi: "Hindi", id: "Indonésio", vi: "Vietnamita", th: "Tailandês", ja: "Japonês",
    ko: "Coreano", zh: "Chinês",
  };
  const IDIOMAS_COMUNS = ["en", "es", "pt", "fr", "de", "it"];
  const IDIOMA_APELIDOS = { iw: "he", in: "id", nb: "no", nn: "no" };
  const GEOS = ["US", "GB", "CA", "AU", "NZ", "IE", "DE", "FR", "ES", "IT", "NL", "SE", "NO", "DK", "PL", "PT", "BR", "MX", "AR", "CO", "CL", "ZA", "IN", "JP"];

  const estado = {
    ligado: false, min: false, geo: "US", nichos: [],
    chave: null, post: null, semPost: 0, candidato: "",
    escolhido: null, jobId: null, salvo: false, idiomaManual: false, leituras: 0, legenda: "",
  };

  // ─── Tela ──────────────────────────────────────────────────────────────────

  function el(tag, props = {}, ...filhos) {
    const no = Object.assign(document.createElement(tag), props);
    no.append(...filhos);
    return no;
  }

  const host = el("div", { id: "viva-viral-card" });
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;display:none;";
  const shadow = host.attachShadow({ mode: "open" });

  const ui = {
    bolha: el("button", { type: "button", className: "bolha", textContent: "Salvar post" }),
    cartao: el("section", { className: "cartao" }),
    minimizar: el("button", { type: "button", className: "min", textContent: "–", title: "Minimizar" }),
    link: el("div", { className: "link" }),
    vazio: el("p", { className: "vazio", textContent: "Clique no post (ou abra) para salvar." }),
    form: el("div", { className: "form" }),
    idioma: el("select", { className: "idioma" }),
    geo: el("select", { className: "geo" }),
    pilulas: el("div", { className: "pilulas" }),
    input: el("input", { type: "text", maxLength: 40, placeholder: "Digite aqui…", autocomplete: "off" }),
    sugestoes: el("datalist", { id: "viva-nichos" }),
    salvar: el("button", { type: "button", className: "salvar", textContent: "Salvar" }),
    aviso: el("div", { className: "aviso" }),
    avisoTexto: el("span"),
    desfazer: el("button", { type: "button", className: "desfazer", textContent: "Desfazer" }),
  };
  ui.input.setAttribute("list", "viva-nichos");
  ui.input.setAttribute("aria-label", "Digitar outro nicho");
  ui.cartao.setAttribute("aria-label", "Salvar post viral");
  ui.aviso.setAttribute("role", "status");

  ui.idioma.append(el("option", { value: "", textContent: "—" }),
    ...Object.entries(IDIOMAS).map(([value, textContent]) => el("option", { value, textContent })));
  ui.geo.append(el("option", { value: "", textContent: "—" }),
    ...GEOS.map(codigo => el("option", { value: codigo, textContent: codigo })));

  ui.aviso.append(ui.avisoTexto, ui.desfazer);
  ui.form.append(
    el("div", { className: "linha" },
      el("label", {}, el("span", { textContent: "Idioma" }), ui.idioma),
      el("label", { className: "curto" }, el("span", { textContent: "GEO" }), ui.geo)),
    el("div", { className: "rotulo", textContent: "Nicho: toque em um" }),
    ui.pilulas,
    el("div", { className: "rotulo", textContent: "Ou digite outro nicho:" }),
    el("div", { className: "digitar" }, ui.input, ui.salvar),
    ui.sugestoes,
    ui.aviso,
  );
  ui.cartao.append(
    el("header", {}, el("strong", { textContent: "Salvar post viral" }), ui.minimizar),
    ui.link, ui.vazio, ui.form,
  );

  const estilo = el("style", { textContent: `
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    [hidden] { display: none !important; }
    button, select, input { font-size: 12.5px; color: #1d1d1f; }
    button { cursor: pointer; }
    .cartao, .bolha { background: #fff; color: #1d1d1f; border: 1px solid rgba(0,0,0,.08); box-shadow: 0 10px 34px rgba(0,0,0,.35); }
    .cartao { width: 296px; max-height: calc(100vh - 32px); overflow-y: auto; border-radius: 16px; padding: 12px 14px 14px; }
    .bolha { border-radius: 999px; padding: 9px 16px; font-weight: 600; }
    header { display: flex; align-items: center; justify-content: space-between; }
    header strong { font-size: 13.5px; }
    .min { border: 0; background: #f0f0f3; border-radius: 999px; width: 24px; height: 24px; line-height: 1; }
    .link { font-size: 11px; color: #6e6e73; margin: 4px 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .vazio { font-size: 12.5px; color: #6e6e73; line-height: 1.4; }
    .linha { display: flex; gap: 8px; }
    label { flex: 1; font-size: 11px; color: #6e6e73; display: flex; flex-direction: column; gap: 3px; }
    label.curto { flex: 0 0 84px; }
    select, input { background: #f5f5f7; border: 1px solid #e3e3e8; border-radius: 8px; padding: 6px 8px; width: 100%; }
    .rotulo { font-size: 11px; font-weight: 600; color: #6e6e73; margin: 10px 0 6px; }
    .pilulas { display: flex; flex-wrap: wrap; gap: 6px; max-height: 128px; overflow-y: auto; }
    .pilula { background: #f0f0f3; border: 1px solid transparent; border-radius: 999px; padding: 6px 11px; }
    .pilula:hover { border-color: #0071e3; }
    .pilula[aria-pressed="true"] { background: #0071e3; color: #fff; }
    .digitar { display: flex; gap: 6px; }
    .digitar input { flex: 1; min-width: 0; border-color: #b9b9c0; background: #fff; }
    .salvar { background: #0071e3; color: #fff; border: 0; border-radius: 8px; padding: 0 12px; font-weight: 600; }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #0071e3; outline-offset: 1px; }
    .aviso { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; border-radius: 10px; padding: 8px 10px; font-size: 12px; line-height: 1.35; background: #f0f0f3; }
    .aviso[data-tipo="ok"] { background: #e3f6e8; }
    .aviso[data-tipo="erro"] { background: #ffe8e6; }
    .desfazer { background: #fff; border: 1px solid #d2d2d7; border-radius: 7px; padding: 4px 9px; font-weight: 600; flex-shrink: 0; }
  ` });
  shadow.append(estilo, ui.bolha, ui.cartao);

  function aviso(tipo, texto = "", podeDesfazer = false) {
    ui.aviso.hidden = !texto;
    ui.aviso.dataset.tipo = tipo;
    ui.avisoTexto.textContent = texto;
    ui.desfazer.hidden = !podeDesfazer;
  }

  const semAcento = texto => String(texto).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

  function desenharPilulas() {
    const escolhido = semAcento(estado.escolhido || "");
    const nomes = [...estado.nichos];
    if (escolhido && !nomes.some(nome => semAcento(nome) === escolhido)) nomes.push(estado.escolhido);
    ui.pilulas.replaceChildren(...nomes.map(nome => {
      const botao = el("button", { type: "button", className: "pilula", textContent: nome });
      botao.setAttribute("aria-pressed", String(semAcento(nome) === escolhido));
      botao.addEventListener("click", () => salvar(nome));
      return botao;
    }));
    ui.sugestoes.replaceChildren(...nomes.map(value => el("option", { value })));
  }

  function escolher(nome) {
    estado.escolhido = nome;
    desenharPilulas();
  }

  function desenharForma() {
    ui.bolha.hidden = !estado.min;
    ui.cartao.hidden = estado.min;
    ui.bolha.textContent = estado.salvo ? "Post salvo ✓" : "Salvar post";
    const temPost = Boolean(estado.post);
    ui.vazio.hidden = temPost;
    ui.form.hidden = !temPost;
    ui.link.hidden = !temPost;
    if (temPost) {
      ui.link.textContent = estado.post.url.replace(/^https:\/\/(www\.)?/, "");
      ui.link.title = estado.post.url;
    }
  }

  // ─── Página: qual post, que legenda, em que idioma ─────────────────────────

  // null = esta página não tem post; "indefinido" = é um feed, mas não dá para saber qual.
  function postDaTela() {
    const direto = viralParseUrl(location.href);
    if (direto) return { ...direto, direto: true };
    if (!viralIsFeed(location.href)) return null;
    const achado = viralFindPostOnScreen();
    const post = achado && viralParseUrl(achado.url);
    return post ? { ...post, autor: post.autor || achado.autor } : "indefinido";
  }

  // Entre os elementos visíveis que combinam, o que está mais perto do meio da tela.
  function pertoDoCentro(seletor) {
    const centro = innerHeight / 2;
    return Array.from(document.querySelectorAll(seletor))
      .map(no => ({ no, r: no.getBoundingClientRect() }))
      .filter(({ no, r }) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && no.innerText?.trim())
      .map(item => ({ ...item, distancia: Math.abs((item.r.top + item.r.bottom) / 2 - centro) }))
      .sort((a, b) => a.distancia - b.distancia);
  }

  function lerLegenda(post) {
    const { plataforma } = post;
    // A descrição que veio com a página só vale para o post com que ela foi aberta.
    const doCarregamento = viralParseUrl(URL_INICIAL)?.url === post.url
      ? document.querySelector('meta[property="og:description"]')?.content || ""
      : "";
    if (plataforma === "instagram") {
      const citada = doCarregamento.match(/:\s*["“]([\s\S]+)["”]\s*\.?\s*$/); // …: "legenda".
      if (citada) return citada[1].replace(/\s+/g, " ").trim().slice(0, 500);
    }
    let achados = [];
    if (plataforma === "tiktok") {
      achados = pertoDoCentro('[data-e2e="browse-video-desc"]');
      if (!achados.length) achados = pertoDoCentro('[data-e2e="video-desc"]');
    } else if (plataforma === "youtube") {
      achados = pertoDoCentro("yt-shorts-video-title-view-model, ytd-reel-player-header-renderer h2");
    } else {
      achados = pertoDoCentro('div[role="dialog"] h1, article h1, main h1');
      if (!achados.length) {
        // Sem título: o texto mais longo da publicação do meio da tela é a legenda.
        achados = pertoDoCentro('article span[dir="auto"], main span[dir="auto"]')
          .filter(({ no, distancia }) => distancia < innerHeight / 2 && no.innerText.trim().length >= 20
            && !no.querySelector('a[href*="/legal/"]'))
          .sort((a, b) => b.no.innerText.length - a.no.innerText.length);
      }
    }
    let texto = achados[0]?.no.innerText || "";
    if (!texto && plataforma !== "instagram") texto = doCarregamento;
    if (!texto && plataforma === "youtube") {
      texto = document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");
      if (texto === "YouTube") texto = "";
    }
    return texto.replace(/\s+/g, " ").trim().slice(0, 500);
  }

  // Hashtags, @ e links ficam de fora: enganam o detector. Em frase curta o detector do Chrome diz
  // "100%" mesmo errando, então sem confiança só vale um idioma comum numa frase não tão curta.
  function detectarIdioma(legenda) {
    const texto = legenda.replace(/https?:\/\/\S+/g, " ").replace(/[@#][\p{L}\p{N}\p{M}_.]+/gu, " ")
      .replace(/[^\p{L}\p{M}'\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (texto.length < 16 || !chrome.i18n?.detectLanguage) return Promise.resolve("");
    return new Promise(resolve => chrome.i18n.detectLanguage(texto, resultado => {
      const melhor = resultado?.languages?.[0];
      if (!melhor) return resolve("");
      const codigo = melhor.language.split("-")[0];
      const final = IDIOMA_APELIDOS[codigo] || codigo;
      const confiavel = resultado.isReliable
        ? melhor.percentage >= 60
        : melhor.percentage >= 90 && texto.length >= 28 && IDIOMAS_COMUNS.includes(final);
      resolve(confiavel && IDIOMAS[final] ? final : "");
    }));
  }

  // A legenda às vezes aparece depois do vídeo; lê algumas vezes enquanto ninguém escolheu.
  async function preencherIdioma() {
    const parado = () => estado.idiomaManual || estado.salvo || estado.jobId;
    if (!estado.post || parado() || estado.leituras >= LEITURAS_DE_IDIOMA) return;
    estado.leituras++;
    const chave = estado.chave;
    const legenda = lerLegenda(estado.post);
    if (!legenda) return;
    estado.legenda = legenda;
    const idioma = await detectarIdioma(legenda);
    if (estado.chave === chave && !parado()) ui.idioma.value = idioma;
  }

  // ─── Salvar e acompanhar ───────────────────────────────────────────────────

  async function enviar(mensagem) {
    try {
      return await chrome.runtime.sendMessage(mensagem);
    } catch (error) {
      console.warn("[Viva Spy] extensão sem resposta:", error.message);
      return null;
    }
  }

  async function lerJobs() {
    return (await chrome.storage.local.get(JOBS_KEY))[JOBS_KEY] || [];
  }

  function desenharJob(job) {
    if (!job) return;
    const nicho = job.nicho ? ` · ${job.nicho}` : "";
    estado.salvo = job.status === "salvo" || job.status === "mantido";
    if (job.status === "salvo") {
      escolher(job.nicho);
      aviso("ok", job.podeDesfazer ? `Salvo ✓${nicho}` : `Já estava salvo. Atualizado ✓${nicho}`, job.podeDesfazer);
    } else if (job.status === "pendente") {
      if (job.cancelar) aviso("espera", "Desfazendo…");
      else if (job.erro) aviso("espera", "Na fila, tentando de novo sozinho.", true);
      else aviso("espera", "Salvando…", true);
    } else if (job.status === "removendo") {
      aviso("espera", "Desfazendo…");
    } else if (job.status === "desfeito") {
      escolher(null);
      aviso("espera", "Desfeito. O post não ficou salvo.");
    } else if (job.status === "mantido") {
      aviso("ok", "Já estava salvo antes. Não foi apagado.");
    } else {
      aviso("erro", `Não salvou: ${job.erro || "tente de novo."}`);
    }
    desenharForma();
  }

  async function salvar(nome) {
    const post = estado.post;
    if (!post) return;
    const nicho = String(nome || "").replace(/\s+/g, " ").trim();
    if (!nicho) {
      aviso("erro", "Toque em um nicho ou digite um.");
      ui.input.focus();
      return;
    }
    const legenda = lerLegenda(post) || estado.legenda;
    estado.idiomaManual = true; // o que foi enviado não muda mais na tela
    escolher(nicho);
    aviso("espera", "Salvando…");
    const resposta = await enviar({
      action: "VIRAL_SAVE", url: post.url, autor: post.autor, nicho,
      idioma: ui.idioma.value, geo: ui.geo.value, legenda,
    });
    if (estado.chave !== post.url) return;
    if (!resposta?.ok) return aviso("erro", resposta?.error || "Não salvou. Recarregue a página (F5) e tente de novo.");
    estado.jobId = resposta.id;
    ui.input.value = "";
    desenharJob((await lerJobs()).find(job => job.id === resposta.id));
  }

  async function consultar(url) {
    const doPost = (await lerJobs()).filter(job => job.url === url).pop();
    const emAndamento = doPost && ["pendente", "removendo"].includes(doPost.status);
    if (estado.chave !== url || estado.jobId) return;
    if (emAndamento) {
      estado.jobId = doPost.id;
      return desenharJob(doPost);
    }
    const resposta = await enviar({ action: "VIRAL_STATUS", url });
    if (estado.chave !== url || estado.jobId || !resposta?.ok || !resposta.salvo) return;
    estado.salvo = true;
    if (!estado.idiomaManual && resposta.idioma) ui.idioma.value = resposta.idioma;
    if (resposta.geo) ui.geo.value = resposta.geo;
    escolher(resposta.nicho);
    aviso("ok", resposta.nicho
      ? `Já salvo ✓ · ${resposta.nicho}. Toque em outro para corrigir.`
      : "Já salvo ✓, sem nicho. Escolha um.");
    desenharForma();
  }

  function trocarPost(post) {
    Object.assign(estado, {
      chave: post?.url || "", post, escolhido: null, jobId: null, salvo: false,
      idiomaManual: false, leituras: 0, legenda: "",
    });
    ui.input.value = "";
    ui.idioma.value = "";
    ui.geo.value = estado.geo;
    aviso("espera");
    desenharPilulas();
    desenharForma();
    if (!post) return;
    consultar(post.url).catch(error => console.warn("[Viva Spy]", error.message));
    enviar({ action: "VIRAL_NICHOS" }).then(resposta => {
      if (!resposta?.nomes) return;
      estado.nichos = resposta.nomes;
      desenharPilulas();
    });
  }

  // ─── Ciclo ─────────────────────────────────────────────────────────────────

  let relogio = null;

  function esconder() {
    host.style.display = "none";
  }

  function conferir() {
    if (!chrome.runtime?.id) { // extensão recarregada: esta cópia do script não serve mais
      clearInterval(relogio);
      return host.remove();
    }
    if (document.visibilityState !== "visible") return;
    if (!estado.ligado || document.fullscreenElement) return esconder();
    // Digitando: o cartão fica preso no post em que a pessoa começou a escrever.
    const digitando = estado.post && shadow.activeElement === ui.input && ui.input.value.trim();
    if (!digitando) {
      const achado = postDaTela();
      if (achado === null) return esconder();
      if (achado === "indefinido") {
        estado.semPost++;
        if (estado.semPost >= LEITURAS_SEM_POST && estado.chave !== "") trocarPost(null);
        if (estado.chave === null) return;
      } else {
        estado.semPost = 0;
        // No feed, só troca quando duas leituras seguidas concordam: durante a rolagem a tela mistura dois vídeos.
        const firme = achado.direto || estado.candidato === achado.url;
        estado.candidato = achado.url;
        if (achado.url !== estado.chave && firme) trocarPost(achado);
        if (estado.chave === null) return;
      }
      preencherIdioma().catch(error => console.warn("[Viva Spy]", error.message));
    }
    if (!host.isConnected) document.documentElement.append(host);
    host.style.display = "block";
  }

  // As teclas digitadas no cartão não podem virar atalho do site (setas, espaço, "m", "k"…).
  for (const tipo of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(tipo, event => {
      const caminho = event.composedPath();
      if (!caminho.includes(host)) return;
      event.stopImmediatePropagation();
      if (tipo !== "keydown") return;
      if (event.key === "Enter" && caminho[0] === ui.input && !event.isComposing) {
        event.preventDefault();
        salvar(ui.input.value);
      } else if (event.key === "Escape") {
        caminho[0].blur?.();
      }
    }, true);
  }
  for (const tipo of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "touchstart", "touchend"]) {
    host.addEventListener(tipo, event => event.stopPropagation());
  }

  ui.salvar.addEventListener("click", () => salvar(ui.input.value));
  ui.desfazer.addEventListener("click", () => {
    ui.desfazer.hidden = true;
    enviar({ action: "VIRAL_UNDO", id: estado.jobId });
  });
  ui.idioma.addEventListener("change", () => {
    estado.idiomaManual = true;
    if (estado.salvo && estado.escolhido) salvar(estado.escolhido); // corrige o que já está salvo
  });
  ui.geo.addEventListener("change", () => {
    if (ui.geo.value) {
      estado.geo = ui.geo.value;
      chrome.storage.local.set({ [GEO_KEY]: estado.geo });
    }
    if (estado.salvo && estado.escolhido) salvar(estado.escolhido);
  });
  const minimizar = min => {
    estado.min = min;
    chrome.storage.local.set({ [MIN_KEY]: min });
    desenharForma();
  };
  ui.minimizar.addEventListener("click", () => minimizar(true));
  ui.bolha.addEventListener("click", () => minimizar(false));

  chrome.storage.onChanged.addListener((mudancas, area) => {
    if (area !== "local") return;
    if (mudancas[ON_KEY]) {
      estado.ligado = mudancas[ON_KEY].newValue !== false;
      conferir();
    }
    if (mudancas[NICHOS_KEY]?.newValue) {
      estado.nichos = mudancas[NICHOS_KEY].newValue.nomes;
      desenharPilulas();
    }
    if (mudancas[JOBS_KEY] && estado.jobId) {
      desenharJob((mudancas[JOBS_KEY].newValue || []).find(job => job.id === estado.jobId));
    }
  });

  async function iniciar() {
    const salvo = await chrome.storage.local.get([ON_KEY, MIN_KEY, GEO_KEY, NICHOS_KEY]);
    estado.ligado = salvo[ON_KEY] !== false;
    estado.min = salvo[MIN_KEY] === true;
    estado.geo = salvo[GEO_KEY] || "US";
    estado.nichos = salvo[NICHOS_KEY]?.nomes || [];
    document.addEventListener("fullscreenchange", conferir);
    relogio = setInterval(conferir, INTERVALO_MS);
    conferir();
  }

  const comecar = () => iniciar().catch(error => console.warn("[Viva Spy] cartão não iniciou:", error.message));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", comecar, { once: true });
  else comecar();
})();
