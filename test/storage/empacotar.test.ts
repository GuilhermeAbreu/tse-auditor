import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ZipCorrompidoError, ehErroDeFormatoZip, empacotarMunicipio } from '../../src/storage/empacotar.ts';
import { lerZip } from '../helpers/zip.ts';

async function preparar(arquivos) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-zip-'));
  const pastaStaging = path.join(dir, 'staging');
  await gravar(pastaStaging, arquivos);
  return { pastaStaging, caminhoZip: path.join(dir, 'raw', 'AC', '3220', '01066.zip') };
}

async function gravar(pasta, arquivos) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    await mkdir(path.dirname(path.join(pasta, nome)), { recursive: true });
    await writeFile(path.join(pasta, nome), conteudo);
  }
}

const texto = (zip) => Object.fromEntries([...zip].map(([nome, e]) => [nome, e.dados.toString()]));

test('empacota sem compressão, ignora .part e apaga o staging', async () => {
  const { pastaStaging, caminhoZip } = await preparar({
    '0004/0077/h1/a-bu.dat': 'conteúdo do bu',
    '0004/0077/p-aux.json': '{"st":"ok"}',
    '0004/0077/h1/b.dat.part': 'incompleto',
  });
  const r = await empacotarMunicipio({ pastaStaging, caminhoZip });
  assert.equal(r.entradas, 2);
  assert.ok(r.bytes > 0);
  const zip = await lerZip(caminhoZip);
  assert.deepEqual(texto(zip), { '0004/0077/h1/a-bu.dat': 'conteúdo do bu', '0004/0077/p-aux.json': '{"st":"ok"}' });
  for (const e of zip.values()) assert.equal(e.metodo, 0, 'método 0 = sem compressão');
  await assert.rejects(access(pastaStaging));
  await assert.rejects(access(`${caminhoZip}.part`));
});

test('reempacotar mescla com o zip existente e substitui o que veio de novo', async () => {
  const { pastaStaging, caminhoZip } = await preparar({ a: '1', b: '2' });
  await empacotarMunicipio({ pastaStaging, caminhoZip });
  await gravar(pastaStaging, { b: 'novo', 'x/c': '3' });
  const r = await empacotarMunicipio({ pastaStaging, caminhoZip });
  assert.equal(r.entradas, 3);
  assert.deepEqual(texto(await lerZip(caminhoZip)), { a: '1', b: 'novo', 'x/c': '3' });
});

test('sem staging e sem zip gera zip vazio', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-zip-'));
  const caminhoZip = path.join(dir, 'vazio.zip');
  const r = await empacotarMunicipio({ pastaStaging: path.join(dir, 'nada'), caminhoZip });
  assert.equal(r.entradas, 0);
  assert.equal((await lerZip(caminhoZip)).size, 0);
});

test('zip existente corrompido é separado, o staging é preservado e o erro é claro', async () => {
  const { pastaStaging, caminhoZip } = await preparar({ a: '1' });
  await mkdir(path.dirname(caminhoZip), { recursive: true });
  await writeFile(caminhoZip, 'lixo que não é zip');
  await assert.rejects(empacotarMunicipio({ pastaStaging, caminhoZip }), (err) => {
    assert.ok(err instanceof ZipCorrompidoError);
    assert.equal(err.caminhoZip, caminhoZip);
    return true;
  });
  const nomes = await readdir(path.dirname(caminhoZip));
  assert.equal(nomes.length, 1);
  assert.match(nomes[0], /^01066\.zip\.corrompido-\d+$/);
  await access(path.join(pastaStaging, 'a'));
});

test('recusa empacotar sem espaço livre e não deixa .part', async () => {
  const { pastaStaging, caminhoZip } = await preparar({ a: '1' });
  await assert.rejects(
    empacotarMunicipio({ pastaStaging, caminhoZip, bytesLivres: async () => 0 }),
    /espaço insuficiente para empacotar/,
  );
  await access(path.join(pastaStaging, 'a'));
  await assert.rejects(access(`${caminhoZip}.part`));
});

test('ehErroDeFormatoZip separa erro de formato de erro de sistema', () => {
  assert.ok(ehErroDeFormatoZip(new Error('end of central directory record signature not found')));
  assert.ok(!ehErroDeFormatoZip(Object.assign(new Error('x'), { code: 'EIO' })));
  assert.ok(!ehErroDeFormatoZip(Object.assign(new Error('x'), { code: 'EMFILE' })));
});
