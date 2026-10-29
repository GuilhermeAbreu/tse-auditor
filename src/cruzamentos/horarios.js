import { achados, desloc, filtroUF, linhas } from './comum.js';

export const id = 'horarios';
export const descricao = 'Votos antes da abertura/08h ou após pausa ≥ 30 min depois das 17h (Brasília); testes/carga misturados à votação.';

// Mensagens de teste, zerésima ou fase/carga não oficial (contingência fica como explicação, não como sinal).
// O teste de teclado roda a cada início do aplicativo (inclusive após reinício) e não entra.
const TESTE = `((e.mensagem ILIKE '%teste%' AND e.mensagem NOT ILIKE '%teste de teclado%') OR e.mensagem ILIKE '%zerésima%'
  OR (e.mensagem LIKE 'Fase da UE:%' AND e.mensagem NOT LIKE '%Oficial%')
  OR (e.mensagem LIKE 'Modo de carga da UE%' AND e.mensagem NOT LIKE '%Votação%' AND e.mensagem NOT LIKE '%contingência%')
  OR (e.mensagem LIKE 'Iniciando aplicação - ELEIÇÃO%' AND e.mensagem NOT LIKE '%OFICIAL%'))`;

export async function executar(db, { uf }) {
  const d = desloc(uf);
  return linhas(db, achados(`
    WITH s AS (SELECT pleito, uf, mun, zona, secao, logDia, CAST(abertura AS TIMESTAMP) abertura
               FROM secoes WHERE status = 'ok' AND ${filtroUF(uf)}),
    v AS (SELECT e.pleito, e.mun, e.zona, e.secao, e.ts, e.ts + to_hours(${d}) br, s.abertura,
            lag(e.ts) OVER (PARTITION BY e.pleito, e.mun, e.zona, e.secao ORDER BY e.ordem) ant
          FROM eventos_log e JOIN s USING (pleito, mun, zona, secao)
          WHERE e.tipo = 'voto_computado' AND CAST(e.ts AS DATE) = CAST(s.logDia AS DATE)),
    lim AS (SELECT pleito, mun, zona, secao, min(ts) primeiro, max(ts) ultimo,
              min(ts) FILTER (WHERE br::TIME >= TIME '17:00' AND ts - ant >= INTERVAL 30 MINUTE) retomada
            FROM v GROUP BY ALL),
    antes AS (SELECT pleito, mun, zona, secao, count(*) n, min(ts) primeiro, any_value(abertura) abertura
              FROM v WHERE br::TIME < TIME '08:00' OR ts < abertura GROUP BY ALL),
    pausa AS (SELECT v.pleito, v.mun, v.zona, v.secao, count(*) n, any_value(lim.retomada) retomada, max(v.ts) ultimo
              FROM v JOIN lim USING (pleito, mun, zona, secao) WHERE v.ts >= lim.retomada GROUP BY ALL),
    t AS (SELECT e.pleito, e.mun, e.zona, e.secao, count(*) n, list(DISTINCT e.mensagem)[1:5] msgs, min(e.ts) primeiro
          FROM eventos_log e JOIN s USING (pleito, mun, zona, secao) JOIN lim USING (pleito, mun, zona, secao)
          WHERE CAST(e.ts AS DATE) = CAST(s.logDia AS DATE) AND ${TESTE}
            AND ((e.ts > lim.primeiro AND e.ts < lim.ultimo) OR e.mensagem LIKE 'Fase da UE:%' OR e.mensagem LIKE 'Iniciando aplicação - ELEIÇÃO%')
          GROUP BY ALL)
    SELECT 'horarios' cruzamento, s.uf, mun, zona, secao, pleito, 'VOTO_ANTES_ABERTURA' sinal, 50 + 10 * n pontuacao,
      n valor, NULL referencia,
      json_object('votos', n, 'primeiroVoto', strftime(primeiro, '%Y-%m-%d %H:%M:%S'), 'abertura', strftime(antes.abertura, '%Y-%m-%d %H:%M:%S'),
        'deslocBrasiliaHoras', ${d}) detalhe
    FROM antes JOIN s USING (pleito, mun, zona, secao)
    UNION ALL
    SELECT 'horarios', s.uf, mun, zona, secao, pleito, 'VOTO_APOS_PAUSA_17H', 50 + 5 * n, n, NULL,
      json_object('votos', n, 'retomada', strftime(retomada, '%Y-%m-%d %H:%M:%S'), 'ultimoVoto', strftime(ultimo, '%Y-%m-%d %H:%M:%S'),
        'deslocBrasiliaHoras', ${d})
    FROM pausa JOIN s USING (pleito, mun, zona, secao)
    UNION ALL
    SELECT 'horarios', s.uf, mun, zona, secao, pleito, 'TESTE_CARGA_NO_DIA', 60 + 5 * n, n, NULL,
      json_object('eventos', n, 'mensagens', msgs, 'primeiro', strftime(primeiro, '%Y-%m-%d %H:%M:%S'))
    FROM t JOIN s USING (pleito, mun, zona, secao)`));
}
