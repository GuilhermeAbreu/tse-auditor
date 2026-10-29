import { achados, filtroUF, linhas, temDoisTurnos, zRobusto } from './comum.js';

export const id = 'turnos';
export const descricao = 'Presidente 1º × 2º turno por seção: ganho de cada finalista × votos disponíveis; variação atípica na zona.';

export async function executar(db, { uf, turnos }) {
  if (!temDoisTurnos(turnos)) return [];
  const { primeiro: PRIMEIRO, segundo: SEGUNDO } = turnos;
  return linhas(db, achados(`
    WITH s AS (SELECT pleito, uf, mun, zona, secao, comparecimento FROM secoes WHERE status = 'ok' AND ${filtroUF(uf)}),
    p AS (SELECT pleito, mun, zona, secao, tipo, numero, sum(quantidade) q FROM votos
          WHERE origem = 'BU' AND codigoCargo = 1 GROUP BY ALL),
    fin AS (SELECT DISTINCT numero FROM p WHERE pleito = ${SEGUNDO} AND tipo = 'nominal'),
    c AS (SELECT s1.uf, mun, zona, secao, s1.comparecimento comp1, s2.comparecimento comp2
          FROM s s1 JOIN s s2 USING (mun, zona, secao) WHERE s1.pleito = ${PRIMEIRO} AND s2.pleito = ${SEGUNDO}),
    a1 AS (SELECT mun, zona, secao,
             coalesce(sum(q) FILTER (WHERE tipo IN ('branco', 'nulo')), 0) bn1,
             coalesce(sum(q) FILTER (WHERE tipo = 'nominal' AND numero NOT IN (SELECT numero FROM fin)), 0) elim1
           FROM p WHERE pleito = ${PRIMEIRO} GROUP BY ALL),
    cand AS (SELECT c.*, a1.bn1, a1.elim1, f.numero, coalesce(x1.q, 0) v1, coalesce(x2.q, 0) v2
             FROM c JOIN a1 USING (mun, zona, secao) CROSS JOIN fin f
             LEFT JOIN p x1 ON x1.pleito = ${PRIMEIRO} AND x1.tipo = 'nominal' AND x1.numero = f.numero
               AND x1.mun = c.mun AND x1.zona = c.zona AND x1.secao = c.secao
             LEFT JOIN p x2 ON x2.pleito = ${SEGUNDO} AND x2.tipo = 'nominal' AND x2.numero = f.numero
               AND x2.mun = c.mun AND x2.zona = c.zona AND x2.secao = c.secao),
    calc AS (SELECT a.*, b.numero adv, b.v1 v1Adv, b.v2 v2Adv, a.v2 - a.v1 ganho,
               a.elim1 + a.bn1 + greatest(0, a.comp2 - a.comp1) + greatest(0, b.v1 - b.v2) disp,
               a.v2::DOUBLE / nullif(a.comp2, 0) - a.v1::DOUBLE / nullif(a.comp1, 0) swing
             FROM cand a JOIN cand b USING (mun, zona, secao) WHERE a.numero <> b.numero),
    z AS (SELECT zona, numero, median(swing) m, mad(swing) d, count(*) n FROM calc GROUP BY ALL),
    cz AS (SELECT calc.*, z.m, z.n, ${zRobusto('swing', 'z.m', 'z.d', 0.01)} zr FROM calc JOIN z USING (zona, numero))
    SELECT 'turnos' cruzamento, uf, mun, zona, secao, ${SEGUNDO} pleito, 'GANHO_ACIMA_DISPONIVEL' sinal, 100 pontuacao,
      ganho valor, disp referencia,
      json_object('candidato', numero, 'v1', v1, 'v2', v2, 'eliminados1', elim1, 'brancosNulos1', bn1,
        'comparecimento1', comp1, 'comparecimento2', comp2, 'adversario', adv, 'adv1', v1Adv, 'adv2', v2Adv) detalhe
    FROM cz WHERE ganho > disp
    UNION ALL
    SELECT 'turnos', uf, mun, zona, secao, ${SEGUNDO}, 'VARIACAO_ATIPICA_ZONA', 10 * abs(zr), swing, m,
      json_object('candidato', numero, 'v1', v1, 'v2', v2, 'comparecimento1', comp1, 'comparecimento2', comp2,
        'zRobusto', round(zr, 2), 'secoesNaZona', n)
    FROM cz WHERE n >= 5 AND abs(zr) >= 4
    QUALIFY row_number() OVER (PARTITION BY mun, zona, secao ORDER BY abs(zr) DESC, numero) = 1`));
}
