import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { VolumeError, bytesLivres, ehErroDeVolume, garantirVolume } from '../../src/storage/disco.js';

test('garantirVolume aceita pasta existente e recusa a ausente com mensagem clara', async () => {
  await garantirVolume(os.tmpdir());
  await assert.rejects(garantirVolume(path.join(os.tmpdir(), 'nao-existe-tse')), (err) => {
    assert.ok(err instanceof VolumeError);
    assert.match(err.message, /HD está conectado/);
    return true;
  });
});

test('bytesLivres devolve um número positivo', async () => {
  assert.ok((await bytesLivres(os.tmpdir())) > 0);
});

test('ehErroDeVolume reconhece erros de dispositivo', () => {
  assert.ok(ehErroDeVolume(new VolumeError('x')));
  assert.ok(ehErroDeVolume(Object.assign(new Error('x'), { code: 'EIO' })));
  assert.ok(ehErroDeVolume(Object.assign(new Error('x'), { code: 'ENOTCONN' })));
  assert.ok(!ehErroDeVolume(Object.assign(new Error('x'), { code: 'ENOENT' })));
  assert.ok(!ehErroDeVolume(new Error('x')));
});
