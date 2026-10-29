import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerLogJez, parsearLog, resumirLog, tipoEvento } from '../../src/extracao/log.js';
import { decodificarBU } from '../../src/extracao/bu.js';
import { conferir } from '../../src/extracao/extrator.js';
import { arquivoUrna } from './fixtures.js';

test('classifica mensagens de voto', () => {
  assert.equal(tipoEvento('O voto do eleitor foi computado'), 'voto_computado');
  assert.equal(tipoEvento('Mesário 2 habilitou o eleitor'), 'hab_mesario');
  assert.equal(tipoEvento('Tipo de habilitação do eleitor [biométrica]'), 'hab_biometrica');
  assert.equal(tipoEvento('Voto confirmado para [Senador]'), 'voto_cargo');
  assert.equal(tipoEvento('Tecla indevida pressionada'), null);
});

test('log real do 1º turno: resumo do dia fecha com o BU', async () => {
  const { eventos, linhasInvalidas } = parsearLog(await lerLogJez(arquivoUrna(3220, 'log')));
  assert.equal(linhasInvalidas, 0);
  assert.deepEqual(eventos[0], {
    ts: '2026-09-23T13:31:48', nivel: 'INFO', urna: '02293919', modulo: 'LOGD', mensagem: 'Início das operações do logd', hash: 'EDECD0F5199A2185',
  });
  const r = resumirLog(eventos, '2026-10-04');
  assert.equal(r.logVotosComputados, 234);
  assert.deepEqual([r.logHabAnoNascimento, r.logHabBiometrica, r.logHabMesario], [9, 212, 13]);
  assert.equal(r.logPrimeiroVoto, '2026-10-04T06:09:09');
  assert.deepEqual(conferir(decodificarBU(arquivoUrna(3220, 'bu')), r, null), []);
});

test('log do 2º turno usa o dia informado, não o de mais votos', async () => {
  const { eventos } = parsearLog(await lerLogJez(arquivoUrna(3221, 'log')));
  const r = resumirLog(eventos, '2026-10-25');
  assert.equal(r.logVotosComputados, 194);
  assert.deepEqual(conferir(decodificarBU(arquivoUrna(3221, 'bu')), r, null), []);
});

test('conferir aponta habilitações divergentes', () => {
  const bu = { comparecimento: 10, qtdHabilitacaoAnoNascimento: 1, qtdHabilitacaoBiometrica: 8, qtdHabilitacaoMesario: 1, resultados: [] };
  const log = { logDia: 'x', logVotosComputados: 10, logHabAnoNascimento: 1, logHabBiometrica: 7, logHabMesario: 2 };
  assert.deepEqual(conferir(bu, log, null), ['qtdHabilitacaoBiometrica(8)!=logHabBiometrica(7)', 'qtdHabilitacaoMesario(1)!=logHabMesario(2)']);
});
