import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coletor } from '../../src/coleta/coletor.js';
import { HttpClient } from '../../src/net/http.js';
import { Manifest } from '../../src/storage/manifest.js';
import { buscarEleicoes } from '../../src/tse/eleicoes.js';
import { criarUrls } from '../../src/tse/urls.js';
import { FX, iniciarFakeTse, lerFixture } from '../helpers/fakeTse.js';
import { lerZip } from '../helpers/zip.js';

const S77 = FX.secao('3220');

async function montar(t, { falhas, bytesLivres, ufs = ['ac'], pleitos = ['3220', '3221'], subpastaDados } = {}) {
  const fake = await iniciarFakeTse({ falhas });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-coletor-'));
  const dados = subpastaDados ? path.join(dir, subpastaDados) : dir;
  const http = new HttpClient({ esperaBaseMs: 1, tentativas: 2, userAgent: 'teste' });
  const { templates } = await buscarEleicoes(http, { base: fake.base, ambiente: 'oficial' });
  const manifest = new Manifest(path.join(dir, 'manifest.sqlite'));
  const coletor = new Coletor({
    manifest,
    http,
    urls: criarUrls({ base: fake.base, ambiente: 'oficial', templates }),
    pastaDados: dados,
    ciclo: 'ele2026',
    pleitos,
    ufs,
    minLivreBytes: 1,
    bytesLivres: bytesLivres ?? (async () => 10 ** 12),
  });
  t.after(async () => {
    await coletor.aguardar();
    manifest.fechar();
    await fake.fechar();
  });
  return { fake, dados, manifest, coletor };
}

test('planejar grava as configs em raw/ e registra as seções', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.planejar();
  assert.deepEqual(
    await readFile(path.join(dados, 'raw/AC/3220/ac-p003220-cs.json')),
    await lerFixture('oficial/ele2026/arquivo-urna/3220/config/ac/ac-p003220-cs.json'),
  );
  assert.deepEqual(manifest.secoesPendentes('3220', 'ac', '01066').map((s) => s.secao), ['0077', '0078', '0079']);
  assert.deepEqual(manifest.secoesPendentes('3221', 'ac', '01066').map((s) => s.secao), ['0077']);
  assert.equal(manifest.secao({ ...S77, secao: '0270' }).status, 'agregada');
  assert.deepEqual(manifest.ufs().map((u) => u.uf), ['ac']);
});

test('planejar registra aviso quando a UF não tem config no pleito', async (t) => {
  const { manifest, coletor } = await montar(t, { ufs: ['ac', 'zz'] });
  await coletor.planejar();
  assert.match(manifest.eventos(1)[0].msg, /ZZ \(HTTP 404\)/);
  assert.equal(manifest.eventos(1)[0].nivel, 'aviso');
});

const nomeArquivo = (pleito, sufixo) => `o0${pleito}ac0106600040077-${sufixo}`;
const requisicoesDe = (fake, sufixo) => fake.requisicoes.filter((r) => r.endsWith(sufixo));

test('processarSecao baixa e verifica todos os arquivos', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(S77);

  const secao = manifest.secao(S77);
  assert.equal(secao.status, 'completa');
  const arquivos = manifest.arquivosDaSecao(S77);
  assert.deepEqual(
    arquivos.map((a) => [a.tipo, a.status, a.verificacao]).sort(),
    [['bu', 'ok', 'vsc'], ['log', 'ok', 'vsc'], ['rdv', 'ok', 'vsc'], ['vota', 'ok', 'dir']],
  );
  assert.equal(secao.bytes, arquivos.reduce((t, a) => t + a.bytes, 0));

  const staging = path.join(dados, 'staging/AC/3220/01066/0004/0077');
  assert.deepEqual(
    await readFile(path.join(staging, FX.hash3220, nomeArquivo('3220', 'bu.dat'))),
    await lerFixture(`${FX.dirSecao('3220')}/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`),
  );
  await access(path.join(staging, 'p003220-ac-m01066-z0004-s0077-aux.json'));
  assert.ok(coletor.velocidadeBps() > 0);
});

test('seção sem índice no servidor fica com erro', async (t) => {
  const { manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(FX.secao('3220', '0078'));
  const secao = manifest.secao(FX.secao('3220', '0078'));
  assert.equal(secao.status, 'erro');
  assert.equal(secao.erro, 'índice: HTTP 404');
});

test('seção sem arquivos fica como sem_arquivos', async (t) => {
  const { manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(FX.secao('3220', '0079'));
  assert.equal(manifest.secao(FX.secao('3220', '0079')).status, 'sem_arquivos');
});

test('arquivo corrompido em trânsito é baixado de novo', async (t) => {
  const { fake, manifest, coletor } = await montar(t, { falhas: { [nomeArquivo('3220', 'bu.dat')]: ['corromper'] } });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  assert.equal(manifest.secao(S77).status, 'completa');
  assert.equal(requisicoesDe(fake, nomeArquivo('3220', 'bu.dat')).length, 2);
});

test('corrupção persistente marca o arquivo e a seção com erro', async (t) => {
  const falhas = { [nomeArquivo('3220', 'bu.dat')]: ['corromper', 'corromper', 'corromper'] };
  const { fake, manifest, coletor } = await montar(t, { falhas });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const bu = manifest.arquivosDaSecao(S77).find((a) => a.tipo === 'bu');
  assert.equal(bu.status, 'erro');
  assert.equal(bu.erro, 'md5 não confere com o ETag');
  assert.equal(requisicoesDe(fake, nomeArquivo('3220', 'bu.dat')).length, 3);
  const secao = manifest.secao(S77);
  assert.equal(secao.status, 'erro');
  assert.equal(secao.erro, `${nomeArquivo('3220', 'bu.dat')}: md5 não confere com o ETag`);
});

test('bu cujo sha512 não consta no .vsc é rejeitado', async (t) => {
  const falhas = { [nomeArquivo('3220', 'bu.dat')]: ['corromperComEtag', 'corromperComEtag', 'corromperComEtag'] };
  const { manifest, coletor } = await montar(t, { falhas });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const bu = manifest.arquivosDaSecao(S77).find((a) => a.tipo === 'bu');
  assert.equal(bu.status, 'erro');
  assert.equal(bu.erro, 'sha512 não consta no .vsc');
});

test('.vsc que não confere com o hash do diretório invalida o conjunto', async (t) => {
  const falhas = { [nomeArquivo('3220', 'vota.vsc')]: ['corromperComEtag', 'corromperComEtag', 'corromperComEtag'] };
  const { fake, manifest, coletor } = await montar(t, { falhas });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const porTipo = Object.fromEntries(manifest.arquivosDaSecao(S77).map((a) => [a.tipo, a]));
  assert.equal(porTipo.vota.erro, 'sha256 do .vsc não confere com o hash do diretório');
  assert.equal(porTipo.bu.status, 'erro');
  assert.equal(porTipo.bu.erro, '.vsc inválido; arquivo não baixado');
  assert.equal(requisicoesDe(fake, nomeArquivo('3220', 'bu.dat')).length, 0);
  assert.equal(manifest.secao(S77).status, 'erro');
});
