// Dados dos gráficos da aba Análise (visão geral): agregados de todas as UFs com Parquet, por turno.
// DuckDB direto nos Parquet; resultados em memória por (consulta, mtime/tamanho dos Parquet).
// Presidente sempre pelo BU (origem = 'BU', codigoCargo = 1); percentuais de candidato sobre os votos nominais (válidos).
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { linhas, lit, turnosDosPleitos } from '../cruzamentos/comum.ts';
import { preencher } from '../tse/urls.ts';
import { UFS } from '../ufs.ts';
import type { Eleicoes, Linha, Turnos } from '../tipos/dominio.ts';

export class ParametroInvalido extends Error {}

let instancia: DuckDBInstance | null = null;
async function consultar<T = Linha>(sql: string): Promise<T[]> {
  instancia ??= await DuckDBInstance.create(':memory:', { memory_limit: '1GB' });
  const db = await instancia.connect();
  try {
    return await linhas<T>(db, sql);
  } finally {
    db.closeSync();
  }
}

const arquivo = (dados: string, uf: string, nome: string) => path.join(dados, 'parquet', uf.toUpperCase(), `${nome}.parquet`);
const existe = (f: string) => stat(f).then(() => true, () => false);
const fonte = (arqs: string[]) => `read_parquet([${arqs.map(lit).join(', ')}], union_by_name = true)`;

// UFs (minúsculas, ordem de UFS) com secoes.parquet e votos.parquet.
export async function ufsComDados(dados: string): Promise<string[]> {
  let pastas: string[] = [];
  try {
    pastas = await readdir(path.join(dados, 'parquet'));
  } catch {
    return [];
  }
  const r: string[] = [];
  for (const uf of UFS) {
    if (!pastas.includes(uf.toUpperCase())) continue;
    if ((await existe(arquivo(dados, uf, 'secoes'))) && (await existe(arquivo(dados, uf, 'votos')))) r.push(uf);
  }
  return r;
}

// ---- cache por (chave, marca dos Parquet) ----
const cache = new Map<string, { marca: string; valor: unknown }>();
const MAX_CACHE = 200;
async function marca(dados: string, ufs: string[]): Promise<string> {
  const partes = await Promise.all(ufs.flatMap((uf) => ['secoes', 'votos', 'achados'].map(async (n) => {
    const f = arquivo(dados, uf, n);
    try {
      const s = await stat(f);
      return `${uf}/${n}:${s.mtimeMs}:${s.size}`;
    } catch {
      return `${uf}/${n}:-`;
    }
  })));
  return partes.join('|');
}
async function emCache<T>(chave: string, dados: string, f: (ufs: string[]) => Promise<T>): Promise<T> {
  const ufs = await ufsComDados(dados);
  const m = await marca(dados, ufs);
  const k = `${dados}\n${chave}`;
  const c = cache.get(k);
  if (c && c.marca === m) return c.valor as T;
  const valor = await f(ufs);
  cache.delete(k);
  cache.set(k, { marca: m, valor });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return valor;
}
export const limparCache = () => cache.clear();

// 1º/2º turno: pelo ele-c.json quando há; sem ele, os dois menores pleitos presentes.
async function turnosDe(dados: string, ufs: string[], eleicoes: Eleicoes | null | undefined): Promise<Turnos> {
  if (!ufs.length) return { primeiro: null, segundo: null };
  const ps = (await consultar<{ pleito: number }>(`SELECT DISTINCT pleito FROM ${fonte(ufs.map((u) => arquivo(dados, u, 'secoes')))} ORDER BY pleito`))
    .map((p) => Number(p.pleito));
  if (eleicoes) {
    const t = turnosDosPleitos(eleicoes, ps);
    if (t.primeiro != null) return t;
  }
  return { primeiro: ps[0] ?? null, segundo: ps[1] ?? null };
}
const listaTurnos = (t: Turnos) => [[1, t.primeiro], [2, t.segundo]].filter((x): x is [number, number] => x[1] != null);

function validarUfs(ufs: string[], disponiveis: string[]): string[] {
  for (const u of ufs) if (!UFS.includes(u)) throw new ParametroInvalido(`UF inválida: ${u}`);
  return ufs.filter((u) => disponiveis.includes(u));
}

export interface Candidato { numero: number; votos: number; pct: number | null }
export interface TotaisTurno {
  turno: number; pleito: number; secoes: number; aptos: number; comparecimento: number; abstencao: number;
  biometria: number; mesario: number; anoNascimento: number; validos: number; brancos: number; nulos: number;
  candidatos: Candidato[];
}

// Totais por turno (e por UF, se `porUf`) das seções com status ok.
async function totais(dados: string, ufs: string[], turnos: Turnos, onde: string, porUf: boolean): Promise<(TotaisTurno & { uf: string })[]> {
  const lt = listaTurnos(turnos);
  if (!ufs.length || !lt.length) return [];
  const S = fonte(ufs.map((u) => arquivo(dados, u, 'secoes')));
  const V = fonte(ufs.map((u) => arquivo(dados, u, 'votos')));
  const pls = lt.map(([, p]) => p).join(', ');
  const g = porUf ? 'lower(uf)' : "''";
  const sec = await consultar(`SELECT ${g} uf, pleito, count(*)::INTEGER secoes, coalesce(sum(aptos), 0)::BIGINT::DOUBLE aptos,
      coalesce(sum(comparecimento), 0)::DOUBLE comparecimento, coalesce(sum(abstencao), 0)::DOUBLE abstencao,
      coalesce(sum(qtdHabilitacaoBiometrica), 0)::DOUBLE biometria, coalesce(sum(qtdHabilitacaoMesario), 0)::DOUBLE mesario,
      coalesce(sum(qtdHabilitacaoAnoNascimento), 0)::DOUBLE anoNascimento
    FROM ${S} WHERE status = 'ok' AND pleito IN (${pls}) ${onde} GROUP BY ALL`);
  const vot = await consultar(`SELECT ${g} uf, pleito, tipo, numero, sum(quantidade)::DOUBLE votos
    FROM ${V} WHERE origem = 'BU' AND codigoCargo = 1 AND pleito IN (${pls}) ${onde} GROUP BY ALL`);
  const r: (TotaisTurno & { uf: string })[] = [];
  for (const s of sec) {
    const turno = lt.find(([, p]) => p === Number(s.pleito))![0];
    const vs = vot.filter((v) => v.uf === s.uf && Number(v.pleito) === Number(s.pleito));
    const soma = (tipo: string) => vs.filter((v) => v.tipo === tipo).reduce((a, v) => a + Number(v.votos), 0);
    const validos = soma('nominal');
    const candidatos = vs.filter((v) => v.tipo === 'nominal')
      .map((v) => ({ numero: Number(v.numero), votos: Number(v.votos), pct: validos ? Number(v.votos) / validos : null }))
      .sort((a, b) => b.votos - a.votos || a.numero - b.numero);
    r.push({
      uf: String(s.uf), turno, pleito: Number(s.pleito), secoes: Number(s.secoes), aptos: Number(s.aptos),
      comparecimento: Number(s.comparecimento), abstencao: Number(s.abstencao), biometria: Number(s.biometria),
      mesario: Number(s.mesario), anoNascimento: Number(s.anoNascimento), validos, brancos: soma('branco'), nulos: soma('nulo'), candidatos,
    });
  }
  return r.sort((a, b) => a.uf.localeCompare(b.uf) || a.turno - b.turno);
}

const semUf = <T extends { uf: string }>({ uf: _uf, ...r }: T): Omit<T, 'uf'> => r;

export interface OpcoesComparativo { escopo?: string | null; ufs?: string[]; zona?: string | null; mun?: string | null }

// Totais do escopo (Brasil, UFs ou uma zona/município de uma UF) em cada turno, com a cobertura.
export async function comparativo(dados: string, o: OpcoesComparativo, eleicoes?: Eleicoes | null): Promise<Linha> {
  const escopo = o.escopo === 'uf' ? 'uf' : 'brasil';
  const zona = o.zona || null;
  const mun = o.mun || null;
  if (zona && !/^\d{1,6}$/.test(zona)) throw new ParametroInvalido('zona inválida');
  if (mun && !/^\d{1,6}$/.test(mun)) throw new ParametroInvalido('município inválido');
  const chave = JSON.stringify(['comparativo', escopo, o.ufs ?? [], zona, mun]);
  return emCache(chave, dados, async (disp) => {
    const ufs = escopo === 'brasil' ? disp : validarUfs(o.ufs ?? [], disp);
    if ((zona || mun) && ufs.length !== 1) throw new ParametroInvalido('zona e município exigem uma única UF');
    const turnos = await turnosDe(dados, disp, eleicoes);
    const onde = `${zona ? `AND zona = ${lit(zona)}` : ''} ${mun ? `AND mun = ${lit(mun)}` : ''}`;
    const t = (await totais(dados, ufs, turnos, onde, false)).map(semUf);
    const zonas = ufs.length === 1
      ? (await consultar<{ zona: string }>(`SELECT DISTINCT zona FROM ${fonte([arquivo(dados, ufs[0]!, 'secoes')])} ORDER BY zona`)).map((z) => z.zona)
      : [];
    return {
      escopo, ufs, zona, mun, turnos: t, zonas,
      cobertura: { ufs, semDados: UFS.filter((u) => !disp.includes(u)), secoes: t.map((x) => ({ turno: x.turno, secoes: x.secoes })) },
    };
  });
}

async function destoantesPorUf(dados: string, ufs: string[]): Promise<Map<string, number>> {
  const com: string[] = [];
  for (const u of ufs) if (await existe(arquivo(dados, u, 'achados'))) com.push(u);
  if (!com.length) return new Map();
  const r = await consultar(`SELECT lower(uf) uf, count(DISTINCT (mun, zona, secao))::INTEGER n
    FROM ${fonte(com.map((u) => arquivo(dados, u, 'achados')))} GROUP BY ALL`);
  return new Map(r.map((x) => [String(x.uf), Number(x.n)]));
}

// Por UF: % de cada candidato (por turno), % de abstenção, % de liberação pelo mesário e nº de seções destoantes.
export async function ufsComparacao(dados: string, { ufs = [] }: { ufs?: string[] }, eleicoes?: Eleicoes | null): Promise<Linha> {
  return emCache(JSON.stringify(['ufs', ufs]), dados, async (disp) => {
    const sel = ufs.length ? validarUfs(ufs, disp) : disp;
    const turnos = await turnosDe(dados, disp, eleicoes);
    const t = await totais(dados, sel, turnos, '', true);
    const dest = await destoantesPorUf(dados, sel);
    return {
      ufs: sel.map((uf) => ({
        uf, destoantes: dest.get(uf) ?? null,
        turnos: t.filter((x) => x.uf === uf).map((x) => ({
          turno: x.turno, pleito: x.pleito, secoes: x.secoes, validos: x.validos,
          abstencaoPct: x.aptos ? x.abstencao / x.aptos : null,
          mesarioPct: x.comparecimento ? x.mesario / x.comparecimento : null,
          candidatos: x.candidatos,
        })),
      })),
    };
  });
}

export const MAX_PONTOS = 20_000;

// Pontos de zona ou seção: % do candidato (sobre os válidos) no 1º e no 2º turno, comparecimento e se há achados.
export async function dispersao(
  dados: string, { uf, nivel = 'zona', candidato }: { uf: string; nivel?: string; candidato?: string | number | null }, eleicoes?: Eleicoes | null,
): Promise<Linha> {
  if (!UFS.includes(uf)) throw new ParametroInvalido('UF inválida');
  if (nivel !== 'zona' && nivel !== 'secao') throw new ParametroInvalido('nível deve ser zona ou secao');
  if (candidato != null && candidato !== '' && !/^\d{1,5}$/.test(String(candidato))) throw new ParametroInvalido('candidato inválido');
  return emCache(JSON.stringify(['dispersao', uf, nivel, candidato ?? null]), dados, async (disp) => {
    const vazio = { uf, nivel, candidato: null, candidatos: [], pontos: [], total: 0, truncado: false };
    if (!disp.includes(uf)) return vazio;
    const turnos = await turnosDe(dados, disp, eleicoes);
    if (turnos.primeiro == null || turnos.segundo == null) return vazio;
    const [p1, p2] = [turnos.primeiro, turnos.segundo];
    const S = fonte([arquivo(dados, uf, 'secoes')]);
    const V = fonte([arquivo(dados, uf, 'votos')]);
    // candidatos presentes no 2º turno primeiro (o padrão é o mais votado no 2º)
    const cands = (await consultar(`SELECT numero, sum(quantidade) FILTER (WHERE pleito = ${p1})::DOUBLE v1,
        sum(quantidade) FILTER (WHERE pleito = ${p2})::DOUBLE v2
      FROM ${V} WHERE origem = 'BU' AND codigoCargo = 1 AND tipo = 'nominal' AND pleito IN (${p1}, ${p2})
      GROUP BY numero ORDER BY v2 DESC NULLS LAST, v1 DESC, numero`)).map((c) => Number(c.numero));
    const n = candidato != null && candidato !== '' ? Number(candidato) : cands[0];
    if (n == null) return vazio;
    const id = nivel === 'zona' ? 'zona' : "mun || '/' || zona || '/' || secao";
    const grupo = nivel === 'zona' ? 'zona' : 'mun, zona, secao';
    const temAchados = await existe(arquivo(dados, uf, 'achados'));
    const a = temAchados
      ? `SELECT ${id} id, count(DISTINCT (mun, zona, secao))::INTEGER destoantes, max(pontuacao)::INTEGER pontuacao
         FROM ${fonte([arquivo(dados, uf, 'achados')])} GROUP BY ${grupo}`
      : 'SELECT NULL::VARCHAR id, 0 destoantes, NULL::INTEGER pontuacao WHERE false';
    const base = `WITH s AS (SELECT ${id} id, sum(comparecimento) FILTER (WHERE pleito = ${p1})::DOUBLE comparecimento1,
          sum(comparecimento) FILTER (WHERE pleito = ${p2})::DOUBLE comparecimento2
        FROM ${S} WHERE status = 'ok' AND pleito IN (${p1}, ${p2}) GROUP BY ${grupo}),
      v AS (SELECT ${id} id,
          sum(quantidade) FILTER (WHERE pleito = ${p1} AND numero = ${n}) c1, sum(quantidade) FILTER (WHERE pleito = ${p1}) t1,
          sum(quantidade) FILTER (WHERE pleito = ${p2} AND numero = ${n}) c2, sum(quantidade) FILTER (WHERE pleito = ${p2}) t2
        FROM ${V} WHERE origem = 'BU' AND codigoCargo = 1 AND tipo = 'nominal' AND pleito IN (${p1}, ${p2}) GROUP BY ${grupo}),
      a AS (${a}),
      p AS (SELECT s.id, coalesce(c1, 0) / t1 pct1, coalesce(c2, 0) / t2 pct2, comparecimento1, comparecimento2,
          coalesce(a.destoantes, 0) destoantes, a.pontuacao
        FROM s JOIN v USING (id) LEFT JOIN a USING (id) WHERE t1 > 0 AND t2 > 0)`;
    const [{ total }] = await consultar<{ total: number }>(`${base} SELECT count(*)::INTEGER total FROM p`) as [{ total: number }];
    const pontos = (await consultar(`${base} SELECT * FROM p ORDER BY pontuacao DESC NULLS LAST, id LIMIT ${MAX_PONTOS}`)).map((x) => ({
      id: String(x.id), pct1: Number(x.pct1), pct2: Number(x.pct2),
      comparecimento1: Number(x.comparecimento1), comparecimento2: Number(x.comparecimento2),
      destoantes: Number(x.destoantes), destoante: Number(x.destoantes) > 0, pontuacao: x.pontuacao == null ? null : Number(x.pontuacao),
    }));
    return { uf, nivel, candidato: n, candidatos: cands, pontos, total: Number(total), truncado: Number(total) > pontos.length };
  });
}

export const LARGURA_BIN = 2; // pontos percentuais

// Histograma (0–100%, faixas de 2 p.p.) da taxa de liberação pelo mesário por seção, em cada turno.
export async function distribuicao(dados: string, { ufs = [], metrica = 'mesario' }: { ufs?: string[]; metrica?: string }, eleicoes?: Eleicoes | null): Promise<Linha> {
  if (metrica !== 'mesario') throw new ParametroInvalido('métrica disponível: mesario');
  return emCache(JSON.stringify(['distribuicao', ufs, metrica]), dados, async (disp) => {
    const sel = ufs.length ? validarUfs(ufs, disp) : disp;
    const nBins = 100 / LARGURA_BIN;
    const bins = Array.from({ length: nBins }, (_, i) => ({ de: i * LARGURA_BIN, ate: (i + 1) * LARGURA_BIN }));
    const turnos = await turnosDe(dados, disp, eleicoes);
    const lt = listaTurnos(turnos);
    if (!sel.length || !lt.length) return { metrica, ufs: sel, larguraPct: LARGURA_BIN, bins, turnos: [] };
    const r = await consultar(`SELECT pleito, least(${nBins - 1}, floor(100.0 * qtdHabilitacaoMesario / comparecimento / ${LARGURA_BIN}))::INTEGER bin,
        count(*)::INTEGER n
      FROM ${fonte(sel.map((u) => arquivo(dados, u, 'secoes')))}
      WHERE status = 'ok' AND comparecimento > 0 AND qtdHabilitacaoMesario IS NOT NULL AND pleito IN (${lt.map(([, p]) => p).join(', ')})
      GROUP BY ALL`);
    return {
      metrica, ufs: sel, larguraPct: LARGURA_BIN, bins,
      turnos: lt.map(([turno, pleito]) => {
        const contagens = bins.map(() => 0);
        for (const x of r) if (Number(x.pleito) === pleito) contagens[Number(x.bin)] = Number(x.n);
        return { turno, pleito, contagens, secoes: contagens.reduce((a, b) => a + b, 0) };
      }),
    };
  });
}

// Por UF (as 27 + ZZ): votos de presidente no turno, vencedor e margem (p.p. sobre os válidos entre 1º e 2º colocado).
export async function mapa(dados: string, { turno = 1 }: { turno?: number | string }, eleicoes?: Eleicoes | null): Promise<Linha> {
  const t = Number(turno);
  if (t !== 1 && t !== 2) throw new ParametroInvalido('turno deve ser 1 ou 2');
  return emCache(JSON.stringify(['mapa', t]), dados, async (disp) => {
    const turnos = await turnosDe(dados, disp, eleicoes);
    const pleito = t === 1 ? turnos.primeiro : turnos.segundo;
    const tot = pleito == null ? [] : (await totais(dados, disp, { primeiro: t === 1 ? pleito : null, segundo: t === 2 ? pleito : null }, '', true));
    return {
      turno: t, pleito,
      ufs: UFS.map((uf) => {
        const x = tot.find((y) => y.uf === uf);
        if (!x) return { uf, coletado: false, candidatos: [], validos: 0, brancos: 0, nulos: 0, vencedor: null, margem: null };
        const [a, b] = x.candidatos;
        return {
          uf, coletado: true, secoes: x.secoes, candidatos: x.candidatos, validos: x.validos, brancos: x.brancos, nulos: x.nulos,
          vencedor: a?.numero ?? null, margem: a ? (a.pct ?? 0) - (b?.pct ?? 0) : null,
        };
      }),
    };
  });
}

// ---- nomes oficiais dos candidatos a presidente (arquivo "u" do TSE: <uf>-c0001-e<eleição>-u.json, uf = br) ----

export interface NomeCandidato { nome: string; partido: string }
type Buscar = (url: string) => Promise<unknown>;
const memoria = new Map<string, Record<string, NomeCandidato>>();
const PASTA_CACHE = path.join(os.homedir(), '.cache', 'tse-auditor');

async function buscarJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { 'user-agent': 'tse-auditor/0.1 (auditoria independente dos arquivos de urna)' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Extrai { número: { nome de urna, partido } } do cargo 1 de um arquivo "u".
export function lerCandidatos(json: unknown): Record<string, NomeCandidato> {
  const r: Record<string, NomeCandidato> = {};
  const carg = (json as { carg?: { cd: string; agr?: { par?: { sg?: string; cand?: { n: string; nm?: string; nmu?: string }[] }[] }[] }[] })?.carg ?? [];
  for (const c of carg.filter((x) => String(x.cd) === '1')) {
    for (const a of c.agr ?? []) for (const p of a.par ?? []) for (const k of p.cand ?? []) {
      r[String(Number(k.n))] = { nome: k.nmu || k.nm || `Candidato ${k.n}`, partido: p.sg ?? '' };
    }
  }
  return r;
}

export async function nomesCandidatos(
  eleicoes: Eleicoes | null | undefined,
  { base, ambiente, buscar = buscarJson, pastaCache = PASTA_CACHE }: { base: string; ambiente: string; buscar?: Buscar; pastaCache?: string | null },
): Promise<{ fonte: string | null; candidatos: Record<string, NomeCandidato> }> {
  if (!eleicoes?.templates.u) return { fonte: null, candidatos: {} };
  const alvos = eleicoes.pleitos.flatMap((p) => p.eleicoes.filter((e) => e.cargos.some((c) => String(c.cd) === '1'))
    .map((e) => ({ ciclo: p.ciclo, cd: e.cd })));
  const candidatos: Record<string, NomeCandidato> = {};
  let fonte: string | null = null;
  for (const { ciclo, cd } of alvos) {
    const url = `${preencher(eleicoes.templates.u, { base, ambiente, ciclo, cd_eleicao: cd, uf: 'br' })}/br-c0001-e${String(cd).padStart(6, '0')}-u.json`;
    let nomes = memoria.get(url);
    const arqCache = pastaCache ? path.join(pastaCache, `candidatos-${ciclo}-${cd}.json`) : null;
    if (!nomes && arqCache) nomes = await readFile(arqCache, 'utf8').then((t) => JSON.parse(t) as Record<string, NomeCandidato>, () => undefined);
    if (!nomes) {
      try {
        nomes = lerCandidatos(await buscar(url));
      } catch {
        continue; // sem nomes: o painel mostra "Candidato <número>"
      }
      if (arqCache && Object.keys(nomes).length) {
        await mkdir(path.dirname(arqCache), { recursive: true }).then(() => writeFile(arqCache, JSON.stringify(nomes)), () => {});
      }
    }
    memoria.set(url, nomes);
    if (Object.keys(nomes).length) fonte ??= url;
    for (const [n, v] of Object.entries(nomes)) candidatos[n] ??= v;
  }
  return { fonte, candidatos };
}
