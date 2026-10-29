export function fmtBytes(b) {
  if (b == null) return '—';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < unidades.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i ? 1 : 0)} ${unidades[i]}`;
}

export function linhaDeProgresso(e) {
  const { secoes, concluidas, erros, bytes } = e.totais;
  const pct = secoes ? (((concluidas + erros) / secoes) * 100).toFixed(1) : '0.0';
  const onde = e.coleta.ufAtual ? ` | ${e.coleta.ufAtual.toUpperCase()} ${e.coleta.municipioAtual ?? ''}` : '';
  return `${pct}% | ${concluidas}/${secoes} seções | ${erros} erros | ${fmtBytes(bytes)} | ${fmtBytes(e.coleta.velocidadeBps)}/s${onde}`;
}
