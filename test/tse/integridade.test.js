import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5, md5DoEtag, sha512Hex, vscConfereComDiretorio, vscContemSha512 } from '../../src/tse/integridade.js';
import { FX, lerFixture } from '../helpers/fakeTse.js';

const arquivo = (pleito, hash, sufixo) => lerFixture(`${FX.dirSecao(pleito)}/${hash}/o0${pleito}ac0106600040077-${sufixo}`);

test('sha256 do .vsc confere com o hash do diretório, nos dois turnos', async () => {
  const vsc1 = await arquivo('3220', FX.hash3220, 'vota.vsc');
  const vsc2 = await arquivo('3221', FX.hash3221, 'vota.vsc');
  assert.ok(vscConfereComDiretorio(vsc1, FX.hash3220));
  assert.ok(vscConfereComDiretorio(vsc2, FX.hash3221));
  assert.ok(!vscConfereComDiretorio(vsc1, FX.hash3221));
  assert.ok(!vscConfereComDiretorio(vsc1, 'zz'));
});

test('o .vsc contém o sha512 de bu, rdv e log', async () => {
  const vsc = await arquivo('3220', FX.hash3220, 'vota.vsc');
  for (const sufixo of ['bu.dat', 'rdv.dat', 'log.jez']) {
    assert.ok(vscContemSha512(vsc, await arquivo('3220', FX.hash3220, sufixo)), sufixo);
  }
  const adulterado = Buffer.from(await arquivo('3220', FX.hash3220, 'bu.dat'));
  adulterado[10] ^= 1;
  assert.ok(!vscContemSha512(vsc, adulterado));
});

test('md5 e sha512', async () => {
  const bu = await arquivo('3220', FX.hash3220, 'bu.dat');
  assert.equal(md5(bu), '09216d24b6af4b16590337b73d83c408');
  assert.equal(sha512Hex(Buffer.from('')).slice(0, 16), 'cf83e1357eefb8bd');
});

test('md5DoEtag aceita ETag simples e ignora multipart', () => {
  assert.equal(md5DoEtag('"09216d24b6af4b16590337b73d83c408"'), '09216d24b6af4b16590337b73d83c408');
  assert.equal(md5DoEtag('W/"09216D24B6AF4B16590337B73D83C408"'), '09216d24b6af4b16590337b73d83c408');
  assert.equal(md5DoEtag('"09216d24b6af4b16590337b73d83c408-3"'), null);
  assert.equal(md5DoEtag(null), null);
});
