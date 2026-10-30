import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { criarPainel } from '../../src/painel/server.ts';
import { comparativo, dispersao, distribuicao, lerCandidatos, mapa, nomesCandidatos, ufsComparacao } from '../../src/painel/graficos.ts';
import type { AddressInfo } from 'node:net';
import type { Eleicoes } from '../../src/tipos/dominio.ts';

type Item = Record<string, any>;

// AC: 2 seções (zona 0001); RR: 1 seção (zona 0002). Pleitos 3220 (1º) e 3221 (2º).
// Mesário AC/0010: 4/80 = 5% (1º) e 12/85 ≈ 14,1% (2º); AC/0020: 0/40 = 0%; RR/0030: 30/50 = 60% e 50/50 = 100%.
async function fixture() {
  const dados = await mkdtemp(path.join(os.tmpdir(), 'tse-graficos-'));
  const db = await (await DuckDBInstance.create(':memory:')).connect();
  const secoes = (uf: string, linhas: string) => `SELECT * FROM (VALUES ${linhas})
    t(pleito, uf, mun, zona, secao, status, aptos, comparecimento, abstencao, qtdHabilitacaoBiometrica, qtdHabilitacaoMesario, qtdHabilitacaoAnoNascimento)`;
  const votos = (linhas: string) => `SELECT * FROM (VALUES ${linhas}) t(pleito, uf, mun, zona, secao, origem, codigoCargo, tipo, numero, quantidade)`;
  const gravar = async (uf: string, nome: string, sql: string) => {
    const pasta = path.join(dados, 'parquet', uf);
    await mkdir(pasta, { recursive: true });
    await db.run(`COPY (${sql}) TO '${pasta}/${nome}.parquet' (FORMAT PARQUET)`);
  };
  await gravar('AC', 'secoes', secoes('AC', `
    (3220, 'AC', '01392', '0001', '0010', 'ok', 100, 80, 20, 70, 4, 6), (3221, 'AC', '01392', '0001', '0010', 'ok', 100, 85, 15, 70, 12, 3),
    (3220, 'AC', '01392', '0001', '0020', 'ok', 50, 40, 10, 40, 0, 0), (3221, 'AC', '01392', '0001', '0020', 'ok', 50, 40, 10, 40, 0, 0),
    (3220, 'AC', '01392', '0001', '0099', 'agregada', NULL, NULL, NULL, NULL, NULL, NULL)`));
  await gravar('AC', 'votos', votos(`
    (3220, 'AC', '01392', '0001', '0010', 'BU', 1, 'nominal', 22, 50), (3220, 'AC', '01392', '0001', '0010', 'BU', 1, 'nominal', 13, 20),
    (3220, 'AC', '01392', '0001', '0010', 'BU', 1, 'nominal', 30, 6), (3220, 'AC', '01392', '0001', '0010', 'BU', 1, 'branco', NULL, 2),
    (3220, 'AC', '01392', '0001', '0010', 'BU', 1, 'nulo', NULL, 2), (3220, 'AC', '01392', '0001', '0010', 'RDV', 1, 'nominal', 22, 50),
    (3221, 'AC', '01392', '0001', '0010', 'BU', 1, 'nominal', 22, 60), (3221, 'AC', '01392', '0001', '0010', 'BU', 1, 'nominal', 13, 25),
    (3220, 'AC', '01392', '0001', '0020', 'BU', 1, 'nominal', 22, 10), (3220, 'AC', '01392', '0001', '0020', 'BU', 1, 'nominal', 13, 30),
    (3221, 'AC', '01392', '0001', '0020', 'BU', 1, 'nominal', 22, 10), (3221, 'AC', '01392', '0001', '0020', 'BU', 1, 'nominal', 13, 30),
    (3220, 'AC', '01392', '0001', '0020', 'BU', 3, 'nominal', 99, 40)`));
  await gravar('AC', 'achados', `SELECT * FROM (VALUES ('mesario', 'AC', '01392', '0001', '0010', 3221, 'MESARIO_ACIMA_ZONA', 70))
    t(cruzamento, uf, mun, zona, secao, pleito, sinal, pontuacao)`);
  await gravar('RR', 'secoes', secoes('RR', `
    (3220, 'RR', '03018', '0002', '0030', 'ok', 60, 50, 10, 20, 30, 0), (3221, 'RR', '03018', '0002', '0030', 'ok', 60, 50, 10, 0, 50, 0)`));
  await gravar('RR', 'votos', votos(`
    (3220, 'RR', '03018', '0002', '0030', 'BU', 1, 'nominal', 13, 40), (3220, 'RR', '03018', '0002', '0030', 'BU', 1, 'nominal', 22, 10),
    (3221, 'RR', '03018', '0002', '0030', 'BU', 1, 'nominal', 13, 30), (3221, 'RR', '03018', '0002', '0030', 'BU', 1, 'nominal', 22, 20)`));
  db.closeSync();
  return dados;
}

test('comparativo: Brasil, UF e zona, por turno, com cobertura', async () => {
  const dados = await fixture();
  const br = await comparativo(dados, { escopo: 'brasil' }) as Item;
  assert.deepEqual(br.cobertura.ufs, ['ac', 'rr']);
  assert.equal(br.cobertura.semDados.length, 26);
  const [t1, t2] = br.turnos;
  assert.deepEqual([t1.turno, t1.pleito, t1.secoes, t1.aptos, t1.comparecimento, t1.mesario, t1.validos, t1.brancos, t1.nulos], [1, 3220, 3, 210, 170, 34, 166, 2, 2]);
  assert.deepEqual(t1.candidatos.map((c: Item) => [c.numero, c.votos]), [[13, 90], [22, 70], [30, 6]]);
  assert.deepEqual([t2.turno, t2.comparecimento, t2.candidatos.map((c: Item) => c.votos)], [2, 175, [90, 85]]);

  const ac = await comparativo(dados, { escopo: 'uf', ufs: ['ac'], zona: '0001' }) as Item;
  assert.deepEqual(ac.zonas, ['0001']);
  assert.deepEqual(ac.turnos.map((t: Item) => [t.turno, t.comparecimento, t.biometria]), [[1, 120, 110], [2, 125, 110]]);
  await assert.rejects(comparativo(dados, { escopo: 'uf', ufs: ['ac', 'rr'], zona: '0001' }), /única UF/);
});

test('ufs-comparacao, dispersão e mapa', async () => {
  const dados = await fixture();
  const u = await ufsComparacao(dados, { ufs: ['ac', 'rr', 'sp'] }) as Item;
  assert.deepEqual(u.ufs.map((x: Item) => [x.uf, x.destoantes, x.turnos.length]), [['ac', 1, 2], ['rr', null, 2]]);
  const rr2 = u.ufs[1].turnos[1];
  assert.deepEqual([rr2.abstencaoPct, rr2.mesarioPct, rr2.candidatos[0].pct], [10 / 60, 1, 0.6]);

  const z = await dispersao(dados, { uf: 'ac', nivel: 'zona', candidato: 22 }) as Item;
  assert.deepEqual(z.pontos.map((p: Item) => [p.id, p.pct1, p.pct2, p.destoante]), [['0001', 60 / 116, 70 / 125, true]]);
  const s = await dispersao(dados, { uf: 'ac', nivel: 'secao' }) as Item;
  assert.equal(s.candidato, 22, 'padrão: mais votado no 2º turno');
  assert.deepEqual(s.pontos.map((p: Item) => [p.id, p.destoante, p.pontuacao]), [['01392/0001/0010', true, 70], ['01392/0001/0020', false, null]]);

  const m = await mapa(dados, { turno: 1 }) as Item;
  assert.equal(m.ufs.length, 28);
  assert.deepEqual(m.ufs.filter((x: Item) => x.coletado).map((x: Item) => [x.uf, x.vencedor]), [['ac', 22], ['rr', 13]]);
  const ac = m.ufs.find((x: Item) => x.uf === 'ac');
  assert.ok(Math.abs(ac.margem - (60 - 50) / 116) < 1e-12);
  assert.deepEqual(m.ufs.find((x: Item) => x.uf === 'sp'), { uf: 'sp', coletado: false, candidatos: [], validos: 0, brancos: 0, nulos: 0, vencedor: null, margem: null });
});

test('distribuição: faixas de 2 p.p. da liberação pelo mesário', async () => {
  const dados = await fixture();
  const h = await distribuicao(dados, { ufs: [] }) as Item;
  assert.equal(h.bins.length, 50);
  const [t1, t2] = h.turnos;
  const nao0 = (c: number[]) => c.flatMap((n, i) => (n ? [[i, n]] : []));
  assert.deepEqual(nao0(t1.contagens), [[0, 1], [2, 1], [30, 1]]); // 0%, 5%, 60%
  assert.deepEqual(nao0(t2.contagens), [[0, 1], [7, 1], [49, 1]]); // 0%, 14,1%, 100% na última faixa
  assert.equal(t1.secoes, 3);
  await assert.rejects(distribuicao(dados, { metrica: 'outra' }), /mesario/);
});

test('nomes dos candidatos a partir do arquivo "u" do TSE', async () => {
  const u = { carg: [{ cd: '1', agr: [{ par: [{ sg: 'PL', cand: [{ n: '22', nm: 'NOME COMPLETO', nmu: 'NOME DE URNA' }] }] }] }] };
  assert.deepEqual(lerCandidatos(u), { 22: { nome: 'NOME DE URNA', partido: 'PL' } });
  const eleicoes = {
    templates: { cs: '', aux: '', u: '<base>/<ambiente>/<ciclo>/<cd_eleicao>/dados/<uf>' },
    pleitos: [{ cd: '3220', ciclo: 'ele2026', data: '', eleicoes: [{ cd: '6257', nome: '', turno: 1, cargos: [{ cd: '1', nome: 'Presidente' }] }] }],
  } as unknown as Eleicoes;
  const urls: string[] = [];
  const r = await nomesCandidatos(eleicoes, { base: 'http://x', ambiente: 'oficial', pastaCache: null, buscar: async (url) => { urls.push(url); return u; } });
  assert.deepEqual(urls, ['http://x/oficial/ele2026/6257/dados/br/br-c0001-e006257-u.json']);
  assert.equal(r.candidatos['22']!.nome, 'NOME DE URNA');
  assert.deepEqual(await nomesCandidatos(undefined, { base: 'http://x', ambiente: 'oficial' }), { fonte: null, candidatos: {} });
});

test('rotas: gráficos, mapa, echarts e parâmetros inválidos', async (t) => {
  const dados = await fixture();
  const controle = { configuracao: () => ({ dados }), obterEstado: async () => ({ ufs: [] }), intervaloPainelMs: () => 1000 } as unknown as Parameters<typeof criarPainel>[0]['controle'];
  const servidor = criarPainel({ controle });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }));
  const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const m = await (await fetch(`${url}/api/analise/mapa?turno=2`)).json() as Item;
  assert.deepEqual(m.ufs.filter((x: Item) => !x.coletado).length, 26);
  assert.equal((await fetch(`${url}/api/analise/comparativo?escopo=uf&ufs=ac,rr`)).status, 200);
  assert.equal((await fetch(`${url}/api/analise/dispersao?uf=ac&nivel=x`)).status, 400);
  assert.equal((await fetch(`${url}/api/analise/comparativo?escopo=uf&ufs=xx`)).status, 400);
  assert.deepEqual(await (await fetch(`${url}/api/analise/candidatos`)).json(), { fonte: null, candidatos: {} });
  const e = await fetch(`${url}/vendor/echarts.min.js`);
  assert.equal(e.status, 200);
  assert.match(e.headers.get('content-type')!, /javascript/);
  assert.ok((await e.text()).length > 100_000);
  const g = await (await fetch(`${url}/mapa-br.json`)).json() as Item;
  assert.equal(g.features.length, 27);
});
