import path from 'node:path';

export const PADRAO = {
  hd: process.env.TSE_HD ?? '/media/guilherme/Novo volume',
  base: process.env.TSE_BASE ?? 'https://resultados.tse.jus.br',
  ambiente: 'oficial',
  concorrencia: 4,
  userAgent: 'tse-auditor/0.1 (auditoria independente dos arquivos de urna)',
  minLivreBytes: 20 * 1024 ** 3,
  porta: 3005,
  // ajustáveis no painel (veja src/coleta/opcoes.ts)
  tentativas: 8,
  esperaBaseMs: 1000,
  esperaMaxMs: 60_000,
  timeoutMs: 120_000,
  tentativasVerificacao: 3,
  limiteFalhasRede: 20,
  minLivreGB: 20,
  intervaloCommitMs: 1000,
  intervaloPainelMs: 2000,
};

export function anoDoCiclo(ciclo: string): string {
  const m = /^ele(\d{4})$/.exec(ciclo);
  if (!m) throw new Error(`ciclo inesperado: ${ciclo}`);
  return m[1]!;
}

// Tudo do projeto fica em <HD>/tse<ano>/; o resto do disco não é tocado.
export function pastaDados(hd: string, ciclo: string): string {
  return path.join(hd, `tse${anoDoCiclo(ciclo)}`);
}
