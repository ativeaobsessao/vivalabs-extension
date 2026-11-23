# Procedimento de entrega (Viva Spy) — obrigatório antes de dizer "pronto"

Por que existe: em 23/11/2026 a v1.9.1 "sumiu" da Ad Library no PC do Gus. O código estava certo; a pasta no PC tinha
arquivos de versões misturadas (`ranking_engine.js` antigo + `content.js` novo => `lixeiraVazia is not defined`).
Causa: entregas copiavam só "os arquivos que mudaram". Nunca mais.

## Passos (nesta ordem, sem pular)
1. `node --check` em todos os `.js`; sem BOM/caracteres não-caracteres (U+FFFE/U+FFFF) nos arquivos.
2. Todas as suítes `qa/testes/*.test.js` verdes (sync e radar precisam do Postgres de teste ligado).
3. Commit.
4. **Teste de fumaça em Chrome real contra o que foi commitado**:
   `git archive HEAD | tar -x -C /tmp/pacote && node qa/smoke_chrome.js /tmp/pacote`
   Tem de dar exit 0: barra, dock e botão do Centro aparecem, sem aviso vermelho de arquivos.
5. Entrega: copiar **todos** os arquivos listados por `bash qa/arquivos_runtime.sh` (não só os alterados).
6. Conferir no PC: sha256 de cada arquivo da pasta == sha256 do repositório (`--hash`). Qualquer diferença = entrega falhou.
   Exceção conhecida: os 4 PNGs de `icons/` chegam ao PC re-codificados (bytes diferentes, pixels idênticos — verificado em
   23/11/2026). Para eles, comparar a imagem (pixels), não o hash.
7. Dizer ao Gus a versão que deve aparecer em `chrome://extensions` e o que ele deve ver ao abrir a biblioteca.

## Rede de proteção embutida
`content.js` se autoverifica ao carregar: se algum arquivo estiver de outra versão, mostra um aviso vermelho no topo da
página com o nome do arquivo desatualizado, em vez de a extensão sumir em silêncio.
