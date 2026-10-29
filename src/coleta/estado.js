// Status de coleta da UF. Os status das etapas seguintes (verificando, extraído, analisado)
// entram com os planos de verificação e análise.
export function statusDaUf(u, coleta) {
  if (coleta.rodando && coleta.ufAtual === u.uf) return 'baixando';
  if (u.pausada) return 'pausada';
  if (u.total > 0 && u.concluidas + u.erros === u.total) return 'baixado';
  return 'aguardando';
}

// Junta o manifest e o coletor no objeto que o painel e o CLI exibem.
// Seções agregadas não contam no total (não têm arquivos próprios); "sem arquivos" conta como
// concluída para o progresso, mas aparece separada, nunca como "ok".
export async function montarEstado({ manifest, coletor, pastaDados, bytesLivres }) {
  const porUf = new Map(manifest.ufs().map((u) => [u.uf, {
    uf: u.uf, pausada: u.pausada === 1, total: 0, concluidas: 0, erros: 0, semArquivos: 0, agregadas: 0, bytes: 0,
  }]));
  for (const { uf, status, n, bytes } of manifest.resumoPorUf()) {
    const u = porUf.get(uf);
    if (!u) continue;
    if (status === 'agregada') {
      u.agregadas += n;
      continue;
    }
    u.total += n;
    u.bytes += bytes;
    if (status === 'completa' || status === 'sem_arquivos') u.concluidas += n;
    if (status === 'sem_arquivos') u.semArquivos += n;
    if (status === 'erro') u.erros += n;
  }

  const coleta = { ...coletor.estado, velocidadeBps: coletor.velocidadeBps() };
  const ufs = [...porUf.values()].map((u) => ({ ...u, status: statusDaUf(u, coleta) }));
  const soma = (campo) => ufs.reduce((total, u) => total + u[campo], 0);
  const totais = {
    secoes: soma('total'), concluidas: soma('concluidas'), erros: soma('erros'), semArquivos: soma('semArquivos'), bytes: soma('bytes'),
  };
  const tratadas = totais.concluidas + totais.erros;

  let livres = null;
  try {
    livres = await bytesLivres(pastaDados);
  } catch {
    // HD desconectado: o painel mostra "—"
  }

  return {
    geradoEm: new Date().toISOString(),
    coleta,
    totais,
    disco: {
      livres,
      projecaoBytes: tratadas ? Math.round((totais.bytes / tratadas) * totais.secoes) : null,
      projecaoPreliminar: !ufs.some((u) => u.status === 'baixado'),
    },
    ufs,
    manifestErro: manifest.erro?.message ?? null,
    errosSecoes: manifest.errosRecentes(20),
    eventos: manifest.eventos(20),
  };
}
