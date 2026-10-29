import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControleColeta } from '../../src/coleta/controle.js';
import { caminhoConfigSalva, lerConfigSalva } from '../../src/configSalva.js';
import { HttpClient } from '../../src/net/http.js';
import { buscarEleicoes } from '../../src/tse/eleicoes.js';
import { UFS } from '../../src/ufs.js';
import { iniciarFakeTse } from '../helpers/fakeTse.js';

async function montar(t, { criarColetor } = {}) {
  const fake = await iniciarFakeTse();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-controle-'));
  const criarHttp = (concorrencia) => new HttpClient({ concorrencia, esperaBaseMs: 1, tentativas: 2, userAgent: 'teste' });
  const eleicoes = await buscarEleicoes(criarHttp(1), { base: fake.base, ambiente: 'oficial' });
  const arquivoConfig = path.join(dir, 'cfg', 'config.json');
  const controle = new ControleColeta({
    eleicoes,
    hd: '/nao/existe',
    base: fake.base,
    ambiente: 'oficial',
    minLivreBytes: 1,
    dadosFixo: path.join(dir, 'dados'),
    arquivoConfig,
    criarHttp,
    criarColetor,
    bytesLivres: async () => 10 ** 12,
  });
  t.after(async () => {
    await controle.fechar();
    await fake.fechar();
  });
  return { controle, dir, arquivoConfig, fake };
}

test('sem configuração: estado mínimo e lista do que está disponível', async (t) => {
  const { controle } = await montar(t);
  assert.equal(controle.configuracao(), null);
  assert.equal(controle.coletor, null);
  const estado = await controle.obterEstado();
  assert.equal(estado.configuracao, null);
  assert.equal(estado.coleta.rodando, false);
  assert.deepEqual(estado.ufs, []);
  assert.equal(estado.totais.secoes, 0);

  const { pleitos, ufs } = controle.disponiveis();
  assert.deepEqual(ufs, UFS);
  assert.equal(pleitos[0].cd, '3221', 'mais recente primeiro');
  assert.equal(pleitos[1].cd, '3220');
  assert.deepEqual(pleitos[1].eleicoes[0], { cd: '6257', nome: 'Eleição Ordinária Federal - 2026 1º Turno', turno: 1, cargos: ['Presidente'] });
});

test('aplicar configura, salva e devolve a configuração', async (t) => {
  const { controle, dir, arquivoConfig } = await montar(t);
  const atual = await controle.aplicar({ pleitos: ['3220', '3221'], ufs: ['AC'], concorrencia: 2 });
  const esperado = { pleitos: ['3220', '3221'], ufs: ['ac'], concorrencia: 2, ciclo: 'ele2026', dados: path.join(dir, 'dados') };
  assert.deepEqual(atual, esperado);
  assert.deepEqual(controle.configuracao(), esperado);
  assert.equal(controle.coletor.estado.rodando, false, 'sem iniciar');
  assert.deepEqual(await lerConfigSalva(arquivoConfig), { pleitos: ['3220', '3221'], ufs: ['ac'], concorrencia: 2 });
  await access(path.join(dir, 'dados', 'manifest.sqlite'));
  assert.deepEqual((await controle.obterEstado()).configuracao, esperado);
});

test('aplicar recusa configurações inválidas sem mudar a atual', async (t) => {
  const { controle } = await montar(t);
  const ok = { pleitos: ['3220'], ufs: ['ac'], concorrencia: 4 };
  const casos = [
    [{ ...ok, pleitos: [] }, /ao menos um pleito/],
    [{ ...ok, pleitos: ['9999'] }, /9999 não existe/],
    [{ ...ok, pleitos: ['3220', '452'] }, /mesmo ciclo/],
    [{ ...ok, ufs: [] }, /ao menos uma UF/],
    [{ ...ok, ufs: ['xx'] }, /UF desconhecida: xx/],
    [{ ...ok, concorrencia: 0 }, /de 1 a 16/],
    [{ ...ok, concorrencia: 17 }, /de 1 a 16/],
    [{ ...ok, concorrencia: 2.5 }, /de 1 a 16/],
    [{ ...ok, concorrencia: '4' }, /de 1 a 16/],
    [undefined, /ao menos um pleito/],
  ];
  for (const [config, erro] of casos) await assert.rejects(controle.aplicar(config), erro);
  assert.equal(controle.configuracao(), null);
  await controle.aplicar(ok);
  await assert.rejects(controle.aplicar({ ...ok, ufs: ['zz', 'xx'] }), /UF desconhecida/);
  assert.deepEqual(controle.configuracao().ufs, ['ac']);
});

test('aplicar com iniciar coleta; aplicar de novo para e recomeça com a nova configuração', async (t) => {
  const { controle } = await montar(t);
  await controle.aplicar({ pleitos: ['3220', '3221'], ufs: ['ac'], concorrencia: 4 }, { iniciar: true });
  const primeiro = controle.coletor;
  assert.equal(primeiro.estado.rodando, true);
  await primeiro.aguardar();
  assert.equal(primeiro.estado.motivoParada, 'concluída');

  // reinicia enquanto roda: o coletor anterior é parado e um novo assume
  await controle.aplicar({ pleitos: ['3220'], ufs: ['ac', 'zz'], concorrencia: 1 }, { iniciar: true });
  const segundo = controle.coletor;
  assert.notEqual(segundo, primeiro);
  assert.equal(segundo.estado.rodando, true);
  await controle.aplicar({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 3 }, { iniciar: false });
  assert.equal(segundo.estado.rodando, false, 'o anterior foi parado');
  assert.equal(segundo.estado.motivoParada, 'parada solicitada');
  assert.equal(controle.coletor.concorrencia, 3);
  assert.deepEqual(controle.coletor.pleitos, ['3220']);

  const estado = await controle.obterEstado();
  assert.deepEqual(estado.ufs.map((u) => u.uf), ['ac'], 'só as UFs da configuração');
  assert.ok(estado.totais.concluidas > 0, 'o que já foi baixado continua no manifest');
});

test('aplicar sem --dados recusa HD ausente e mantém o estado', async (t) => {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const http = new HttpClient({ esperaBaseMs: 1, tentativas: 2 });
  const eleicoes = await buscarEleicoes(http, { base: fake.base, ambiente: 'oficial' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-controle-'));
  const controle = new ControleColeta({ eleicoes, hd: path.join(dir, 'sem-hd'), base: fake.base, ambiente: 'oficial', arquivoConfig: path.join(dir, 'c.json') });
  t.after(() => controle.fechar());
  await assert.rejects(controle.aplicar({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 4 }), /O HD está conectado\?/);
  assert.equal(controle.configuracao(), null);
});

test('troca de ciclo abre o manifest da pasta do novo ano', async (t) => {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const http = new HttpClient({ esperaBaseMs: 1, tentativas: 2 });
  const eleicoes = await buscarEleicoes(http, { base: fake.base, ambiente: 'oficial' });
  const hd = await mkdtemp(path.join(os.tmpdir(), 'tse-controle-hd-'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-controle-'));
  const controle = new ControleColeta({ eleicoes, hd, base: fake.base, ambiente: 'oficial', arquivoConfig: path.join(dir, 'c.json') });
  t.after(() => controle.fechar());
  await controle.aplicar({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 4 });
  const m2026 = controle.manifest;
  assert.equal(controle.configuracao().dados, path.join(hd, 'tse2026'));
  await controle.aplicar({ pleitos: ['452'], ufs: ['ac'], concorrencia: 4 });
  assert.equal(controle.configuracao().dados, path.join(hd, 'tse2024'));
  assert.notEqual(controle.manifest, m2026);
  assert.equal(m2026.db.open, false, 'manifest anterior fechado');
  await access(path.join(hd, 'tse2024', 'manifest.sqlite'));
  await controle.aplicar({ pleitos: ['453'], ufs: ['ac'], concorrencia: 4 });
  assert.equal(controle.configuracao().dados, path.join(hd, 'tse2024'));
});

test('aplicações simultâneas entram na fila', async (t) => {
  const { controle } = await montar(t);
  const [a, b] = await Promise.all([
    controle.aplicar({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 1 }),
    controle.aplicar({ pleitos: ['3221'], ufs: ['al'], concorrencia: 2 }),
  ]);
  assert.equal(a.concorrencia, 1);
  assert.equal(b.concorrencia, 2);
  assert.deepEqual(controle.configuracao().pleitos, ['3221']);
});

test('caminho da configuração salva: TSE_CONFIG, XDG_CONFIG_HOME e ~/.config', async () => {
  assert.equal(caminhoConfigSalva({ TSE_CONFIG: '/tmp/x.json', XDG_CONFIG_HOME: '/y' }), '/tmp/x.json');
  assert.equal(caminhoConfigSalva({ XDG_CONFIG_HOME: '/y' }), '/y/tse-auditor/config.json');
  assert.equal(caminhoConfigSalva({}), path.join(os.homedir(), '.config', 'tse-auditor', 'config.json'));
});

test('configuração salva ilegível ou ausente vira null', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-cfg-'));
  assert.equal(await lerConfigSalva(path.join(dir, 'nada.json')), null);
  await writeFile(path.join(dir, 'ruim.json'), '{');
  assert.equal(await lerConfigSalva(path.join(dir, 'ruim.json')), null);
  assert.ok((await readFile(path.join(dir, 'ruim.json'), 'utf8')).length > 0);
});
