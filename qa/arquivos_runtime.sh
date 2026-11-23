#!/bin/bash
# Lista TODOS os arquivos que a extensão precisa em runtime (é isso que tem de ser copiado para o PC, sempre inteiro).
# Uso: cd <pasta da extensão> && bash qa/arquivos_runtime.sh            -> lista os arquivos
#      cd <pasta da extensão> && bash qa/arquivos_runtime.sh --hash     -> sha256 de cada um (para conferir no PC)
cd "$(dirname "$0")/.." || exit 1
LISTA=$( (ls -1 *.js *.css *.html manifest.json; ls -1 icons/* ) | sort)
if [ "$1" = "--hash" ]; then echo "$LISTA" | xargs sha256sum; else echo "$LISTA"; fi
