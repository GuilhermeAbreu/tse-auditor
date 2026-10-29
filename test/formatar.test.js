import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, linhaDeProgresso } from '../src/formatar.js';

test('fmtBytes', () => {
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(5 * 1024 ** 3), '5.0 GB');
});

test('linhaDeProgresso', () => {
  const e = {
    totais: { secoes: 200, concluidas: 90, erros: 10, semArquivos: 0, bytes: 1024 ** 2 },
    coleta: { velocidadeBps: 2048, ufAtual: 'ac', municipioAtual: '01066 PORTO WALTER' },
  };
  assert.equal(linhaDeProgresso(e), '50.0% | 90/200 seções | 10 erros | 1.0 MB | 2.0 KB/s | AC 01066 PORTO WALTER');
});
