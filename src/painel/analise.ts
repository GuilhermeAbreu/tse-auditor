// Análise no painel: consultas (DuckDB direto nos Parquet de parquet/<UF>/) e a fila de jobs
// extrair + analisar, que roda `node src/cli.ts` em processo filho (fora do event loop do painel).
// Os resultados são seções destoantes com sinais e explicações candidatas; nunca veredito.
import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { desloc, linhas, lit, turnosDosPleitos } from '../cruzamentos/comum.ts';
import { UFS } from '../ufs.ts';
import type { Eleicoes, EstadoPainel, Linha, Turnos } from '../tipos/dominio.ts';

export type EstadoJob = 'na fila' | 'rodando' | 'concluído' | 'erro';
export interface Job {
  id: number;
  uf: string;
  pasta: string;
  origem: string;
  estado: EstadoJob;
  etapa: 'extrair' | 'analisar' | null;
  progresso: string | null;
  erro: string | null;
  inicio: string | null;
  fim: string | null;
}
export type TurnosDe = (dados: string, uf: string) => Promise<Turnos | undefined>;
export type Rodar = (args: string[], aoProgresso?: (linha: string) => void) => Promise<void>;

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const HAB = "('hab_biometrica', 'hab_ano_nascimento', 'hab_mesario', 'hab_mesario_nao_associado')";

let instancia: DuckDBInstance | null = null;
async function consultar(sql: string): Promise<Linha[]> {
  instancia ??= await DuckDBInstance.create(':memory:', { memory_limit: '1GB' });
  const db = await instancia.connect();
  try {
    return await linhas(db, sql);
  } finally {
    db.closeSync();
  }
}

const existe = (f: string) => access(f).then(() => true, () => false);
const arquivo = (dados: string, uf: string, nome: string) => path.join(dados, 'parquet', uf.toUpperCase(), `${nome}.parquet`);
const parquet = (dados: string, uf: string, nome: string) => `read_parquet(${lit(arquivo(dados, uf, nome))})`;

// UFs com Parquet extraído e, se houver, os achados.
export async function listarUfs(dados: string): Promise<Linha[]> {
  let pastas: string[] = [];
  try {
    pastas = await readdir(path.join(dados, 'parquet'));
  } catch {
    return [];
  }
  const r: Linha[] = [];
  for (const UF of pastas.sort()) {
    const uf = UF.toLowerCase();
    if (!UFS.includes(uf) || !(await existe(arquivo(dados, uf, 'secoes')))) continue;
    const [s] = await consultar(`SELECT count(*)::INTEGER secoes, count(*) FILTER (WHERE status = 'ok')::INTEGER ok,
      list_sort(list_distinct(list(pleito))) pleitos FROM ${parquet(dados, uf, 'secoes')}`);
    const item = { uf, ...s, achados: null, secoesComAchados: null, analisadoEm: null };
    const fa = arquivo(dados, uf, 'achados');
    if (await existe(fa)) {
      const [a] = await consultar(`SELECT count(*)::INTEGER achados, count(DISTINCT (mun, zona, secao))::INTEGER secoesComAchados
        FROM ${parquet(dados, uf, 'achados')}`);
      Object.assign(item, a, { analisadoEm: (await stat(fa)).mtime.toISOString() });
    }
    r.push(item);
  }
  return r;
}

const lista = (col: string) => `list_sort(list_distinct(list_filter(flatten(list(string_split(coalesce(${col}, ''), ','))), lambda x: x <> '')))`;

// Seções por pontuação máxima; com `sinal`, só as que têm esse sinal (a lista mostra todos os sinais da seção).
export async function ranking(
  dados: string, uf: string, { sinal = '', limite = 200 }: { sinal?: string; limite?: number | string } = {},
): Promise<{ sinais: Linha[]; secoes: Linha[] }> {
  if (!(await existe(arquivo(dados, uf, 'achados')))) return { sinais: [], secoes: [] };
  const fonte = parquet(dados, uf, 'achados');
  const sinais = await consultar(`SELECT sinal, count(*)::INTEGER n FROM ${fonte} GROUP BY sinal ORDER BY n DESC, sinal`);
  const secoes = await consultar(`SELECT mun, zona, secao, max(pontuacao)::INTEGER pontuacao, count(*)::INTEGER achados,
      list_sort(list_distinct(list(sinal))) sinais, list_sort(list_distinct(list(pleito))) pleitos,
      ${lista('explicacoesCandidatas')} explicacoes
    FROM ${fonte} GROUP BY mun, zona, secao
    ${sinal ? `HAVING bool_or(sinal = ${lit(sinal)})` : ''}
    ORDER BY pontuacao DESC, achados DESC, mun, zona, secao LIMIT ${Math.max(1, Math.min(5000, Number(limite) || 200))}`);
  return { sinais, secoes };
}

// Uma seção: números de cada turno, votos de presidente (BU), achados e a linha do tempo do dia da eleição
// (votos por 10 min, pela habilitação de cada voto: último evento de habilitação entre o voto anterior e ele;
// sem evento = mesário, como no cruzamento mesario).
export async function detalharSecao(
  dados: string, uf: string, { mun, zona, secao }: { mun: string; zona: string; secao: string },
): Promise<Linha> {
  const onde = `upper(uf) = ${lit(uf.toUpperCase())} AND mun = ${lit(mun)} AND zona = ${lit(zona)} AND secao = ${lit(secao)}`;
  const ts = (c: string) => `strftime(${c}, '%Y-%m-%d %H:%M:%S') ${c}`;
  const turnos = await consultar(`SELECT pleito, status, local, aptos, comparecimento, abstencao,
      qtdHabilitacaoBiometrica, qtdHabilitacaoMesario, qtdHabilitacaoAnoNascimento, tipoUrna, substituida,
      secoesAgregadas, agregadaEm, inconsistencias, logDia, ${ts('abertura')}, ${ts('encerramento')},
      ${ts('logPrimeiroVoto')}, ${ts('logUltimoVoto')}
    FROM ${parquet(dados, uf, 'secoes')} WHERE ${onde} ORDER BY pleito`);
  const presidente = await consultar(`SELECT pleito, tipo, numero, sum(quantidade)::INTEGER votos
    FROM ${parquet(dados, uf, 'votos')} WHERE ${onde} AND origem = 'BU' AND codigoCargo = 1
    GROUP BY ALL ORDER BY pleito, votos DESC, numero`);
  const achados = (await existe(arquivo(dados, uf, 'achados')))
    ? await consultar(`SELECT cruzamento, pleito, sinal, pontuacao, valor, referencia, explicacoesCandidatas, detalhe
        FROM ${parquet(dados, uf, 'achados')} WHERE ${onde} ORDER BY pontuacao DESC, pleito, sinal`)
    : [];
  const ev = `read_parquet(${lit(arquivo(dados, uf, 'eventos_log'))}, file_row_number = true)`;
  const base = `WITH d AS (SELECT pleito, CAST(logDia AS DATE) dia FROM ${parquet(dados, uf, 'secoes')} WHERE ${onde} AND logDia IS NOT NULL),
    e AS (SELECT pleito, file_row_number ordem, ts, tipo FROM ${ev}
          WHERE ${onde} AND modulo = 'VOTA' AND (tipo = 'voto_computado' OR tipo IN ${HAB})),
    s AS (SELECT e.*, coalesce(sum(CASE WHEN tipo = 'voto_computado' THEN 1 ELSE 0 END) OVER (
            PARTITION BY pleito ORDER BY ordem ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) seg
          FROM e JOIN d USING (pleito) WHERE CAST(ts AS DATE) = dia),
    vt AS (SELECT pleito, max(ts) FILTER (WHERE tipo = 'voto_computado') ts,
             coalesce(arg_max(tipo, ordem) FILTER (WHERE tipo IN ${HAB}), 'hab_mesario') hab
           FROM s GROUP BY pleito, seg HAVING count(*) FILTER (WHERE tipo = 'voto_computado') = 1)`;
  const intervalos = await consultar(`${base}
    SELECT pleito, strftime(time_bucket(INTERVAL 10 MINUTE, ts), '%H:%M') inicio, count(*)::INTEGER votos,
      count(*) FILTER (WHERE hab = 'hab_biometrica')::INTEGER biometria,
      count(*) FILTER (WHERE hab LIKE 'hab_mesario%')::INTEGER mesario,
      count(*) FILTER (WHERE hab = 'hab_ano_nascimento')::INTEGER anoNascimento
    FROM vt GROUP BY ALL ORDER BY pleito, inicio`);
  const extremos = await consultar(`${base}
    SELECT pleito, strftime(min(ts), '%H:%M:%S') primeiroVoto, strftime(max(ts), '%H:%M:%S') ultimoVoto, count(*)::INTEGER votos
    FROM vt GROUP BY pleito ORDER BY pleito`);
  const linhaDoTempo = extremos.map((x) => ({ ...x, intervalos: intervalos.filter((i) => i.pleito === x.pleito) }));
  return { uf, mun, zona, secao, horasParaBrasilia: desloc(uf), turnos, presidente, achados, linhaDoTempo };
}

// Pleitos baixados para a UF (pastas raw/<UF>/<pleito>).
export async function pleitosBaixados(dados: string, uf: string): Promise<string[]> {
  try {
    return (await readdir(path.join(dados, 'raw', uf.toUpperCase()))).filter((p) => /^\d+$/.test(p));
  } catch {
    return [];
  }
}

// Roda `node src/cli.ts <args>`; progresso pelas linhas do stderr (o extrair usa \r).
export function rodarCli(args: string[], aoProgresso: (linha: string) => void = () => {}): Promise<void> {
  return new Promise<void>((ok, falha) => {
    const filho = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let resto = '';
    let ultima = '';
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (t: string) => {
      const partes = (resto + t).split(/[\r\n]/);
      resto = partes.pop()!;
      for (const p of partes) if (p.trim()) aoProgresso((ultima = p.trim()));
    });
    filho.on('error', falha);
    filho.on('close', (codigo) => (codigo === 0 ? ok() : falha(new Error((resto.trim() || ultima || `saiu com código ${codigo}`)))));
  });
}

// Fila de jobs extrair + analisar, um por vez. `turnosDe(dados, uf)` devolve { primeiro, segundo } ou undefined
// (o CLI então busca o ele-c.json).
export class FilaAnalise {
  #jobs: Job[] = [];
  #rodando: { id: number; promessa: Promise<void> } | null = null;
  #seq = 0;
  #vistos = new Map<string, string>();
  declare turnosDe: TurnosDe;
  declare rodar: Rodar;
  declare maxHistorico: number; // uf -> último status de coleta visto (para a automação)

  constructor({ turnosDe = async () => undefined, rodar = rodarCli, maxHistorico = 20 }: { turnosDe?: TurnosDe; rodar?: Rodar; maxHistorico?: number } = {}) {
    Object.assign(this, { turnosDe, rodar, maxHistorico });
  }

  listar(): { rodando: number | null; jobs: Job[] } {
    return { rodando: this.#rodando?.id ?? null, jobs: this.#jobs.map((j) => ({ ...j })) };
  }

  enfileirar(uf: string, dados: string, origem = 'painel'): Job {
    const pendente = this.#jobs.find((j) => j.uf === uf && (j.estado === 'na fila' || j.estado === 'rodando'));
    if (pendente) return pendente;
    const job: Job = { id: ++this.#seq, uf, pasta: dados, origem, estado: 'na fila', etapa: null, progresso: null, erro: null, inicio: null, fim: null };
    this.#jobs.push(job);
    while (this.#jobs.length > this.maxHistorico) {
      const i = this.#jobs.findIndex((j) => j.estado !== 'na fila' && j.estado !== 'rodando');
      if (i < 0) break;
      this.#jobs.splice(i, 1);
    }
    this.#proximo();
    return job;
  }

  aguardar(): Promise<void> {
    return this.#rodando?.promessa ?? Promise.resolve();
  }

  async #executar(job: Job, dados: string): Promise<void> {
    job.estado = 'rodando';
    job.inicio = new Date().toISOString();
    try {
      job.etapa = 'extrair';
      await this.rodar(['extrair', '--uf', job.uf, '--dados', dados], (p) => { job.progresso = p; });
      job.etapa = 'analisar';
      job.progresso = null;
      const t = await this.turnosDe(dados, job.uf);
      const turnos = t ? ['--turnos', [t.primeiro, t.segundo].filter((x) => x != null).join(',')] : [];
      await this.rodar(['analisar', '--uf', job.uf, '--dados', dados, ...turnos], (p) => { job.progresso = p; });
      job.estado = 'concluído';
    } catch (err) {
      job.estado = 'erro';
      job.erro = (err as Error).message;
    }
    job.fim = new Date().toISOString();
  }

  #proximo(): void {
    if (this.#rodando) return;
    const job = this.#jobs.find((j) => j.estado === 'na fila');
    if (!job) return;
    const promessa = this.#executar(job, job.pasta).finally(() => {
      this.#rodando = null;
      this.#proximo();
    });
    this.#rodando = { id: job.id, promessa };
  }

  // Automação: UF que passou a baixado/baixado_com_erros durante esta execução entra na fila.
  observar(estado: Pick<EstadoPainel, 'ufs'> | null | undefined, dados: string | null | undefined, ligado: boolean): void {
    for (const u of estado?.ufs ?? []) {
      const antes = this.#vistos.get(u.uf);
      this.#vistos.set(u.uf, u.status);
      const pronto = (s: string | undefined) => s === 'baixado' || s === 'baixado_com_erros';
      if (ligado && dados && antes !== undefined && !pronto(antes) && pronto(u.status)) this.enfileirar(u.uf, dados, 'automática');
    }
  }
}

export const turnosPelasEleicoes = (eleicoes: Eleicoes | null | undefined): TurnosDe => async (dados, uf) => {
  if (!eleicoes) return undefined;
  const t = turnosDosPleitos(eleicoes, await pleitosBaixados(dados, uf));
  return t.primeiro == null ? undefined : t;
};
