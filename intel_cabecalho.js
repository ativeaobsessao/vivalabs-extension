// Topo do Centro: medidor "X de 150 mil", alerta de espaço, aviso de modo e sinal dos radares.
// Depende de ranking_engine.js (radarSinais), intel_core.js e intel_view.js.

const INTEL_URL_PLANO = "https://supabase.com/pricing";

function intelDesenharMedidor(modo, info) {
  const medidor = document.getElementById("medidor");
  const total = info ? Number(info.total) || 0 : 0;
  const teto = modo === "banco" ? INTEL_LIMITE : VIVA_ACERVO_MAX;
  const mb = info && info.bytes ? ` · ${intelNumero(Math.round(info.bytes / 1e6))} MB de 500 MB` : "";
  medidor.dataset.nivel = modo === "banco" ? intelNivelEspaco(total, info && info.bytes) : "ok";
  document.getElementById("medidorTexto").textContent = modo === "banco"
    ? `${intelNumero(total)} de 150 mil anúncios${mb}`
    : `${intelNumero(total)} neste computador (até ${intelNumero(VIVA_ACERVO_MAX)})`;
  document.getElementById("medidorBarra").style.width = `${Math.min(100, (total / teto) * 100)}%`;
}

function intelTextoPlanilha(espaco, progresso) {
  if (progresso) return `Gerando a planilha completa… ${intelNumero(progresso.lidos)} anúncios lidos.`;
  if (espaco && espaco.erro) return `A planilha automática falhou: ${espaco.erro}`;
  if (espaco && espaco.baixadoEm) {
    const quando = new Date(espaco.baixadoEm).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `Planilha completa baixada neste computador em ${quando} (${intelNumero(espaco.baixadoTotal)} anúncios, pasta Downloads/VivaSpy).`;
  }
  return "";
}

// acoes = { foraDosNichos, apagarDescartados(n), baixarTudo }
function intelDesenharAlerta(info, espaco, progresso, acoes) {
  const alerta = document.getElementById("alerta");
  const nivel = info ? intelNivelEspaco(info.total, info.bytes) : "ok";
  alerta.hidden = nivel === "ok";
  alerta.textContent = "";
  if (alerta.hidden) return;
  alerta.dataset.nivel = nivel;
  const estourou = nivel === "estourou";
  alerta.appendChild(intelNo("h2", null, estourou
    ? "O banco passou de 150 mil anúncios e está ficando sem espaço"
    : "O espaço do banco está acabando"));
  alerta.appendChild(intelNo("p", null, estourou
    ? "Apague os anúncios que não fazem parte do nosso modelo de negócio, ou assine o plano pago do banco. Descartar só esconde: para liberar espaço, use “Apagar definitivamente”. Nada é apagado sozinho."
    : "Comecem a apagar o que não faz parte do nosso modelo de negócio. Descartar só esconde: para liberar espaço, use “Apagar definitivamente”."));
  const planilha = intelTextoPlanilha(espaco, progresso);
  if (planilha) alerta.appendChild(intelNo("p", "planilha", planilha));
  const botoes = intelNo("div", "acoes-alerta");
  botoes.appendChild(intelBotao("botao primario fora", "Ver anúncios fora dos nichos", acoes.foraDosNichos));
  if (info.descartados) botoes.appendChild(intelBotao("botao apagar-descartados", `Apagar descartados (${intelNumero(info.descartados)})`, () => acoes.apagarDescartados(info.descartados)));
  botoes.appendChild(intelBotao("botao baixar-tudo", estourou ? "Baixar planilha de novo" : "Baixar planilha completa", acoes.baixarTudo));
  botoes.appendChild(intelLink("botao plano", "Ver plano pago", INTEL_URL_PLANO));
  alerta.appendChild(botoes);
}

function intelDesenharModo(fonte) {
  const aviso = document.getElementById("aviso");
  aviso.hidden = fonte.modo === "banco";
  aviso.textContent = "";
  if (aviso.hidden) return;
  aviso.appendChild(intelNo("p", null, fonte.aviso === "sem-sql"
    ? "O banco de 150 mil ainda não está ligado: rode o arquivo SUPABASE_ATUALIZACAO_150K.sql no Supabase (SQL Editor). Até lá, esta tela mostra só os anúncios deste computador."
    : "Mostrando só os anúncios deste computador. Conecte o código da equipe no ícone da extensão para usar o banco compartilhado de 150 mil."));
}

function intelDesenharRadar(radarData) {
  const caixa = document.getElementById("radar");
  caixa.textContent = "";
  radarSinais(radarData).slice(0, 3).forEach(sinal => {
    const rotulo = sinal.nivel === "ok" ? "Radar OK" : sinal.nivel === "semsinal" ? "Radar sem sinal" : "Radar atrasado";
    const chip = intelNo("span", sinal.nivel, `${rotulo} · ${sinal.by}`);
    chip.title = sinal.rodando ? "rodando agora" : sinal.detalhe;
    caixa.appendChild(chip);
  });
}
