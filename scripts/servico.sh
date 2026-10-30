#!/usr/bin/env bash
# Instala e controla o TSE Auditor como serviço do usuário (systemd --user) com um atalho no menu de aplicativos.
# O serviço sobe no login, volta se cair e segue coletando com o navegador fechado. Se a coleta começa sozinha
# é uma escolha feita no painel (preferencias.json); sem o HD montado, o serviço espera ele aparecer.
#
# uso: scripts/servico.sh instalar | remover | iniciar | parar | reiniciar | status | logs | abrir
set -euo pipefail

NOME=tse-auditor
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTA="${TSE_PORTA:-3005}"
URL="http://localhost:$PORTA"
UNIDADE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$NOME.service"
ATALHO="${XDG_DATA_HOME:-$HOME/.local/share}/applications/$NOME.desktop"

ativo() { systemctl --user is-active --quiet "$NOME"; }
porta_ocupada() { (exec 3<>"/dev/tcp/127.0.0.1/$PORTA") 2>/dev/null; }

instalar() {
  local node
  node="$(command -v node)" || { echo "node não encontrado no PATH" >&2; exit 1; }
  if porta_ocupada && ! ativo; then
    echo "a porta $PORTA já está em uso (painel aberto no terminal?). Feche-o com Ctrl-C e rode de novo." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$UNIDADE")" "$(dirname "$ATALHO")"
  {
    echo "[Unit]"
    echo "Description=TSE Auditor: coleta e painel ($URL)"
    echo "After=network-online.target"
    echo "Wants=network-online.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "WorkingDirectory=$RAIZ"
    echo "ExecStart=\"$node\" \"$RAIZ/src/cli.ts\" painel --servico --porta $PORTA"
    [[ -n "${TSE_HD:-}" ]] && echo "Environment=\"TSE_HD=$TSE_HD\""
    echo "# SIGINT = o mesmo Ctrl-C do terminal: termina as seções em andamento e grava o manifesto"
    echo "KillSignal=SIGINT"
    echo "TimeoutStopSec=120"
    echo "Restart=on-failure"
    echo "RestartSec=15"
    echo "Nice=5"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$UNIDADE"
  cat > "$ATALHO" <<DESKTOP
[Desktop Entry]
Type=Application
Name=TSE Auditor
Comment=Coleta e auditoria dos arquivos de urna do TSE
Exec="$RAIZ/scripts/servico.sh" abrir
Icon=$RAIZ/assets/tse-auditor.svg
Terminal=false
Categories=Utility;Network;
DESKTOP
  systemctl --user daemon-reload
  systemctl --user enable --now "$NOME"
  echo "instalado: o serviço sobe no login e o painel fica em $URL"
  echo "atalho \"TSE Auditor\" no menu de aplicativos; logs: npm run servico -- logs"
}

remover() {
  systemctl --user disable --now "$NOME" 2>/dev/null || true
  rm -f "$UNIDADE" "$ATALHO"
  systemctl --user daemon-reload
  echo "removido (dados no HD e configuração em ~/.config/tse-auditor ficam como estão)"
}

abrir() {
  [[ -f "$UNIDADE" ]] || { echo "serviço não instalado: npm run servico -- instalar" >&2; exit 1; }
  ativo || systemctl --user start "$NOME"
  for _ in $(seq 1 60); do porta_ocupada && break; sleep 0.5; done
  xdg-open "$URL" >/dev/null 2>&1 &
}

case "${1:-}" in
  instalar) instalar ;;
  remover) remover ;;
  iniciar) systemctl --user start "$NOME" ;;
  parar) systemctl --user stop "$NOME" ;;
  reiniciar) systemctl --user restart "$NOME" ;;
  status) systemctl --user status "$NOME" --no-pager || true ;;
  logs) journalctl --user -u "$NOME" -f -n 100 ;;
  abrir) abrir ;;
  *) echo "uso: $0 instalar | remover | iniciar | parar | reiniciar | status | logs | abrir" >&2; exit 1 ;;
esac
