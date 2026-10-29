import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anoDoCiclo, pastaDados } from '../src/config.ts';

test('pasta de dados por ano dentro do HD', () => {
  assert.equal(anoDoCiclo('ele2026'), '2026');
  assert.equal(pastaDados('/media/guilherme/Novo volume', 'ele2026'), '/media/guilherme/Novo volume/tse2026');
  assert.throws(() => anoDoCiclo('xyz'), /ciclo inesperado/);
});
