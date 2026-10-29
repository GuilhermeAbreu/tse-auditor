import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { montarEstado, statusDaUf } from '../../src/coleta/estado.js';
import { Manifest } from '../../src/storage/manifest.js';

const secao = (n, principal = null) => ({ zona: '0001', secao: n, principal });
const chave = (uf, mun, n) => ({ pleito: '3220', uf, mun, zona: '0001', secao: n });

test('agrega seções por UF, calcula projeção e status', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-estado-'));
  const manifest = new Manifest(path.join(dir, 'manifest.sqlite'), { cacheResumoMs: 0 });
  t.after(() => manifest.fechar());
  manifest.registrarUfs(['ac', 'al']);
  manifest.registrarConfig('3220', 'ac', [{ mun: '01066', nome: 'X', secoes: [
    secao('0001'), secao('0002'), secao('0003'), secao('0004', '0001'),
  ] }]);
  manifest.registrarConfig('3220', 'al', [{ mun: '27000', nome: 'Y', secoes: [secao('0001')] }]);
  manifest.finalizarSecao(chave('ac', '01066', '0001'), { status: 'completa', bytes: 1000 });
  manifest.finalizarSecao(chave('ac', '01066', '0002'), { status: 'erro', erro: 'x' });
  manifest.finalizarSecao(chave('ac', '01066', '0003'), { status: 'sem_arquivos' });

  const coletor = {
    estado: { rodando: true, ufAtual: 'al', municipioAtual: '27000 Y', motivoParada: null },
    velocidadeBps: () => 500,
  };
  const e = await montarEstado({ manifest, coletor, pastaDados: dir, bytesLivres: async () => 999 });

  assert.deepEqual(e.ufs.find((u) => u.uf === 'ac'), {
    uf: 'ac', pausada: false, total: 3, concluidas: 2, erros: 1, semArquivos: 1, agregadas: 1, bytes: 1000, status: 'baixado',
  });
  assert.equal(e.ufs.find((u) => u.uf === 'al').status, 'baixando');
  assert.deepEqual(e.totais, { secoes: 4, concluidas: 2, erros: 1, semArquivos: 1, bytes: 1000 });
  assert.deepEqual(e.disco, { livres: 999, projecaoBytes: 1333, projecaoPreliminar: false });
  assert.equal(e.coleta.velocidadeBps, 500);
  assert.equal(e.coleta.ufAtual, 'al');
  assert.deepEqual(e.errosSecoes.map((x) => x.erro), ['x']);
  assert.ok(Array.isArray(e.eventos));
  assert.equal(e.manifestErro, null);
});

test('projeção nula enquanto nenhuma seção terminou; livre nulo se o HD sumiu', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-estado-'));
  const manifest = new Manifest(path.join(dir, 'manifest.sqlite'), { cacheResumoMs: 0 });
  t.after(() => manifest.fechar());
  const coletor = { estado: { rodando: false, ufAtual: null }, velocidadeBps: () => 0 };
  const e = await montarEstado({ manifest, coletor, pastaDados: dir, bytesLivres: async () => { throw new Error('EIO'); } });
  assert.deepEqual(e.disco, { livres: null, projecaoBytes: null, projecaoPreliminar: true });
});

test('statusDaUf', () => {
  const parada = { rodando: false, ufAtual: null };
  assert.equal(statusDaUf({ uf: 'ac', pausada: true, total: 1, concluidas: 0, erros: 0 }, parada), 'pausada');
  assert.equal(statusDaUf({ uf: 'ac', pausada: false, total: 1, concluidas: 0, erros: 0 }, parada), 'aguardando');
  assert.equal(statusDaUf({ uf: 'ac', pausada: false, total: 0, concluidas: 0, erros: 0 }, parada), 'aguardando');
  assert.equal(statusDaUf({ uf: 'ac', pausada: false, total: 2, concluidas: 1, erros: 1 }, parada), 'baixado');
});
