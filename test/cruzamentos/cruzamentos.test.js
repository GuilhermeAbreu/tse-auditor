import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { prepararContexto } from '../../src/cruzamentos/comum.js';
import * as limites from '../../src/cruzamentos/limites.js';
import * as turnos from '../../src/cruzamentos/turnos.js';
import * as mesario from '../../src/cruzamentos/mesario.js';
import * as horarios from '../../src/cruzamentos/horarios.js';
import { rodarCruzamentos, resumir } from '../../src/cruzamentos/index.js';

const SECOES = `CREATE TABLE secoes (pleito INTEGER, uf VARCHAR, mun VARCHAR, zona VARCHAR, secao VARCHAR, status VARCHAR,
  local INTEGER, aptos INTEGER, comparecimento INTEGER, abstencao INTEGER, qtdHabilitacaoAnoNascimento INTEGER,
  qtdHabilitacaoBiometrica INTEGER, qtdHabilitacaoMesario INTEGER, tipoUrna VARCHAR, abertura TIMESTAMP, secoesAgregadas VARCHAR,
  substituida BOOLEAN, logDia VARCHAR, logTentativasDigital INTEGER, logUltimoVoto TIMESTAMP, logUrnas VARCHAR, inconsistencias VARCHAR)`;
const VOTOS = `CREATE TABLE votos (pleito INTEGER, uf VARCHAR, mun VARCHAR, zona VARCHAR, secao VARCHAR, origem VARCHAR,
  eleicao INTEGER, codigoCargo INTEGER, cargo VARCHAR, tipo VARCHAR, numero INTEGER, quantidade INTEGER)`;
const EVENTOS = `CREATE TABLE eventos_log (pleito INTEGER, uf VARCHAR, mun VARCHAR, zona VARCHAR, secao VARCHAR, ts TIMESTAMP,
  modulo VARCHAR, tipo VARCHAR, mensagem VARCHAR, ordem BIGINT)`;

// seção i da zona 0001, local 1; comparecimento 100, mesário m, abstenção a. Horários locais com UF 'XX' (= Brasília).
function secao(pleito, i, { aptos = 120, comp = 100, mes = 5, abst = 20, ano = 2 } = {}) {
  const s = String(i).padStart(4, '0');
  const dia = pleito === 3220 ? '2026-10-04' : '2026-10-25';
  return `(${pleito}, 'XX', '00001', '0001', '${s}', 'ok', 1, ${aptos}, ${comp}, ${abst}, ${ano}, ${comp - mes - ano}, ${mes},
    'secao', '${dia} 07:30:00', NULL, false, '${dia}', ${comp}, '${dia} 16:30:00', '1', NULL)`;
}

async function banco({ secoes, votos = [], eventos = [] }) {
  const db = await (await DuckDBInstance.create(':memory:')).connect();
  await db.run(SECOES);
  await db.run(VOTOS);
  await db.run(EVENTOS);
  await db.run(`INSERT INTO secoes VALUES ${secoes.join(',')}`);
  if (votos.length) await db.run(`INSERT INTO votos VALUES ${votos.join(',')}`);
  if (eventos.length) await db.run(`INSERT INTO eventos_log VALUES ${eventos.join(',')}`);
  await prepararContexto(db, { uf: 'xx' });
  return db;
}

const voto = (pleito, s, cargo, tipo, numero, q) =>
  `(${pleito}, 'XX', '00001', '0001', '${String(s).padStart(4, '0')}', 'BU', 1, ${cargo}, 'c${cargo}', '${tipo}', ${numero}, ${q})`;

test('limites: comparecimento acima dos aptos e votos acima do comparecimento', async () => {
  const votos = [];
  for (let i = 1; i <= 3; i++) votos.push(voto(3220, i, 5, 'nominal', 11, i === 3 ? 201 : 200)); // senador: 2 votos por eleitor
  const db = await banco({ secoes: [secao(3220, 1, { aptos: 90 }), secao(3220, 2), secao(3220, 3)], votos });
  const r = await limites.executar(db, { uf: 'xx' });
  assert.deepEqual(r.map((x) => [x.secao, x.sinal, x.pontuacao]), [
    ['0001', 'COMPARECIMENTO_ACIMA_APTOS', 100], ['0003', 'VOTOS_ACIMA_COMPARECIMENTO', 100]]);
  assert.equal(JSON.parse(r[1].detalhe).votosPorEleitor, 2);
  assert.ok(!JSON.stringify(r).toLowerCase().includes('fraude'));
});

test('turnos: ganho acima do disponível e variação atípica na zona', async () => {
  const secoes = [];
  const votos = [];
  for (let i = 1; i <= 8; i++) {
    secoes.push(secao(3220, i), secao(3221, i));
    // 1º turno: 13=40, 22=40, 99 (eliminado)=10, branco/nulo=10. 2º turno: 13=50, 22=50 (normal).
    votos.push(voto(3220, i, 1, 'nominal', 13, 40), voto(3220, i, 1, 'nominal', 22, 40), voto(3220, i, 1, 'nominal', 99, 10),
      voto(3220, i, 1, 'branco', 0, 10));
    if (i === 8) votos.push(voto(3221, i, 1, 'nominal', 13, 95), voto(3221, i, 1, 'nominal', 22, 5));
    else if (i === 7) votos.push(voto(3221, i, 1, 'nominal', 13, 80), voto(3221, i, 1, 'nominal', 22, 40)); // 120 > comparecimento
    else votos.push(voto(3221, i, 1, 'nominal', 13, 50 + (i % 3)), voto(3221, i, 1, 'nominal', 22, 50 - (i % 3)));
  }
  const db = await banco({ secoes, votos });
  const r = await turnos.executar(db, { uf: 'xx' });
  const ganho = r.filter((x) => x.sinal === 'GANHO_ACIMA_DISPONIVEL');
  assert.deepEqual(ganho.map((x) => [x.secao, JSON.parse(x.detalhe).candidato, x.valor, x.referencia]), [['0007', 13, 40, 20]]);
  const variacao = r.filter((x) => x.sinal === 'VARIACAO_ATIPICA_ZONA').map((x) => x.secao);
  assert.ok(variacao.includes('0008'));
  assert.ok(!variacao.includes('0001'));
});

test('mesario: taxa acima do local/zona/outro turno e abstenção caiu com mesário subindo', async () => {
  const secoes = [];
  for (let i = 1; i <= 12; i++) {
    secoes.push(secao(3220, i, { mes: 4 + (i % 3) }));
    secoes.push(secao(3221, i, i === 1 ? { mes: 30, abst: 2, comp: 118 } : { mes: 4 + (i % 3) }));
  }
  const db = await banco({ secoes });
  const r = await mesario.executar(db, { uf: 'xx' });
  const sinais = new Set(r.filter((x) => x.secao === '0001' && x.pleito === 3221).map((x) => x.sinal));
  for (const s of ['MESARIO_ACIMA_LOCAL', 'MESARIO_ACIMA_ZONA', 'MESARIO_SUBIU_OUTRO_TURNO', 'ABSTENCAO_CAIU_MESARIO_SUBIU']) {
    assert.ok(sinais.has(s), s);
  }
  assert.ok(r.every((x) => x.secao === '0001' && x.pontuacao >= 30 && x.pontuacao <= 100));
});

test('mesario: liberações manuais concentradas na última hora', async () => {
  const eventos = [];
  let ordem = 0;
  const ev = (h, m, tipo) => eventos.push(`(3220, 'XX', '00001', '0001', '0001', '2026-10-04 ${h}:${m}:00', 'VOTA', ${tipo ? `'${tipo}'` : 'NULL'}, 'x', ${ordem++})`);
  for (let k = 0; k < 90; k++) { // 8h–15h: biometria
    const h = String(8 + Math.floor(k / 12)).padStart(2, '0');
    const m = String((k % 12) * 5).padStart(2, '0');
    ev(h, m, 'hab_biometrica'); ev(h, m, 'voto_computado');
  }
  for (let k = 0; k < 10; k++) { ev('16', String(k * 5).padStart(2, '0'), 'hab_mesario'); ev('16', String(k * 5).padStart(2, '0'), 'voto_computado'); }
  const db = await banco({ secoes: [secao(3220, 1, { mes: 10, ano: 0 })], eventos });
  const r = (await mesario.executar(db, { uf: 'xx' })).filter((x) => x.sinal === 'MESARIO_ULTIMA_HORA');
  assert.equal(r.length, 1);
  assert.equal(JSON.parse(r[0].detalhe).mesarioUltimaHora, 10);
});

test('horarios: voto antes da abertura, voto após pausa depois das 17h e teste no meio da votação', async () => {
  const eventos = [];
  let ordem = 0;
  const ev = (s, ts, tipo, msg = 'x', pleito = 3220) => eventos.push(
    `(${pleito}, 'XX', '00001', '0001', '${s}', '2026-10-04 ${ts}', 'VOTA', ${tipo ? `'${tipo}'` : 'NULL'}, '${msg}', ${ordem++})`);
  // 0001: votos contínuos até 17h20 (fila) -> sem sinal
  for (const t of ['08:10:00', '12:00:00', '16:55:00', '17:10:00', '17:20:00']) ev('0001', t, 'voto_computado');
  // 0002: voto às 07:10 e votos às 17:50 após pausa desde 16:40
  for (const t of ['07:10:00', '09:00:00', '16:40:00', '17:50:00', '17:51:00']) ev('0002', t, 'voto_computado');
  // 0003: modo de carga de treinamento no meio da votação
  ev('0003', '09:00:00', 'voto_computado'); ev('0003', '10:00:00', null, 'Fase da UE: Simulado'); ev('0003', '11:00:00', 'voto_computado');
  ev('0003', '10:30:00', null, 'Início do teste de Teclado do TE');
  const db = await banco({ secoes: [secao(3220, 1), secao(3220, 2), secao(3220, 3)], eventos });
  const r = await horarios.executar(db, { uf: 'xx' });
  assert.deepEqual(r.map((x) => [x.secao, x.sinal, x.valor]).sort(), [
    ['0002', 'VOTO_ANTES_ABERTURA', 1], ['0002', 'VOTO_APOS_PAUSA_17H', 2], ['0003', 'TESTE_CARGA_NO_DIA', 1]]);
});

test('rodarCruzamentos e resumir: contagens e ranking por pontuação máxima', async () => {
  const db = await banco({ secoes: [secao(3220, 1, { aptos: 90 }), secao(3220, 2)] });
  const rows = await rodarCruzamentos(db, { uf: 'xx' });
  const { contagem, ranking } = resumir(rows);
  assert.deepEqual(contagem, { 'limites/COMPARECIMENTO_ACIMA_APTOS': 1 });
  assert.equal(ranking[0].secao, '00001/0001/0001');
  assert.equal(ranking[0].max, 100);
});
