#!/usr/bin/env bash
# Baixa do TSE os arquivos reais usados como fixtures:
# ele-c.json e a seção AC / Porto Walter (01066) / zona 0004 / seção 0077, 1º e 2º turnos.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=https://resultados.tse.jus.br/oficial
DEST=test/fixtures/tse/oficial

baixar() {
  mkdir -p "$DEST/$(dirname "$1")"
  curl -sSf --retry 3 -o "$DEST/$1" "$BASE/$1"
}

baixar comum/config/ele-c.json
for P in 3220 3221; do
  DIR=ele2026/arquivo-urna/$P/dados/ac/01066/0004/0077
  AUX=p00$P-ac-m01066-z0004-s0077-aux.json
  baixar "$DIR/$AUX"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const h of j.hashes) for (const a of h.arq) console.log(h.hash + "/" + a.nm);
  ' "$DEST/$DIR/$AUX" | while read -r ARQ; do baixar "$DIR/$ARQ"; done
done
