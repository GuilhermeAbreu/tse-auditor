import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodificarBU } from '../../src/extracao/bu.ts';
import { arquivoUrna } from './fixtures.ts';

test('BU real do 1º turno (AC 01066/0004/0077)', () => {
  const bu = decodificarBU(arquivoUrna(3220, 'bu'));
  assert.equal(bu.pleito, 3220);
  assert.deepEqual([bu.municipio, bu.zona, bu.local, bu.secao], [1066, 4, 1031, 77]);
  assert.equal(bu.tipoUrna, 'secao');
  assert.equal(bu.dataHoraAbertura, '2026-10-04 06:06:52');
  assert.equal(bu.dataHoraEncerramento, '2026-10-04 15:40:41');
  assert.equal(bu.comparecimento, 234);
  assert.deepEqual([bu.qtdHabilitacaoAnoNascimento, bu.qtdHabilitacaoBiometrica, bu.qtdHabilitacaoMesario], [9, 212, 13]);
  const pres = bu.resultados.find((r) => r.cargo === 'Presidente');
  assert.equal(pres.aptos, 289);
  assert.equal(pres.votos.reduce((s, v) => s + v.quantidade, 0), 234);
  assert.deepEqual(pres.votos.find((v) => v.tipo === 'nulo').quantidade, 13);
  const sen = bu.resultados.find((r) => r.cargo === 'Senador');
  assert.equal(sen.votos.reduce((s, v) => s + v.quantidade, 0), 468); // 2 vagas
  assert.equal(bu.resultados.length, 5);
});

test('BU real do 2º turno', () => {
  const bu = decodificarBU(arquivoUrna(3221, 'bu'));
  assert.equal(bu.comparecimento, 194);
  assert.deepEqual(bu.resultados.map((r) => r.cargo), ['Presidente', 'Governador']);
});
