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
