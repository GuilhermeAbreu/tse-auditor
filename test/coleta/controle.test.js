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
  const http = [];
  const criarHttp = (opcoes) => {
    http.push(opcoes);
    return new HttpClient({ ...opcoes, esperaBaseMs: 1, tentativas: 2 });
  };
  const eleicoes = await buscarEleicoes(new HttpClient({ esperaBaseMs: 1, tentativas: 2 }), { base: fake.base, ambiente: 'oficial' });
  const arquivoConfig = path.join(dir, 'cfg', 'config.json');
  const controle = new ControleColeta({
    eleicoes,
    hd: '/nao/existe',
    base: fake.base,
    ambiente: 'oficial',
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
  return { controle, dir, arquivoConfig, fake, http };
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
  const { concorrencia, ...outros } = controle.padroes;
  const salvo = { pleitos: ['3220', '3221'], ufs: ['ac'], ...outros, concorrencia: 2 };
  const esperado = { ...salvo, ciclo: 'ele2026', dados: path.join(dir, 'dados') };
  assert.deepEqual(atual, esperado);
  assert.deepEqual(controle.configuracao(), esperado);
  assert.equal(controle.coletor.estado.rodando, false, 'sem iniciar');
  assert.deepEqual(await lerConfigSalva(arquivoConfig), salvo);
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
    [{ ...ok, concorrencia: 0 }, /de 1 a 64/],
    [{ ...ok, concorrencia: 65 }, /concorrência precisa ser um inteiro de 1 a 64/],
    [{ ...ok, concorrencia: 2.5 }, /de 1 a 64/],
    [{ ...ok, concorrencia: '4' }, /de 1 a 64/],
    [{ ...ok, http: { tentativas: 0 } }, /tentativas por requisição .* de 1 a 20/],
    [{ ...ok, http: { tentativas: 21 } }, /de 1 a 20/],
    [{ ...ok, http: { esperaBaseMs: 99 } }, /espera inicial .* de 100 a 60000/],
    [{ ...ok, http: { esperaMaxMs: 600_001 } }, /espera máxima .* de 1000 a 600000/],
    [{ ...ok, http: { esperaBaseMs: 5000, esperaMaxMs: 2000 } }, /não pode ser menor que a inicial/],
    [{ ...ok, http: { timeoutMs: 4999 } }, /tempo limite .* de 5000 a 600000/],
    [{ ...ok, http: { userAgent: '  ' } }, /User-Agent não pode ficar vazio/],
    [{ ...ok, http: { userAgent: 'x'.repeat(201) } }, /no máximo 200/],
    [{ ...ok, http: { userAgent: 'a\r\nb' } }, /ASCII/],
    [{ ...ok, tentativasVerificacao: 11 }, /tentativas de verificação .* de 1 a 10/],
    [{ ...ok, limiteFalhasRede: 0 }, /falhas de rede .* de 1 a 1000/],
    [{ ...ok, minLivreGB: 1001 }, /espaço mínimo .* de 1 a 1000/],
    [{ ...ok, intervaloCommitMs: 50 }, /gravação do manifest .* de 100 a 60000/],
    [{ ...ok, intervaloPainelMs: 499 }, /atualização do painel .* de 500 a 60000/],
    [{ ...ok, hd: 'relativo/hd' }, /caminho do HD precisa ser absoluto/],
    [{ ...ok, hd: '' }, /absoluto/],
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

test('opções avançadas chegam ao HTTP, ao coletor e ao manifest; campos ausentes ficam como estavam', async (t) => {
  const { controle, http } = await montar(t);
  await controle.aplicar({
    pleitos: ['3220'], ufs: ['ac'], concorrencia: 20,
    http: { tentativas: 3, esperaBaseMs: 200, esperaMaxMs: 2000, timeoutMs: 6000, userAgent: 'meu agente' },
    tentativasVerificacao: 1, limiteFalhasRede: 7, minLivreGB: 2, intervaloCommitMs: 300, intervaloPainelMs: 900,
  });
  assert.deepEqual(http.at(-1), { concorrencia: 20, tentativas: 3, esperaBaseMs: 200, esperaMaxMs: 2000, timeoutMs: 6000, userAgent: 'meu agente' });
  const { coletor } = controle;
  assert.deepEqual([coletor.tentativasVerificacao, coletor.limiteFalhasRede, coletor.minLivreBytes, coletor.concorrencia], [1, 7, 2 * 1024 ** 3, 20]);
  assert.equal(controle.intervaloPainelMs(), 900);

  await controle.aplicar({ http: { tentativas: 5 } });
  const atual = controle.configuracao();
  assert.deepEqual(atual.pleitos, ['3220']);
  assert.equal(atual.concorrencia, 20);
  assert.deepEqual(atual.http, { tentativas: 5, esperaBaseMs: 200, esperaMaxMs: 2000, timeoutMs: 6000, userAgent: 'meu agente' });
  assert.equal(atual.intervaloCommitMs, 300);
});

test('mudar o intervalo de gravação reabre o manifest', async (t) => {
  const { controle } = await montar(t);
  await controle.aplicar({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 2 });
  const primeiro = controle.manifest;
  await controle.aplicar({ concorrencia: 3 });
  assert.equal(controle.manifest, primeiro, 'mesma pasta e mesmo intervalo: mantém');
  await controle.aplicar({ intervaloCommitMs: 500 });
  assert.notEqual(controle.manifest, primeiro);
  assert.equal(primeiro.db.open, false);
  assert.equal(controle.manifest.db.open, true);
  controle.manifest.registrarEvento('info', null, 'grava no manifest reaberto');
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

  // o HD informado na configuração vale sobre o padrão
  const hd = await mkdtemp(path.join(os.tmpdir(), 'tse-controle-hd-'));
  await controle.aplicar({ pleitos: ['3220'], ufs: ['ac'], hd });
  assert.equal(controle.configuracao().dados, path.join(hd, 'tse2026'));
  await assert.rejects(controle.aplicar({ hd: path.join(dir, 'outro-hd') }), /O HD está conectado\?/);
  assert.equal(controle.configuracao().hd, hd, 'falha mantém a configuração anterior');
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

  // trocar de HD também reabre o manifest, na pasta do ano dentro do novo HD
  const hd2 = await mkdtemp(path.join(os.tmpdir(), 'tse-controle-hd2-'));
  const m2024 = controle.manifest;
  await controle.aplicar({ pleitos: ['452'], ufs: ['ac'], concorrencia: 4, hd: hd2 });
  assert.equal(controle.configuracao().dados, path.join(hd2, 'tse2024'));
  assert.equal(m2024.db.open, false);
  await controle.aplicar({ pleitos: ['452'], ufs: ['ac'], concorrencia: 4, hd });
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
