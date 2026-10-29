import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { DuckDBInstance } from '@duckdb/node-api';
import { extrairUF } from '../../src/extracao/extrator.js';
import { BASE } from './fixtures.js';

async function zipar(pasta, destino, pular) {
  const z = new yazl.ZipFile();
  for (const d of await readdir(pasta, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(pasta, path.join(d.parentPath, d.name));
    if (d.isFile() && !pular(rel)) z.addFile(path.join(pasta, rel), rel, { compress: false });
  }
  z.end();
  await new Promise((ok, falha) => z.outputStream.pipe(createWriteStream(destino)).on('close', ok).on('error', falha));
}

test('extrai seções, votos, log e falhas para parquet', async () => {
  const dados = await mkdtemp(path.join(os.tmpdir(), 'tse-extr-'));
  const raw = path.join(dados, 'raw/AC/3220');
  await mkdir(raw, { recursive: true });
  await copyFile(path.join(BASE, '3220/config/ac/ac-p003220-cs.json'), path.join(raw, 'ac-p003220-cs.json'));
  // a 0079 fica sem arquivos de urna (só aux.json): deve aparecer como "sem dados" com falhas registradas
  await zipar(path.join(BASE, '3220/dados/ac/01066'), path.join(raw, '01066.zip'), (rel) => rel.includes('0079/') && !rel.endsWith('.json'));
  const stats = await extrairUF({ dados, uf: 'ac' });
  assert.equal(stats.secoes, 4);
  assert.equal(stats.ok, 1);
  assert.equal(stats.agregadasEm, 1);
  assert.equal(stats.comInconsistencia, 0);
  const db = await DuckDBInstance.create();
  const con = await db.connect();
  const q = async (sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();
  const pq = (t) => `'${path.join(dados, 'parquet/AC', `${t}.parquet`)}'`;
  const secoes = await q(`select secao, status, agregada, comparecimento, abstencao, inconsistencias from ${pq('secoes')} order by secao`);
  assert.deepEqual(secoes.map((s) => [s.secao, s.status]), [['0077', 'ok'], ['0078', 'sem dados'], ['0079', 'sem dados'], ['0270', 'agregada']]);
  assert.equal(secoes[0].agregada, true);
  assert.equal(secoes[0].abstencao, 55);
  const [{ n }] = await q(`select count(*)::int n from ${pq('eventos_log')} where tipo = 'voto_computado' and ts::date = '2026-10-04'`);
  assert.equal(n, 234);
  const falhas = await q(`select secao, arquivo from ${pq('falhas')} order by all`);
  assert.ok(falhas.some((f) => f.secao === '0079' && f.arquivo === 'bu'));
  assert.ok(falhas.some((f) => f.secao === '0078' && f.arquivo === 'aux'));
  con.closeSync();
  db.closeSync();
  await rm(dados, { recursive: true, force: true });
});
