import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { criarPainel } from '../../src/painel/server.ts';
import { FilaAnalise } from '../../src/painel/analise.ts';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { EstadoPainel } from '../../src/tipos/dominio.ts';

type Controle = Parameters<typeof criarPainel>[0]['controle'];
type Item = Record<string, unknown>;
const estado = (ufs: { uf: string; status: string }[]) => ({ ufs }) as unknown as EstadoPainel;

const H = { 'x-tse-auditor': '1' };

// parquet/AC/ mínimo: uma seção nos dois turnos, votos de presidente, log com 3 votos e um achado.
async function fixture() {
  const dados = await mkdtemp(path.join(os.tmpdir(), 'tse-analise-'));
  const pasta = path.join(dados, 'parquet', 'AC');
  await mkdir(pasta, { recursive: true });
  const db = await (await DuckDBInstance.create(':memory:')).connect();
  const copiar = (nome: string, sql: string) => db.run(`COPY (${sql}) TO '${pasta}/${nome}.parquet' (FORMAT PARQUET)`);
  await copiar('secoes', `SELECT * FROM (VALUES
    (3220, 'AC', '01392', '0001', '0010', 'ok', 1, 100, 80, 20, 70, 8, 2, 'secao', false, NULL, NULL, NULL, '2026-10-04',
      TIMESTAMP '2026-10-04 06:00:00', TIMESTAMP '2026-10-04 15:00:00', TIMESTAMP '2026-10-04 06:01:00', TIMESTAMP '2026-10-04 06:25:00'),
    (3221, 'AC', '01392', '0001', '0010', 'ok', 1, 100, 85, 15, 70, 13, 2, 'secao', false, NULL, NULL, NULL, '2026-10-25',
      TIMESTAMP '2026-10-25 06:00:00', TIMESTAMP '2026-10-25 15:00:00', NULL, NULL))
    t(pleito, uf, mun, zona, secao, status, local, aptos, comparecimento, abstencao, qtdHabilitacaoBiometrica, qtdHabilitacaoMesario,
      qtdHabilitacaoAnoNascimento, tipoUrna, substituida, secoesAgregadas, agregadaEm, inconsistencias, logDia, abertura, encerramento,
      logPrimeiroVoto, logUltimoVoto)`);
  await copiar('votos', `SELECT * FROM (VALUES (3220, 'AC', '01392', '0001', '0010', 'BU', 1, 1, 'Presidente', 'nominal', 13, 50),
    (3220, 'AC', '01392', '0001', '0010', 'BU', 1, 1, 'Presidente', 'nominal', 22, 30))
    t(pleito, uf, mun, zona, secao, origem, eleicao, codigoCargo, cargo, tipo, numero, quantidade)`);
  await copiar('eventos_log', `SELECT * FROM (VALUES
    (3220, 'AC', '01392', '0001', '0010', TIMESTAMP '2026-10-04 06:00:30', 'VOTA', 'hab_biometrica'),
    (3220, 'AC', '01392', '0001', '0010', TIMESTAMP '2026-10-04 06:01:00', 'VOTA', 'voto_computado'),
    (3220, 'AC', '01392', '0001', '0010', TIMESTAMP '2026-10-04 06:02:00', 'VOTA', 'voto_computado'),
    (3220, 'AC', '01392', '0001', '0010', TIMESTAMP '2026-10-04 06:24:00', 'VOTA', 'hab_ano_nascimento'),
    (3220, 'AC', '01392', '0001', '0010', TIMESTAMP '2026-10-04 06:25:00', 'VOTA', 'voto_computado'))
    t(pleito, uf, mun, zona, secao, ts, modulo, tipo)`);
  await copiar('achados', `SELECT * FROM (VALUES
    ('mesario', 'AC', '01392', '0001', '0010', 3220, 'MESARIO_ACIMA_ZONA', 60, 0.1, 0.02, 'fila_17h', '{}'),
    ('mesario', 'AC', '01392', '0001', '0010', 3221, 'MESARIO_SUBIU_OUTRO_TURNO', 45, 0.15, 0.1, '', '{}'),
    ('turnos', 'AC', '01392', '0001', '0020', 3221, 'VARIACAO_ATIPICA_ZONA', 50, 0.3, 0.0, 'contingencia', '{}'))
    t(cruzamento, uf, mun, zona, secao, pleito, sinal, pontuacao, valor, referencia, explicacoesCandidatas, detalhe)`);
  db.closeSync();
  return dados;
}

async function subir(t: TestContext, { dados, fila }: { dados: string; fila?: FilaAnalise }) {
  const controle = { configuracao: () => ({ dados }), obterEstado: async () => ({ ufs: [] }), intervaloPainelMs: () => 1000 } as unknown as Controle;
  const servidor = criarPainel({ controle, fila });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }));
  return `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
}

test('rotas de análise: ufs, ranking com filtro e seção com linha do tempo', async (t) => {
  const dados = await fixture();
  const url = await subir(t, { dados, fila: new FilaAnalise({ rodar: async () => {} }) });
  const ufs = await (await fetch(`${url}/api/analise/ufs`)).json() as any;
  assert.deepEqual(ufs.ufs.map((u: Item) => [u.uf, u.secoes, u.achados, u.secoesComAchados]), [['ac', 2, 3, 2]]);

  const r = await (await fetch(`${url}/api/analise/ac/ranking`)).json() as any;
  assert.deepEqual(r.secoes.map((s: Item) => [s.secao, s.pontuacao, s.sinais, s.explicacoes]), [
    ['0010', 60, ['MESARIO_ACIMA_ZONA', 'MESARIO_SUBIU_OUTRO_TURNO'], ['fila_17h']],
    ['0020', 50, ['VARIACAO_ATIPICA_ZONA'], ['contingencia']]]);
  const f = await (await fetch(`${url}/api/analise/ac/ranking?sinal=VARIACAO_ATIPICA_ZONA`)).json() as any;
  assert.deepEqual(f.secoes.map((s: Item) => s.secao), ['0020']);

  const s = await (await fetch(`${url}/api/analise/ac/secao/01392/0001/0010`)).json() as any;
  assert.deepEqual(s.turnos.map((x: Item) => [x.pleito, x.comparecimento]), [[3220, 80], [3221, 85]]);
  assert.equal(s.presidente.length, 2);
  assert.equal(s.achados.length, 2);
  assert.equal(s.horasParaBrasilia, 2);
  const [lt] = s.linhaDoTempo;
  assert.deepEqual([lt.pleito, lt.primeiroVoto, lt.ultimoVoto, lt.votos], [3220, '06:01:00', '06:25:00', 3]);
  // 06:01 biometria, 06:02 sem evento = mesário, 06:25 ano de nascimento
  assert.deepEqual(lt.intervalos.map((i: Item) => [i.inicio, i.biometria, i.mesario, i.anoNascimento]), [['06:00', 1, 1, 0], ['06:20', 0, 0, 1]]);

  assert.equal((await fetch(`${url}/api/analise/xx/ranking`)).status, 404);
  assert.equal((await fetch(`${url}/api/analise/ac/secao/x/1/1`)).status, 404);
});

test('executar exige o cabeçalho; fila roda extrair e analisar um job por vez', async (t) => {
  const chamadas: string[][] = [];
  let liberar!: () => void;
  const trava = new Promise<void>((r) => { liberar = r; });
  const fila = new FilaAnalise({
    turnosDe: async () => ({ primeiro: 3220, segundo: 3221 }),
    rodar: async (args, prog) => { chamadas.push(args.slice(0, 3).concat(args.slice(5))); prog!('mun 1'); if (args[0] === 'extrair') await trava; },
  });
  const url = await subir(t, { dados: '/x', fila });
  assert.equal((await fetch(`${url}/api/analise/ac/executar`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${url}/api/analise/ac/executar`, { method: 'POST', headers: H })).status, 202);
  await fetch(`${url}/api/analise/sp/executar`, { method: 'POST', headers: H });
  let jobs = await (await fetch(`${url}/api/analise/jobs`)).json() as any;
  assert.deepEqual(jobs.jobs.map((j: Item) => [j.uf, j.estado, j.etapa, j.progresso]), [['ac', 'rodando', 'extrair', 'mun 1'], ['sp', 'na fila', null, null]]);
  liberar();
  await fila.aguardar();
  await fila.aguardar();
  jobs = fila.listar();
  assert.deepEqual(jobs.jobs.map((j: Item) => j.estado), ['concluído', 'concluído']);
  assert.deepEqual(chamadas, [['extrair', '--uf', 'ac'], ['analisar', '--uf', 'ac', '--turnos', '3220,3221'],
    ['extrair', '--uf', 'sp'], ['analisar', '--uf', 'sp', '--turnos', '3220,3221']]);
});

test('fila: erro registrado e automação só na transição para baixado', async () => {
  const fila = new FilaAnalise({ rodar: async () => { throw new Error('falhou'); } });
  fila.observar(estado([{ uf: 'ac', status: 'baixado' }, { uf: 'sp', status: 'baixando' }]), '/d', true);
  assert.equal(fila.listar().jobs.length, 0); // já estava pronta ao abrir: não refaz
  fila.observar(estado([{ uf: 'ac', status: 'baixado' }, { uf: 'sp', status: 'baixado_com_erros' }]), '/d', true);
  await fila.aguardar();
  assert.deepEqual(fila.listar().jobs.map((j) => [j.uf, j.origem, j.estado, j.erro]), [['sp', 'automática', 'erro', 'falhou']]);
});
