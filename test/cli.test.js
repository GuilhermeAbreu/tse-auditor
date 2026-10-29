import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { iniciarFakeTse } from './helpers/fakeTse.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const rodar = promisify(execFile);

async function cli(t, args) {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  return rodar(process.execPath, [CLI, ...args], { env: { ...process.env, TSE_BASE: fake.base, TSE_HD: '/nao/existe' } });
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
  await assert.rejects(cli(t, ['painel', '--pleito', '3220', '--porta', 'abc']), /inteiro positivo/);
});
