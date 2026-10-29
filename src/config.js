import path from 'node:path';

export const PADRAO = {
  hd: process.env.TSE_HD ?? '/media/guilherme/Novo volume',
  base: process.env.TSE_BASE ?? 'https://resultados.tse.jus.br',
  ambiente: 'oficial',
  concorrencia: 4,
  userAgent: 'tse-auditor/0.1 (auditoria independente dos arquivos de urna)',
  minLivreBytes: 20 * 1024 ** 3,
  porta: 3000,
};

export function anoDoCiclo(ciclo) {
  const m = /^ele(\d{4})$/.exec(ciclo);
  if (!m) throw new Error(`ciclo inesperado: ${ciclo}`);
  return m[1];
}

// Tudo do projeto fica em <HD>/tse<ano>/; o resto do disco não é tocado.
export function pastaDados(hd, ciclo) {
  return path.join(hd, `tse${anoDoCiclo(ciclo)}`);
}
