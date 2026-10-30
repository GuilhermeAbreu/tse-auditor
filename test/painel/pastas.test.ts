import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { criarPasta, listarPastas, PastaInvalida } from '../../src/painel/pastas.ts';

async function arvore() {
  const raiz = await mkdtemp(path.join(os.tmpdir(), 'tse-pastas-'));
  for (const p of ['b', 'A', 'pasta 10', 'pasta 9', '.oculta']) await mkdir(path.join(raiz, p));
  await writeFile(path.join(raiz, 'arquivo.txt'), 'x');
  return raiz;
}

test('listarPastas: só subpastas visíveis, em ordem natural, com pai e espaço livre', async () => {
  const raiz = await arvore();
  const l = await listarPastas(`${raiz}/`);
  assert.equal(l.caminho, raiz);
  assert.equal(l.pai, path.dirname(raiz));
  assert.deepEqual(l.pastas, ['A', 'b', 'pasta 9', 'pasta 10']);
  assert.equal(l.truncado, false);
  assert.equal(l.gravavel, true);
  assert.ok(typeof l.livreBytes === 'number' && l.livreBytes > 0);
  assert.equal(l.atalhos[0]?.caminho, os.homedir());
  assert.equal((await listarPastas('/')).pai, null);
});

test('listarPastas: recusa caminho relativo e pasta inexistente', async () => {
  await assert.rejects(listarPastas('relativo/x'), PastaInvalida);
  await assert.rejects(listarPastas(path.join(await arvore(), 'nao-existe')), PastaInvalida);
});

test('criarPasta: cria um único nível e recusa nomes perigosos ou repetidos', async () => {
  const raiz = await arvore();
  assert.equal(await criarPasta(raiz, ' tse '), path.join(raiz, 'tse'));
  assert.ok((await listarPastas(raiz)).pastas.includes('tse'));
  for (const nome of ['', '.', '..', 'a/b', 'a\\b', 'x'.repeat(121)]) await assert.rejects(criarPasta(raiz, nome), PastaInvalida, JSON.stringify(nome));
  await assert.rejects(criarPasta(raiz, 'tse'), /já existe/);
  await assert.rejects(criarPasta(path.join(raiz, 'nao-existe'), 'y'), PastaInvalida);
});
