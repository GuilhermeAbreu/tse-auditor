import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Manifest } from '../../src/storage/manifest.ts';

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

async function novoManifest(t: TestContext, opcoes?: ConstructorParameters<typeof Manifest>[1]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-manifest-'));
  const caminho = path.join(dir, 'manifest.sqlite');
  const m = new Manifest(caminho, opcoes);
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
  assert.equal(agregada!.status, 'agregada');
  assert.equal(agregada!.principal, '0077');
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
  assert.equal(m.secao(S77)!.status, 'completa');

  m.finalizarSecao(S77, { status: 'erro', erro: 'a-bu.dat: falhou' });
  assert.deepEqual(m.secoesPendentes('3220', 'ac', '01066'), [S77], 'seção com erro volta para a fila');
  assert.deepEqual(m.errosRecentes(5).map((e) => [e.secao, e.erro]), [['0077', 'a-bu.dat: falhou']]);
});

test('municípios empacotados', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  assert.equal(m.municipio('3220', 'ac', '01066')!.empacotado_em, null);
  assert.equal(m.municipio('3221', 'ac', '01066'), undefined);
  m.marcarEmpacotado('3220', 'ac', '01066', 1234);
  const mun = m.municipio('3220', 'ac', '01066');
  assert.equal(mun!.zip_bytes, 1234);
  assert.ok(mun!.empacotado_em);
});

test('resumo por UF e eventos', async (t) => {
  const { m } = await novoManifest(t, { cacheResumoMs: 0 });
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
  assert.equal(reaberto.secao(S77)!.status, 'completa');
});

const contar = (m: Manifest, status: string) => (m.db.prepare('SELECT COUNT(*) AS n FROM arquivos WHERE status = ?').get(status) as { n: number }).n;

test('escritas só ficam visíveis para outra conexão após descarregar', async (t) => {
  const { m, caminho } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.registrarIndice(S77, CONJUNTOS, (hash, nome) => `http://x/${hash}/${nome}`);
  m.descarregar();
  m.marcarArquivo(S77, 'h1', 'a-bu.dat', { status: 'ok', bytes: 10 });
  assert.equal(m.arquivosDaSecao(S77)[0].status, 'ok', 'a própria conexão enxerga');
  const outra = new Database(caminho, { readonly: true, timeout: 0 });
  t.after(() => outra.close());
  const lerOutra = () => {
    try {
      return (outra.prepare("SELECT COUNT(*) AS n FROM arquivos WHERE status = 'ok'").get() as { n: number }).n;
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_BUSY') return 0;
      throw err;
    }
  };
  assert.equal(lerOutra(), 0);
  m.descarregar();
  assert.equal(lerOutra(), 1);
});

test('commit com falha faz rollback e deixa erro persistente só para escritas', async (t) => {
  const { m } = await novoManifest(t, { intervaloCommitMs: 10 });
  m.registrarUfs(['ac']);
  const exec = m.db.exec.bind(m.db);
  let falhou = false;
  m.db.exec = (sql) => {
    if (sql === 'COMMIT' && !falhou) {
      falhou = true;
      throw new Error('HD desconectado');
    }
    return exec(sql);
  };
  await new Promise((ok) => setTimeout(ok, 60));
  assert.equal(m.db.inTransaction, false);
  assert.equal(m.ufs().length, 0, 'leituras continuam funcionando');
  for (let i = 0; i < 2; i++) {
    assert.throws(() => m.registrarEvento('erro', 'ac', 'x'), /HD desconectado/);
    assert.throws(() => m.marcarArquivo(S77, 'h1', 'a', { status: 'ok' }), /HD desconectado/);
  }
  assert.match(m.erro!.message, /HD desconectado/);
  m.fechar();
});

test('fechar grava a fila pendente', async (t) => {
  const { m, caminho } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.finalizarSecao(S77, { status: 'completa', bytes: 7 });
  m.fechar();
  const reaberto = new Manifest(caminho);
  t.after(() => reaberto.fechar());
  assert.equal(reaberto.secao(S77)!.bytes, 7);
});

test('reabrirMunicipio devolve seções e arquivos à fila e limpa o empacotamento', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.registrarIndice(S77, CONJUNTOS, (hash, nome) => `http://x/${hash}/${nome}`);
  m.marcarArquivo(S77, 'h1', 'a-bu.dat', { status: 'ok', bytes: 10 });
  m.finalizarSecao(S77, { status: 'completa', bytes: 10 });
  m.marcarEmpacotado('3220', 'ac', '01066', 99);
  m.reabrirMunicipio('3220', 'ac', '01066');
  assert.equal(m.secao(S77)!.status, 'pendente');
  assert.equal(m.secao(S77)!.bytes, 0);
  assert.equal(m.secao({ ...S77, secao: '0270' })!.status, 'agregada');
  assert.equal(contar(m, 'ok'), 0);
  const mun = m.municipio('3220', 'ac', '01066');
  assert.equal(mun!.empacotado_em, null);
  assert.equal(mun!.zip_bytes, null);
});

test('abrir corrige seções antigas em erro só por imgbu com HTTP 404 (idempotente)', async (t) => {
  const { m, caminho } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', [{ mun: '01066', nome: 'P', secoes: [
    { zona: '0004', secao: '0077', principal: null }, { zona: '0004', secao: '0078', principal: null },
  ] }]);
  const urlDe = (h: string, n: string) => `http://x/${h}/${n}`;
  const conj = [{ hash: 'h1', status: null, data: null, hora: null, arquivos: [{ nome: 'a-bu.dat', tipo: 'bu' }, { nome: 'a-imgbu.dat', tipo: 'imgbu' }] }];
  const s78 = { ...S77, secao: '0078' };
  for (const s of [S77, s78]) m.registrarIndice(s, conj, urlDe);
  m.marcarArquivo(S77, 'h1', 'a-bu.dat', { status: 'ok', bytes: 10 });
  m.marcarArquivo(S77, 'h1', 'a-imgbu.dat', { status: 'erro', erro: 'HTTP 404' });
  m.finalizarSecao(S77, { status: 'erro', bytes: 10, erro: 'a-imgbu.dat: HTTP 404' });
  m.marcarArquivo(s78, 'h1', 'a-bu.dat', { status: 'erro', erro: 'HTTP 404' });
  m.marcarArquivo(s78, 'h1', 'a-imgbu.dat', { status: 'erro', erro: 'HTTP 404' });
  m.finalizarSecao(s78, { status: 'erro', erro: 'a-bu.dat: HTTP 404' });
  m.fechar();

  for (let i = 0; i < 2; i++) {
    const m2 = new Manifest(caminho);
    t.after(() => m2.fechar());
    assert.deepEqual(
      [m2.secao(S77)!.status, m2.secao(S77)!.bytes, m2.secao(S77)!.erro],
      ['completa', 10, null],
    );
    assert.equal(m2.arquivo(S77, 'h1', 'a-imgbu.dat')!.status, 'indisponivel');
    assert.equal(m2.secao(s78)!.status, 'erro', 'falta de bu continua erro');
    assert.equal(m2.arquivo(s78, 'h1', 'a-imgbu.dat')!.status, 'erro');
    assert.deepEqual(m2.indisponiveisPorUf(), [{ uf: 'ac', n: 1 }]);
    m2.fechar();
  }
});
