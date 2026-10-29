import { achados, desloc, filtroUF, linhas, SEGUNDO, zRobusto } from './comum.js';

export const id = 'mesario';
export const descricao = 'Liberação pelo mesário: taxa × local/zona/outro turno, concentração na última hora, abstenção caiu e liberação subiu.';

const HAB = "('hab_biometrica', 'hab_ano_nascimento', 'hab_mesario', 'hab_mesario_nao_associado')";

export async function executar(db, { uf }) {
  const d = desloc(uf);
  return linhas(db, achados(`
    WITH b AS (SELECT pleito, uf, mun, zona, secao, local, aptos, abstencao, logDia, comparecimento comp, qtdHabilitacaoMesario mes,
                 qtdHabilitacaoMesario::DOUBLE / comparecimento taxa
               FROM secoes WHERE status = 'ok' AND comparecimento > 0 AND ${filtroUF(uf)}),
    gl AS (SELECT pleito, mun, zona, local, median(taxa) mL, mad(taxa) dL, count(*) nL FROM b GROUP BY ALL),
    gz AS (SELECT pleito, zona, median(taxa) mZ, mad(taxa) dZ, count(*) nZ FROM b GROUP BY ALL),
    o AS (SELECT x.*, y.taxa taxaOutro, x.taxa - y.taxa delta, (y.abstencao - x.abstencao)::DOUBLE / nullif(x.aptos, 0) quedaAbs
          FROM b x LEFT JOIN b y ON y.mun = x.mun AND y.zona = x.zona AND y.secao = x.secao AND y.pleito <> x.pleito),
    gd AS (SELECT pleito, zona, median(delta) mD, mad(delta) dD, median(quedaAbs) mA, mad(quedaAbs) dA FROM o GROUP BY ALL),
    x AS (SELECT o.*, mL, nL, mZ, nZ, mD,
            ${zRobusto('taxa', 'mL', 'dL', 0.01)} zL, ${zRobusto('taxa', 'mZ', 'dZ', 0.01)} zZ,
            ${zRobusto('delta', 'mD', 'dD', 0.01)} zD, ${zRobusto('quedaAbs', 'mA', 'dA', 0.01)} zA
          FROM o JOIN gl USING (pleito, mun, zona, local) JOIN gz USING (pleito, zona) JOIN gd USING (pleito, zona)),
    -- habilitação de cada voto: último evento de habilitação entre o voto anterior e ele (sem evento = mesário)
    ev AS (SELECT e.pleito, e.mun, e.zona, e.secao, e.ordem, e.ts, e.tipo,
             coalesce(sum(CASE WHEN e.tipo = 'voto_computado' THEN 1 ELSE 0 END) OVER (
               PARTITION BY e.pleito, e.mun, e.zona, e.secao ORDER BY e.ordem
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) seg
           FROM eventos_log e JOIN b USING (pleito, mun, zona, secao)
           WHERE e.modulo = 'VOTA' AND (e.tipo = 'voto_computado' OR e.tipo IN ${HAB})
             AND CAST(e.ts AS DATE) = CAST(b.logDia AS DATE)),
    vt AS (SELECT pleito, mun, zona, secao, max(ts) FILTER (WHERE tipo = 'voto_computado') ts,
             coalesce(arg_max(tipo, ordem) FILTER (WHERE tipo IN ${HAB}), 'hab_mesario') hab
           FROM ev GROUP BY pleito, mun, zona, secao, seg HAVING count(*) FILTER (WHERE tipo = 'voto_computado') = 1),
    uh AS (SELECT pleito, mun, zona, secao, count(*) votos,
             count(*) FILTER (WHERE hour(ts + to_hours(${d})) = 16) votosUlt,
             count(*) FILTER (WHERE hab LIKE 'hab_mesario%') mesLog,
             count(*) FILTER (WHERE hab LIKE 'hab_mesario%' AND hour(ts + to_hours(${d})) = 16) mesUlt
           FROM vt GROUP BY ALL),
    uz AS (SELECT uh.*, votosUlt::DOUBLE / votos p,
             (mesUlt - mesLog * votosUlt::DOUBLE / votos) / sqrt(mesLog * (votosUlt::DOUBLE / votos) * (1 - votosUlt::DOUBLE / votos)) zU
           FROM uh WHERE votosUlt > 0 AND votosUlt < votos AND mesLog > 0)
    SELECT 'mesario' cruzamento, uf, mun, zona, secao, pleito, 'MESARIO_ACIMA_LOCAL' sinal, 10 * zL pontuacao, taxa valor, mL referencia,
      json_object('mesario', mes, 'comparecimento', comp, 'local', local, 'secoesNoLocal', nL, 'zRobusto', round(zL, 2)) detalhe
    FROM x WHERE nL >= 4 AND zL >= 4 AND taxa - mL >= 0.03
    UNION ALL
    SELECT 'mesario', uf, mun, zona, secao, pleito, 'MESARIO_ACIMA_ZONA', 10 * zZ, taxa, mZ,
      json_object('mesario', mes, 'comparecimento', comp, 'secoesNaZona', nZ, 'zRobusto', round(zZ, 2))
    FROM x WHERE nZ >= 10 AND zZ >= 4 AND taxa - mZ >= 0.03
    UNION ALL
    SELECT 'mesario', uf, mun, zona, secao, pleito, 'MESARIO_SUBIU_OUTRO_TURNO', 10 * zD, taxa, taxaOutro,
      json_object('mesario', mes, 'comparecimento', comp, 'variacao', round(delta, 4), 'medianaZona', round(mD, 4), 'zRobusto', round(zD, 2))
    FROM x WHERE zD >= 4 AND delta >= 0.03
    UNION ALL
    SELECT 'mesario', uf, mun, zona, secao, pleito, 'ABSTENCAO_CAIU_MESARIO_SUBIU', 10 * least(zA, zD), delta, quedaAbs,
      json_object('quedaAbstencaoSobreAptos', round(quedaAbs, 4), 'zQuedaAbstencao', round(zA, 2),
        'taxaMesario', round(taxa, 4), 'taxaMesarioOutroTurno', round(taxaOutro, 4), 'zAumentoMesario', round(zD, 2))
    FROM x WHERE pleito = ${SEGUNDO} AND quedaAbs > 0 AND delta > 0 AND zA >= 3 AND zD >= 3
    UNION ALL
    SELECT 'mesario', b.uf, mun, zona, secao, pleito, 'MESARIO_ULTIMA_HORA', 10 * zU, mesUlt::DOUBLE / mesLog, p,
      json_object('mesarioUltimaHora', mesUlt, 'mesarioDia', mesLog, 'votosUltimaHora', votosUlt, 'votosDia', votos, 'z', round(zU, 2))
    FROM uz JOIN b USING (pleito, mun, zona, secao) WHERE mesUlt >= 3 AND zU >= 4 AND mesUlt::DOUBLE / mesLog >= 2 * p`));
}
