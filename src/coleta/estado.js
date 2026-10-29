// Status de coleta da UF. Os status das etapas seguintes (verificando, extraído, analisado)
// entram com os planos de verificação e análise.
export function statusDaUf(u, coleta) {
  const nela = coleta.rodando && coleta.ufAtual === u.uf;
  if (nela && u.pausada) return 'pausando';
  if (nela) return 'baixando';
  if (u.pausada) return 'pausada';
  if (u.total > 0 && u.concluidas + u.erros === u.total) return u.erros > 0 ? 'baixado_com_erros' : 'baixado';
  return 'aguardando';
}

// Junta o manifest e o coletor no objeto que o painel e o CLI exibem.
// Seções agregadas não contam no total (não têm arquivos próprios); "sem arquivos" conta como
// concluída para o progresso, mas aparece separada, nunca como "ok".
// `ufs` (opcional) limita o estado às UFs da configuração atual; o manifest pode ter outras.
export async function montarEstado({ manifest, coletor, pastaDados, bytesLivres, ufs: filtro }) {
  const coleta = { ...coletor.estado, velocidadeBps: coletor.velocidadeBps() };
  let ufsManifest, resumo, errosSecoes, eventos, manifestErro;
  let falha = null;
  try {
    ufsManifest = manifest.ufs();
    resumo = manifest.resumoPorUf();
    errosSecoes = manifest.errosRecentes(20);
    eventos = manifest.eventos(20);
    manifestErro = manifest.erro?.message ?? null;
  } catch (err) {
    falha = err;
  }

  let livres = null;
  try {
    livres = await bytesLivres(pastaDados);
  } catch {
    // HD desconectado: o painel mostra "—"
  }

  if (falha) {
    return {
      geradoEm: new Date().toISOString(),
      coleta,
      totais: { secoes: 0, concluidas: 0, erros: 0, semArquivos: 0, bytes: 0 },
      disco: { livres, projecaoBytes: null, projecaoPreliminar: true },
      ufs: [],
      errosSecoes: [],
      eventos: [],
      manifestErro: falha.message,
    };
  }

  if (filtro) ufsManifest = ufsManifest.filter((u) => filtro.includes(u.uf));
  const porUf = new Map(ufsManifest.map((u) => [u.uf, {
    uf: u.uf, pausada: u.pausada === 1, total: 0, concluidas: 0, erros: 0, semArquivos: 0, agregadas: 0, bytes: 0,
  }]));
  for (const { uf, status, n, bytes } of resumo) {
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

  const ufs = [...porUf.values()].map((u) => ({ ...u, status: statusDaUf(u, coleta) }));
  const soma = (campo) => ufs.reduce((total, u) => total + u[campo], 0);
  const totais = {
    secoes: soma('total'), concluidas: soma('concluidas'), erros: soma('erros'), semArquivos: soma('semArquivos'), bytes: soma('bytes'),
  };

  return {
    geradoEm: new Date().toISOString(),
    coleta,
    totais,
    disco: {
      livres,
      projecaoBytes: totais.concluidas ? Math.round((totais.bytes / totais.concluidas) * totais.secoes) : null,
      projecaoPreliminar: totais.concluidas < Math.max(1000, totais.secoes * 0.01),
    },
    ufs,
    errosSecoes,
    eventos,
    manifestErro,
  };
}
