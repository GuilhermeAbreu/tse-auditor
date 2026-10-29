import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerIndiceSecao } from '../../src/tse/indiceSecao.js';
import { FX, lerFixture } from '../helpers/fakeTse.js';

test('lê o índice real de 2026', async () => {
  const json = JSON.parse(await lerFixture(`${FX.dirSecao('3220')}/p003220-ac-m01066-z0004-s0077-aux.json`));
  const indice = lerIndiceSecao(json);
  assert.equal(indice.status, 'Totalizada');
  assert.equal(indice.conjuntos.length, 1);
  const [c] = indice.conjuntos;
  assert.equal(c.hash, FX.hash3220);
  assert.equal(c.status, 'Totalizado');
  assert.equal(c.data, '04/10/2026');
  assert.equal(c.hora, '18:34:08');
  assert.deepEqual(c.arquivos.map((a) => a.tipo).sort(), ['bu', 'log', 'rdv', 'vota']);
  assert.ok(c.arquivos.some((a) => a.nome === 'o03220ac0106600040077-bu.dat'));
});

test('seção sem arquivos', () => {
  assert.deepEqual(lerIndiceSecao({ st: 'Não instalada', hashes: [] }), { status: 'Não instalada', conjuntos: [] });
});

test('formato de 2022 (nmarq) usa a extensão como tipo', () => {
  const indice = lerIndiceSecao({
    st: 'Totalizada',
    hashes: [{ hash: 'ab', st: 'Totalizado', dr: '02/10/2022', hr: '17:00:00', nmarq: ['o00406-0100100010001.bu', 'o00406-0100100010001.logjez'] }],
  });
  assert.deepEqual(indice.conjuntos[0].arquivos, [
    { nome: 'o00406-0100100010001.bu', tipo: 'bu' },
    { nome: 'o00406-0100100010001.logjez', tipo: 'logjez' },
  ]);
});
