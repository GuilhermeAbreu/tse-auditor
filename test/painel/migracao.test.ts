import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balancoSecao, DEIXARAM, estimarTransferencias, projetarSimplex } from '../../src/painel/migracao.ts';

test('balancoSecao: saldo da seção e faixas de origem de cada ganho', () => {
  const b = balancoSecao(
    { c13: 147, c22: 78, c35: 2, c55: 7, c70: 3, branco: 5, nulo: 11 },
    { c13: 198, c22: 106, branco: 6, nulo: 9 },
    253, 319,
  );
  assert.deepEqual(b.fontes, [{ chave: 'c55', votos: 7 }, { chave: 'c70', votos: 3 }, { chave: 'c35', votos: 2 }, { chave: 'nulo', votos: 2 }]);
  assert.equal(b.liberados, 14);
  assert.equal(b.novos, 66);
  assert.ok(b.fecha);
  assert.deepEqual(b.ganhos, [
    { chave: 'c13', ganho: 51, deNovos: [37, 51], deLiberados: [0, 14] },
    { chave: 'c22', ganho: 28, deNovos: [14, 28], deLiberados: [0, 14] },
    { chave: 'branco', ganho: 1, deNovos: [0, 1], deLiberados: [0, 1] },
  ]);
});

test('balancoSecao: comparecimento menor vira "deixaram de votar"; soma errada é sinalizada', () => {
  const b = balancoSecao({ c1: 50, c2: 40 }, { c1: 45, c2: 40 }, 90, 85);
  assert.deepEqual(b.ganhos, [{ chave: DEIXARAM, ganho: 5, deNovos: [0, 0], deLiberados: [5, 5] }]);
  assert.ok(b.fecha);
  assert.equal(balancoSecao({ c1: 50 }, { c1: 60 }, 50, 55).fecha, false);
});

test('projetarSimplex: resultado não negativo somando 1', () => {
  assert.deepEqual(projetarSimplex([0.2, 0.3, 0.5]), [0.2, 0.3, 0.5]);
  assert.deepEqual(projetarSimplex([2, 0, 0]), [1, 0, 0]);
  const p = projetarSimplex([0.9, 0.8, -1]);
  assert.ok(Math.abs(p[0]! - 0.55) < 1e-12 && Math.abs(p[1]! - 0.45) < 1e-12 && p[2] === 0);
});

test('estimarTransferencias: recupera uma matriz conhecida em dados sintéticos sem ruído', () => {
  const B = [[0.9, 0.05, 0.05], [0.1, 0.8, 0.1], [0.6, 0.3, 0.1], [0, 0.1, 0.9]];
  let semente = 7;
  const aleatorio = () => ((semente = (semente * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const amostras = Array.from({ length: 300 }, () => {
    const bruto = B.map(() => 0.1 + aleatorio());
    const soma = bruto.reduce((a, b) => a + b, 0);
    const x = bruto.map((v) => v / soma);
    const y = [0, 1, 2].map((k) => x.reduce((s, xi, j) => s + xi * B[j]![k]!, 0));
    return { x, y, peso: 100 + Math.floor(aleatorio() * 300) };
  });
  const r = estimarTransferencias(amostras, 4, 3);
  for (let j = 0; j < 4; j++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(r.matriz[j]![k]! - B[j]![k]!) < 0.01, `B[${j}][${k}] = ${r.matriz[j]![k]}`);
  assert.ok(r.rmse < 0.005);
  for (const linha of r.matriz) assert.ok(Math.abs(linha.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});
