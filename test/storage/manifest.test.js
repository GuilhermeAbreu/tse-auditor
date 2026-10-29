import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';

const S77 = { pleito: '3220', uf: 'ac', mun: '01066', zona: '0004', secao: '0077' };
const MUNICIPIOS = [{
  mun: '01066',
  nome: 'PORTO WALTER',
  secoes: [
    { zona: '0004', secao: '0077', principal: null },
    { zona: '0004', secao: '0270', principal: '0077' },
  ],
}];
const CONJUNTOS = [{
  hash: 'h1', status: 'Totalizado', data: '04/10/2026', hora: '18:34:08',
  arquivos: [{ nome: 'a-bu.dat', tipo: 'bu' }, { nome: 'a-vota.vsc', tipo: 'vota' }],
}];

async function novoManifest(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-manifest-'));
  const caminho = path.join(dir, 'manifest.sqlite');
  const m = new Manifest(caminho);
  t.after(() => m.fechar());
  return { m, caminho };
}

test('UFs ficam na ordem de coleta e podem ser pausadas', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarUfs(['zz', 'ac']);
  assert.deepEqual(m.ufs(), [{ uf: 'ac', ordem: 0, pausada: 0 }, { uf: 'zz', ordem: 27, pausada: 0 }]);
  m.definirPausa('zz', true);
  assert.equal(m.ufPausada('zz'), true);
  assert.equal(m.ufPausada('ac'), false);
  m.registrarUfs(['zz']);
  assert.equal(m.ufPausada('zz'), true, 'registrar de novo não desfaz a pausa');
});

test('registrarConfig é idempotente e marca seções agregadas', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  assert.deepEqual(m.municipiosDaUf('ac'), [{ mun: '01066', nome: 'PORTO WALTER' }]);
  assert.deepEqual(m.secoesPendentes('3220', 'ac', '01066'), [S77]);
  const agregada = m.secao({ ...S77, secao: '0270' });
  assert.equal(agregada.status, 'agregada');
  assert.equal(agregada.principal, '0077');
});

test('índice, arquivos e finalização de seção', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.registrarIndice(S77, CONJUNTOS, (hash, nome) => `http://x/${hash}/${nome}`);
  m.registrarIndice(S77, CONJUNTOS, (hash, nome) => `http://x/${hash}/${nome}`);

  const arquivos = m.arquivosDaSecao(S77);
  assert.equal(arquivos.length, 2);
  assert.equal(arquivos[0].nome, 'a-bu.dat');
  assert.equal(arquivos[0].status, 'pendente');
  assert.equal(arquivos[0].url, 'http://x/h1/a-bu.dat');

  m.marcarArquivo(S77, 'h1', 'a-bu.dat', { status: 'ok', bytes: 10, md5: 'm', sha512: 's', verificacao: 'vsc' });
  const bu = m.arquivosDaSecao(S77)[0];
  assert.equal(bu.status, 'ok');
  assert.equal(bu.bytes, 10);
  assert.equal(bu.verificacao, 'vsc');
  assert.equal(bu.tentativas, 1);
  assert.ok(bu.baixado_em);

  m.finalizarSecao(S77, { status: 'completa', bytes: 10 });
  assert.deepEqual(m.secoesPendentes('3220', 'ac', '01066'), []);
  assert.equal(m.secao(S77).status, 'completa');

  m.finalizarSecao(S77, { status: 'erro', erro: 'a-bu.dat: falhou' });
  assert.deepEqual(m.secoesPendentes('3220', 'ac', '01066'), [S77], 'seção com erro volta para a fila');
  assert.deepEqual(m.errosRecentes(5).map((e) => [e.secao, e.erro]), [['0077', 'a-bu.dat: falhou']]);
});

test('municípios empacotados', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  assert.equal(m.municipio('3220', 'ac', '01066').empacotado_em, null);
  assert.equal(m.municipio('3221', 'ac', '01066'), undefined);
  m.marcarEmpacotado('3220', 'ac', '01066', 1234);
  const mun = m.municipio('3220', 'ac', '01066');
  assert.equal(mun.zip_bytes, 1234);
  assert.ok(mun.empacotado_em);
});

test('resumo por UF e eventos', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.finalizarSecao(S77, { status: 'completa', bytes: 10 });
  const resumo = m.resumoPorUf().sort((a, b) => a.status.localeCompare(b.status));
  assert.deepEqual(resumo, [
    { uf: 'ac', status: 'agregada', n: 1, bytes: 0 },
    { uf: 'ac', status: 'completa', n: 1, bytes: 10 },
  ]);
  m.registrarEvento('erro', 'ac', 'falhou x');
  const [ev] = m.eventos(10);
  assert.equal(ev.nivel, 'erro');
  assert.equal(ev.uf, 'ac');
  assert.equal(ev.msg, 'falhou x');
  assert.ok(ev.ts);
});

test('persiste entre aberturas', async (t) => {
  const { m, caminho } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.finalizarSecao(S77, { status: 'completa', bytes: 10 });
  m.fechar();
  const reaberto = new Manifest(caminho);
  t.after(() => reaberto.fechar());
  assert.equal(reaberto.secao(S77).status, 'completa');
});
