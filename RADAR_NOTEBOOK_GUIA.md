# Radar diário no notebook — guia de montagem

## Como o radar funciona (a lógica)

1. Você escreve as palavras-chave (uma por linha) no popup da Viva Spy → seção **Radar diário**.
2. A cada X horas (2/4/6/12/24), a extensão abre **uma janelinha por vez** no Chrome, pesquisa a palavra-chave na Meta Ad Library (país escolhido), rola a página lendo os anúncios e fecha. Entre uma busca e outra espera 8–25 s (ritmo humano).
3. O que for **escala** (duplicados + dias no ar + anúncios da biblioteca) entra no Centro de Inteligência e é enviado ao **cofre da equipe**. Todo mundo vê.
4. Ao fim de cada rodada o radar anota quantos anúncios cada biblioteca tinha. Comparando com dias anteriores marca:
   - **🆕 Novo** — apareceu no acervo nas últimas 24 h;
   - **📈 Subindo** — a biblioteca ganhou ≥ 5 anúncios e ≥ 30 % sobre a leitura de 1–7 dias atrás.
5. Filtros no Centro: **🆕 Novos (24h)** e **📈 Subindo**. O resumo da última rodada aparece no popup.

Carga típica: 20 palavras × 4 rodadas/dia ≈ 80 buscas/dia; cada rodada leva 30–40 min.

## Montagem do notebook (passo a passo)

1. **Windows atualizado**, ligado na tomada, **internet por cabo** (ou Wi-Fi estável).
2. **Energia** (Configurações → Sistema → Energia): *Tela e suspensão* = **Nunca** (na tomada). *Painel de Controle → Opções de energia → "Ao fechar a tampa" = Não fazer nada.* Se fechar a tampa, deixe-a entreaberta/ou use monitor externo — janela de Chrome com tela apagada pode não renderizar.
3. **Chrome dedicado**: crie um perfil só para o radar (ícone do perfil → Adicionar). Instale a extensão (Carregar sem compactação → pasta `viva-spy`).
4. **Chrome Configurações → Sistema**: ligue *"Continuar executando apps em segundo plano quando o Google Chrome estiver fechado"*.
5. **Iniciar com o Windows**: `Win+R` → `shell:startup` → coloque um atalho do Chrome com o perfil do radar (propriedades do atalho → Destino: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory="Profile 1"`; troque pelo nome do perfil).
6. **Login automático do Windows** (para voltar sozinho após queda de energia): `Win+R` → `netplwiz` → desmarque "Os usuários devem digitar nome e senha". BIOS: "Restore on AC power loss = Power On" se existir.
7. **Atualizações**: Windows Update → *Horas ativas* amplas, para não reiniciar no meio da rodada (se reiniciar, o radar volta sozinho ao abrir o Chrome).
8. **Meta Ad Library normalmente funciona sem login.** Se pedir login, use uma conta Facebook **descartável dedicada**, nunca a conta de anúncios.
9. No popup: **Equipe** → nome `Radar` + código da equipe → Conectar. Depois **Radar diário** → palavras-chave, país (EUA), intervalo (comece com **6 h**) → ligar. Clique **Rodar agora** para o primeiro teste e acompanhe uma rodada inteira.
10. Dica: janelinhas do radar abrem sem foco, mas aparecem na tela. Se for usar o notebook para outra coisa, use outro perfil/janela.

## Limites honestos

- Se a Meta limitar buscas (captcha, páginas vazias), aumente o intervalo ou reduza as palavras. Comece pequeno (10–20 palavras) e suba aos poucos.
- O radar para se o Chrome estiver fechado ou o notebook dormindo; ao voltar, retoma na próxima verificação (a cada 5 min).
- "Subindo" só aparece depois de pelo menos 2 dias de histórico.
- Nada disso foi validado ainda na Meta real por longos períodos — observe os primeiros dias.
