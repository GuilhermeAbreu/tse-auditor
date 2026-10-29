import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodificarBU } from '../../src/extracao/bu.ts';
import { decodificarRDV } from '../../src/extracao/rdv.ts';
import { conferir } from '../../src/extracao/extrator.ts';
import { arquivoUrna } from './fixtures.ts';

for (const pleito of [3220, 3221]) {
  test(`RDV real ${pleito} bate com o BU`, () => {
    const rdv = decodificarRDV(arquivoUrna(pleito, 'rdv'));
    const bu = decodificarBU(arquivoUrna(pleito, 'bu'));
    assert.equal(rdv.secao, 77);
    assert.equal(rdv.resultados.length, bu.resultados.length);
    assert.deepEqual(conferir(bu, null, rdv), []);
  });
}

test('conferir aponta divergência BU × RDV', () => {
  const bu = decodificarBU(arquivoUrna(3221, 'bu'));
  const rdv = decodificarRDV(arquivoUrna(3221, 'rdv'));
  rdv.resultados[0].votos[0].quantidade++;
  assert.match(conferir(bu, null, rdv).join(), /bu!=rdv/);
});
