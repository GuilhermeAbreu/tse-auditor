import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raiz, filhos, inteiro, texto, CONTEXTO } from '../../src/extracao/ber.js';

test('lê SEQUENCE com INTEGER, string, tag de contexto e comprimento longo', () => {
  const longa = Buffer.alloc(200, 0x41);
  const buf = Buffer.concat([
    Buffer.from([0x30, 0x81, 3 + 4 + 3 + 203]),
    Buffer.from([0x02, 0x01, 0xff]), // -1
    Buffer.from([0x02, 0x02, 0x01, 0x21]), // 289
    Buffer.from([0x81, 0x01, 0x05]), // [1] 5
    Buffer.from([0x1b, 0x81, 200]), longa,
  ]);
  const [a, b, c, d] = filhos(raiz(buf));
  assert.equal(inteiro(a), -1);
  assert.equal(inteiro(b), 289);
  assert.equal(c.classe, CONTEXTO);
  assert.equal(inteiro(c), 5);
  assert.equal(texto(d).length, 200);
});

test('falha com comprimento além do fim', () => {
  assert.throws(() => raiz(Buffer.from([0x04, 0x05, 0x00])), /passa do fim/);
});
