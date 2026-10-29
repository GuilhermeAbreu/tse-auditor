import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { iniciarFakeTse, lerFixture } from './fakeTse.ts';

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const ELE_C = 'oficial/comum/config/ele-c.json';

test('serve fixtures com ETag MD5 e 404 para o resto', async (t) => {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const r = await fetch(`${fake.base}/${ELE_C}`);
  const corpo = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(corpo, await lerFixture(ELE_C));
  assert.equal(r.headers.get('etag'), `"${md5(corpo)}"`);
  assert.equal((await fetch(`${fake.base}/oficial/nada.json`)).status, 404);
  assert.deepEqual(fake.requisicoes, [`/${ELE_C}`, '/oficial/nada.json']);
});

test('injeta falhas em ordem', async (t) => {
  const fake = await iniciarFakeTse({ falhas: { 'ele-c.json': [503, 'corromper', 'corromperComEtag'] } });
  t.after(fake.fechar);
  const original = await lerFixture(ELE_C);
  assert.equal((await fetch(`${fake.base}/${ELE_C}`)).status, 503);

  const corrompido = await fetch(`${fake.base}/${ELE_C}`);
  const c1 = Buffer.from(await corrompido.arrayBuffer());
  assert.notDeepEqual(c1, original);
  assert.equal(corrompido.headers.get('etag'), `"${md5(original)}"`);

  const trocado = await fetch(`${fake.base}/${ELE_C}`);
  const c2 = Buffer.from(await trocado.arrayBuffer());
  assert.equal(trocado.headers.get('etag'), `"${md5(c2)}"`);

  assert.deepEqual(Buffer.from(await (await fetch(`${fake.base}/${ELE_C}`)).arrayBuffer()), original);
});
