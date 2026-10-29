import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { iniciarFakeTse } from './helpers/fakeTse.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const rodar = promisify(execFile);

import { configInicial } from '../src/configSalva.js';
import { UFS } from '../src/ufs.js';

async function cli(t, args) {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-cli-cfg-'));
  return rodar(process.execPath, [CLI, ...args], {
    env: { ...process.env, TSE_BASE: fake.base, TSE_HD: '/nao/existe', TSE_CONFIG: path.join(dir, 'config.json') },
  });
}

// Sobe o painel numa porta livre e devolve a URL base; encerra com SIGINT no fim do teste.
async function subirPainel(t, args, { tseConfig }) {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const filho = spawn(process.execPath, [CLI, 'painel', '--porta', '0', ...args], {
    env: { ...process.env, TSE_BASE: fake.base, TSE_HD: '/nao/existe', TSE_CONFIG: tseConfig },
  });
  let saida = '';
  let erros = '';
  filho.stderr.on('data', (d) => { erros += d; });
  const saiu = new Promise((resolve) => filho.on('exit', (codigo) => resolve(codigo)));
  const base = await new Promise((resolve, reject) => {
    filho.stdout.on('data', (d) => {
      saida += d;
      const m = /painel em http:\/\/localhost:(\d+)/.exec(saida);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    saiu.then((codigo) => reject(new Error(`painel saiu (${codigo}): ${erros}`)));
  });
  const encerrar = async () => {
    filho.kill('SIGINT');
    return saiu;
  };
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });
  return { base, encerrar, saida: () => saida, erros: () => erros };
}

test('eleicoes lista os pleitos do ele-c.json', async (t) => {
  const { stdout } = await cli(t, ['eleicoes']);
  assert.match(stdout, /3220\s+ele2026\s+04\/10\/2026/);
  assert.match(stdout, /6257 1º turno .*\(Presidente\)/);
});

test('coletar baixa a UF para a pasta indicada', async (t) => {
  const dados = await mkdtemp(path.join(os.tmpdir(), 'tse-cli-'));
  const { stdout } = await cli(t, ['coletar', '--pleito', '3220,3221', '--uf', 'ac', '--dados', dados]);
  assert.match(stdout, /fim: concluída/);
  await access(path.join(dados, 'raw/AC/3220/01066.zip'));
  await access(path.join(dados, 'raw/AC/3221/01066.zip'));
  await access(path.join(dados, 'manifest.sqlite'));
});

test('coletar recusa pleito inexistente', async (t) => {
  await assert.rejects(cli(t, ['coletar', '--pleito', '9999']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /pleito 9999 não existe/);
    return true;
  });
});

test('coletar sem --dados recusa HD ausente', async (t) => {
  await assert.rejects(cli(t, ['coletar', '--pleito', '3220', '--uf', 'ac']), (err) => {
    assert.match(err.stderr, /O HD está conectado\?/);
    return true;
  });
});

test('--concorrencia e --porta inválidos são recusados', async (t) => {
  await assert.rejects(cli(t, ['coletar', '--pleito', '3220', '--concorrencia', '0']), /inteiro positivo/);
  await assert.rejects(cli(t, ['painel', '--pleito', '3220', '--porta', 'abc']), /inteiro não negativo/);
  await assert.rejects(cli(t, ['coletar', '--pleito', '3220', '--uf', 'ac', '--concorrencia', '65']), /de 1 a 64/);
});

test('painel sem opções nem configuração salva abre sem configuração e aceita uma pelo painel', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-cli-painel-'));
  const tseConfig = path.join(dir, 'cfg', 'config.json');
  const { base, encerrar, saida } = await subirPainel(t, ['--dados', path.join(dir, 'dados')], { tseConfig });
  assert.match(saida(), /sem configuração/);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.atual, null);
  assert.ok(cfg.disponiveis.pleitos.length > 0);

  const r = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'x-tse-auditor': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 2, iniciar: false }),
  });
  assert.equal(r.status, 200);
  const salvo = JSON.parse(await readFile(tseConfig, 'utf8'));
  assert.deepEqual([salvo.pleitos, salvo.ufs, salvo.concorrencia, salvo.http.tentativas], [['3220'], ['ac'], 2, 8]);
  assert.equal(await encerrar(), 0);
});

test('painel usa a configuração salva e as opções valem sobre ela', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-cli-painel-'));
  const tseConfig = path.join(dir, 'config.json');
  await writeFile(tseConfig, JSON.stringify({ pleitos: ['3220', '3221'], ufs: ['ac', 'al'], concorrencia: 3, intervaloPainelMs: 900 }));
  const dados = path.join(dir, 'dados');

  let painel = await subirPainel(t, ['--dados', dados, '--sem-iniciar'], { tseConfig });
  let { atual } = await (await fetch(`${painel.base}/api/config`)).json();
  assert.deepEqual([atual.pleitos, atual.ufs, atual.concorrencia], [['3220', '3221'], ['ac', 'al'], 3]);
  assert.equal(await painel.encerrar(), 0);

  painel = await subirPainel(t, ['--dados', dados, '--sem-iniciar', '--pleito', '3221', '--concorrencia', '5'], { tseConfig });
  ({ atual } = await (await fetch(`${painel.base}/api/config`)).json());
  assert.deepEqual([atual.pleitos, atual.ufs, atual.concorrencia, atual.intervaloPainelMs], [['3221'], ['ac', 'al'], 5, 900]);
  assert.equal(await painel.encerrar(), 0);
  assert.deepEqual(JSON.parse(await readFile(tseConfig, 'utf8')).pleitos, ['3221']);
});

test('painel com configuração salva inválida abre sem configuração', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-cli-painel-'));
  const tseConfig = path.join(dir, 'config.json');
  await writeFile(tseConfig, JSON.stringify({ pleitos: ['9999'], ufs: ['ac'], concorrencia: 3 }));
  const painel = await subirPainel(t, ['--dados', path.join(dir, 'dados')], { tseConfig });
  assert.equal((await (await fetch(`${painel.base}/api/config`)).json()).atual, null);
  assert.equal(await painel.encerrar(), 0);
  assert.match(painel.erros(), /configuração salva não aplicada \(pleito 9999 não existe/);
});

test('configInicial: opções da linha de comando valem sobre a configuração salva', () => {
  const salva = { pleitos: ['3220'], ufs: ['ac'], concorrencia: 2 };
  assert.equal(configInicial({}, null), null);
  assert.deepEqual(configInicial({}, salva), { config: salva, origem: 'salva' });
  assert.deepEqual(configInicial({ pleito: '3221', concorrencia: 6 }, salva).config, { pleitos: ['3221'], ufs: ['ac'], concorrencia: 6 });
  assert.deepEqual(configInicial({ pleito: '3221' }, null).config, { pleitos: ['3221'], ufs: UFS, concorrencia: 4 });
  assert.deepEqual(configInicial({ uf: 'al,ba' }, salva).config, { pleitos: ['3220'], ufs: ['al', 'ba'], concorrencia: 2 });
  assert.equal(configInicial({ uf: 'al' }, null), null, 'sem pleito em lugar nenhum');
});
