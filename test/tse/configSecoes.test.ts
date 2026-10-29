import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerConfigSecoes } from '../../src/tse/configSecoes.ts';
import { lerFixture } from '../helpers/fakeTse.ts';

test('lê municípios, zonas e seções, marcando as agregadas', async () => {
  const json = JSON.parse(String(await lerFixture('oficial/ele2026/arquivo-urna/3220/config/ac/ac-p003220-cs.json')));
  assert.deepEqual(lerConfigSecoes(json), {
    uf: 'ac',
    municipios: [{
      mun: '01066',
      nome: 'PORTO WALTER',
      secoes: [
        { zona: '0004', secao: '0077', principal: null },
        { zona: '0004', secao: '0078', principal: null },
        { zona: '0004', secao: '0079', principal: null },
        { zona: '0004', secao: '0270', principal: '0077' },
      ],
    }],
  });
});

test('recusa config sem "abr"', () => {
  assert.throws(() => lerConfigSecoes({}), /abr/);
});

test('seção com nsp igual à própria não é agregada', () => {
  const r = lerConfigSecoes({ abr: [{ cd: 'ac', mu: [{ cd: '1', nm: 'X', zon: [{ cd: '0001', sec: [{ ns: '0005', nsp: '0005' }] }] }] }] });
  assert.equal(r.municipios[0].secoes[0].principal, null);
});
