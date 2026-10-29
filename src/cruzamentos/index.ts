// Etapa 3: roda todos os cruzamentos de uma UF sobre parquet/<UF>/ e grava parquet/<UF>/achados.parquet.
import path from 'node:path';
import { rename, rm } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { carregarParquet, linhas, lit, prepararContexto, turnosDosPleitos } from './comum.ts';
import * as limites from './limites.ts';
import * as turnos from './turnos.ts';
import * as mesario from './mesario.ts';
import * as horarios from './horarios.ts';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { Cruzamento } from './comum.ts';
import type { Achado, Eleicoes, Linha, Turnos } from '../tipos/dominio.ts';

export const CRUZAMENTOS: Cruzamento[] = [limites, turnos, mesario, horarios];

const COLUNAS = [
  ['cruzamento', 'VARCHAR'], ['uf', 'VARCHAR'], ['mun', 'VARCHAR'], ['zona', 'VARCHAR'], ['secao', 'VARCHAR'],
  ['pleito', 'INTEGER'], ['sinal', 'VARCHAR'], ['pontuacao', 'INTEGER'], ['valor', 'DOUBLE'], ['referencia', 'DOUBLE'],
  ['explicacoesCandidatas', 'VARCHAR'], ['detalhe', 'VARCHAR'],
];

export async function rodarCruzamentos(db: DuckDBConnection, { uf, turnos }: { uf: string; turnos: Turnos }): Promise<Achado[]> {
  await prepararContexto(db, { uf });
  const todos: Achado[] = [];
  for (const c of CRUZAMENTOS) todos.push(...(await c.executar(db, { uf, turnos })));
  return todos;
}

// turnos: { primeiro, segundo } já resolvidos, ou derivados de `eleicoes` (ele-c.json) e dos pleitos nos Parquet.
export async function analisarUF({ dados, uf, turnos, eleicoes }: {
  dados: string;
  uf: string;
  turnos?: Turnos | undefined;
  eleicoes?: Eleicoes | undefined;
}): Promise<{ destino: string; rows: Achado[]; turnos: Turnos }> {
  const pasta = path.join(dados, 'parquet', uf.toUpperCase());
  const instancia = await DuckDBInstance.create(':memory:');
  const db = await instancia.connect();
  try {
    await carregarParquet(db, pasta);
    if (!turnos) {
      const presentes = (await linhas(db, 'SELECT DISTINCT pleito FROM secoes')).map((r) => r.pleito);
      turnos = turnosDosPleitos(eleicoes!, presentes);
    }
    const rows = await rodarCruzamentos(db, { uf, turnos });
    await db.run(`CREATE TABLE achados (${COLUNAS.map(([c, t]) => `"${c}" ${t}`).join(', ')})`);
    const ap = await db.createAppender('achados');
    for (const r of rows) {
      for (const [c, t] of COLUNAS) {
        const v = (r as unknown as Linha)[c];
        if (v == null) ap.appendNull();
        else if (t === 'INTEGER') ap.appendInteger(Number(v));
        else if (t === 'DOUBLE') ap.appendDouble(Number(v));
        else ap.appendVarchar(String(v));
      }
      ap.endRow();
    }
    ap.closeSync();
    const destino = path.join(pasta, 'achados.parquet');
    await db.run(`COPY achados TO ${lit(`${destino}.part`)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    await rm(destino, { force: true });
    await rename(`${destino}.part`, destino);
    return { destino, rows, turnos };
  } finally {
    db.closeSync();
    instancia.closeSync();
  }
}

// Contagens por cruzamento/sinal e as seções com maior pontuação (máximo entre os achados).
export function resumir(rows: Achado[], top = 10): {
  contagem: Record<string, number>;
  ranking: { secao: string; max: number; sinais: string[]; explicacoes: string[] }[];
} {
  const contagem: Record<string, number> = {};
  const porSecao = new Map<string, { secao: string; max: number; sinais: Set<string>; explicacoes: Set<string> }>();
  for (const r of rows) {
    contagem[`${r.cruzamento}/${r.sinal}`] = (contagem[`${r.cruzamento}/${r.sinal}`] ?? 0) + 1;
    const k = `${r.mun}/${r.zona}/${r.secao}`;
    const s = porSecao.get(k) ?? { secao: k, max: 0, sinais: new Set(), explicacoes: new Set() };
    s.max = Math.max(s.max, r.pontuacao);
    s.sinais.add(`${r.sinal}@${r.pleito}(${r.pontuacao})`);
    for (const e of String(r.explicacoesCandidatas || '').split(',').filter(Boolean)) s.explicacoes.add(e);
    porSecao.set(k, s);
  }
  const ranking = [...porSecao.values()].sort((a, b) => b.max - a.max || b.sinais.size - a.sinais.size || a.secao.localeCompare(b.secao))
    .slice(0, top).map((s) => ({ ...s, sinais: [...s.sinais], explicacoes: [...s.explicacoes] }));
  return { contagem, ranking };
}
