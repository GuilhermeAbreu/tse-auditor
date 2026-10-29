// Peças comuns dos cruzamentos: carga dos Parquet como views, contexto de explicações candidatas,
// z-score robusto e o formato fixo de cada achado. Tudo em SQL do DuckDB.

// Pleitos do 1º e 2º turno, tirados das eleições do ele-c.json entre os pleitos presentes nos Parquet:
// o 2º turno é um pleito com eleições de turno 2 cujo ciclo também tem um pleito de turno 1 presente.
// Sem par, devolve só o que houver (segundo = null): o cruzamento "turnos" e as comparações entre turnos não rodam.
export function turnosDosPleitos(eleicoes, presentes) {
  const ps = [...new Set(presentes.map(String))]
    .map((cd) => eleicoes.pleitos.find((p) => p.cd === cd)).filter(Boolean)
    .map((p) => ({ cd: Number(p.cd), ciclo: p.ciclo, turno: Math.max(...p.eleicoes.map((e) => e.turno)) }))
    .sort((a, b) => a.cd - b.cd);
  for (const s of ps.filter((p) => p.turno === 2)) {
    const p = ps.find((x) => x.turno === 1 && x.ciclo === s.ciclo);
    if (p) return { primeiro: p.cd, segundo: s.cd };
  }
  return { primeiro: ps.find((p) => p.turno === 1)?.cd ?? ps[0]?.cd ?? null, segundo: null };
}

export const temDoisTurnos = (t) => t?.primeiro != null && t?.segundo != null;
// SQL: pleito do outro turno (NULL se não há os dois turnos).
export const outroTurno = (t, col) => (temDoisTurnos(t)
  ? `CASE ${col} WHEN ${t.primeiro} THEN ${t.segundo} WHEN ${t.segundo} THEN ${t.primeiro} END` : 'NULL');

// Horas a somar ao horário local da urna para chegar ao horário de Brasília (votação 8h–17h de Brasília).
export const DESLOC_BRASILIA = { AC: 2, AM: 1, RO: 1, RR: 1, MT: 1, MS: 1 };
export const desloc = (uf) => DESLOC_BRASILIA[uf.toUpperCase()] ?? 0;

export const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
export const filtroUF = (uf) => `upper(uf) = ${lit(uf.toUpperCase())}`;

// z robusto = (x − mediana) / (1,4826 × MAD), com piso no denominador para grupos muito homogêneos.
export const zRobusto = (x, med, mad, piso) => `((${x}) - (${med})) / greatest(1.4826 * coalesce(${mad}, 0), ${piso})`;

export async function linhas(db, sql) {
  return (await db.runAndReadAll(sql)).getRowObjectsJson();
}

export async function carregarParquet(db, pasta) {
  const arq = (n) => lit(`${pasta}/${n}.parquet`);
  await db.run(`CREATE OR REPLACE VIEW secoes AS SELECT * FROM read_parquet(${arq('secoes')})`);
  await db.run(`CREATE OR REPLACE VIEW votos AS SELECT * FROM read_parquet(${arq('votos')})`);
  await db.run(`CREATE OR REPLACE VIEW eventos_log AS
    SELECT *, file_row_number AS ordem FROM read_parquet(${arq('eventos_log')}, file_row_number = true)`);
}

// Explicações candidatas por seção e pleito (códigos separados por vírgula). Precisam ser verificadas e
// descontadas antes de qualquer conclusão.
export async function prepararContexto(db, { uf }) {
  const d = desloc(uf);
  await db.run(`CREATE OR REPLACE TEMP TABLE contexto AS
    WITH b AS (
      SELECT pleito, mun, zona, secao, tipoUrna, substituida, inconsistencias, logUrnas, secoesAgregadas,
        qtdHabilitacaoAnoNascimento::DOUBLE / nullif(comparecimento, 0) AS pAno,
        logTentativasDigital::DOUBLE / nullif(comparecimento, 0) AS tent,
        CAST(abertura AS TIMESTAMP) + to_hours(${d}) AS aberturaBr,
        CAST(logUltimoVoto AS TIMESTAMP) + to_hours(${d}) AS ultimoBr
      FROM secoes WHERE status = 'ok' AND ${filtroUF(uf)}),
    z AS (SELECT pleito, zona, median(pAno) mAno, mad(pAno) dAno, median(tent) mT, mad(tent) dT FROM b GROUP BY ALL)
    SELECT pleito, mun, zona, secao, concat_ws(',',
      CASE WHEN coalesce(tipoUrna, 'secao') <> 'secao' OR substituida OR inconsistencias IS NOT NULL
        OR contains(coalesce(logUrnas, ''), ',') THEN 'contingencia' END,
      CASE WHEN secoesAgregadas IS NOT NULL THEN 'secao_agregada' END,
      CASE WHEN ${zRobusto('tent', 'mT', 'dT', 0.1)} >= 3 THEN 'leitor_biometrico_defeito' END,
      CASE WHEN pAno >= 0.15 OR ${zRobusto('pAno', 'mAno', 'dAno', 0.01)} >= 3 THEN 'eleitores_sem_biometria' END,
      CASE WHEN ultimoBr::TIME >= TIME '17:00' THEN 'fila_17h' END,
      CASE WHEN aberturaBr::TIME < TIME '07:00' OR aberturaBr::TIME > TIME '09:00' THEN 'desvio_relogio' END
    ) AS explicacoes
    FROM b JOIN z USING (pleito, zona)`);
}

// Envolve o SQL de um cruzamento (colunas cruzamento, uf, mun, zona, secao, pleito, sinal, pontuacao,
// valor, referencia, detalhe) no formato final, anexando as explicações candidatas.
export function achados(sql) {
  return `SELECT a.cruzamento, upper(a.uf) AS uf, a.mun, a.zona, a.secao, CAST(a.pleito AS INTEGER) AS pleito, a.sinal,
      CAST(least(100, greatest(0, round(a.pontuacao))) AS INTEGER) AS pontuacao,
      CAST(a.valor AS DOUBLE) AS valor, CAST(a.referencia AS DOUBLE) AS referencia,
      coalesce(c.explicacoes, '') AS explicacoesCandidatas, CAST(a.detalhe AS VARCHAR) AS detalhe
    FROM (${sql}) a LEFT JOIN contexto c USING (pleito, mun, zona, secao)
    ORDER BY pontuacao DESC, a.mun, a.zona, a.secao, a.pleito, a.sinal`;
}
