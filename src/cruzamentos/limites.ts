import { achados, filtroUF, linhas } from './comum.ts';

export const id = 'limites';
export const descricao = 'Comparecimento ≤ aptos; total de votos por cargo ≤ comparecimento × votos por eleitor.';

export async function executar(db, { uf }) {
  return linhas(db, achados(`
    WITH s AS (SELECT * FROM secoes WHERE status = 'ok' AND comparecimento IS NOT NULL AND ${filtroUF(uf)}),
    t AS (SELECT pleito, mun, zona, secao, codigoCargo, any_value(cargo) cargo, sum(quantidade) total
          FROM votos WHERE origem = 'BU' GROUP BY ALL),
    j AS (SELECT t.*, s.uf, s.comparecimento FROM t JOIN s USING (pleito, mun, zona, secao) WHERE s.comparecimento > 0),
    -- votos por eleitor do cargo (ex.: 2 para senador quando há duas vagas): mediana de total/comparecimento
    k AS (SELECT pleito, codigoCargo, greatest(1, round(median(total::DOUBLE / comparecimento))) k FROM j GROUP BY ALL)
    SELECT 'limites' cruzamento, uf, mun, zona, secao, pleito, 'COMPARECIMENTO_ACIMA_APTOS' sinal, 100 pontuacao,
      comparecimento valor, aptos referencia, json_object('aptos', aptos, 'comparecimento', comparecimento) detalhe
    FROM s WHERE comparecimento > aptos
    UNION ALL
    SELECT 'limites', uf, mun, zona, secao, pleito, 'VOTOS_ACIMA_COMPARECIMENTO', 100, total, k * comparecimento,
      json_object('cargo', cargo, 'votosPorEleitor', k, 'total', total, 'comparecimento', comparecimento)
    FROM j JOIN k USING (pleito, codigoCargo) WHERE total > k * comparecimento`));
}
