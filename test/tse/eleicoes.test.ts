import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerEleicoes, buscarEleicoes } from '../../src/tse/eleicoes.ts';
import { HttpClient } from '../../src/net/http.ts';
import { iniciarFakeTse, lerFixture } from '../helpers/fakeTse.ts';

test('lerEleicoes extrai templates, pleitos, turnos e cargos', async () => {
  const { templates, pleitos } = lerEleicoes(JSON.parse(await lerFixture('oficial/comum/config/ele-c.json')));
  assert.equal(templates.cs, '<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/config/<uf>');
  assert.equal(templates.aux, '<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/dados/<uf>/<municipio>/<zona>/<secao>');

  const p1 = pleitos.find((p) => p.cd === '3220');
  assert.equal(p1.ciclo, 'ele2026');
  assert.equal(p1.data, '04/10/2026');
  const presidente1 = p1.eleicoes.find((e) => e.cd === '6257');
  assert.equal(presidente1.turno, 1);
  assert.deepEqual(presidente1.cargos, [{ cd: '1', nome: 'Presidente' }]);

  const presidente2 = pleitos.find((p) => p.cd === '3221').eleicoes.find((e) => e.cd === '6258');
  assert.equal(presidente2.turno, 2);
});

test('lerEleicoes recusa ele-c.json sem os diretórios de arquivo de urna', () => {
  assert.throws(() => lerEleicoes({ arq: [], pl: [] }), /"cs"/);
});

test('buscarEleicoes baixa o ele-c.json do servidor', async (t) => {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const { pleitos } = await buscarEleicoes(new HttpClient(), { base: fake.base, ambiente: 'oficial' });
  assert.ok(pleitos.some((p) => p.cd === '3221'));
});
