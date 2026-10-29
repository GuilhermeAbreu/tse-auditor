import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coletor, SemConexaoError } from '../../src/coleta/coletor.js';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { HttpClient, HttpError } from '../../src/net/http.js';
import { Manifest } from '../../src/storage/manifest.js';
import { buscarEleicoes } from '../../src/tse/eleicoes.js';
import { criarUrls } from '../../src/tse/urls.js';
import { FX, iniciarFakeTse, lerFixture } from '../helpers/fakeTse.js';
import { lerZip } from '../helpers/zip.js';

const S77 = FX.secao('3220');

async function montar(t, { falhas, bytesLivres, ufs = ['ac'], pleitos = ['3220', '3221'], subpastaDados, envolverHttp, limiteFalhasRede, tentativasVerificacao } = {}) {
  const fake = await iniciarFakeTse({ falhas });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-coletor-'));
  const dados = subpastaDados ? path.join(dir, subpastaDados) : dir;
  const http = new HttpClient({ esperaBaseMs: 1, tentativas: 2, userAgent: 'teste' });
  const { templates } = await buscarEleicoes(http, { base: fake.base, ambiente: 'oficial' });
  const manifest = new Manifest(path.join(dir, 'manifest.sqlite'));
  const coletor = new Coletor({
    manifest,
    http: envolverHttp ? envolverHttp(http) : http,
    limiteFalhasRede,
    tentativasVerificacao,
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

test('tentativasVerificacao = 1 não baixa de novo o arquivo corrompido', async (t) => {
  const falhas = { [nomeArquivo('3220', 'bu.dat')]: ['corromper'] };
  const { fake, manifest, coletor } = await montar(t, { falhas, tentativasVerificacao: 1 });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  assert.equal(requisicoesDe(fake, nomeArquivo('3220', 'bu.dat')).length, 1);
  assert.equal(manifest.secao(S77).status, 'erro');
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

const requisicoesDeDados = (fake) => fake.requisicoes.filter((r) => r.includes('/dados/'));

test('executar coleta a UF, os dois turnos, e empacota por município', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.executar();
  assert.equal(coletor.estado.motivoParada, 'concluída');
  assert.equal(coletor.estado.rodando, false);

  const zip1 = await lerZip(path.join(dados, 'raw/AC/3220/01066.zip'));
  const bu = `0004/0077/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`;
  assert.deepEqual(zip1.get(bu).dados, await lerFixture(`${FX.dirSecao('3220')}/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`));
  assert.ok(zip1.has('0004/0077/p003220-ac-m01066-z0004-s0077-aux.json'));
  assert.ok(zip1.has('0004/0079/p003220-ac-m01066-z0004-s0079-aux.json'));
  assert.equal(zip1.size, 6, '4 arquivos + 2 índices');

  const zip2 = await lerZip(path.join(dados, 'raw/AC/3221/01066.zip'));
  assert.equal(zip2.size, 5);
  await assert.rejects(access(path.join(dados, 'staging/AC/3220/01066')));
  assert.ok(manifest.municipio('3220', 'ac', '01066').empacotado_em);
  assert.equal(manifest.eventos(1)[0].msg, 'coleta concluída');
});

test('segunda execução só retenta o que falhou', async (t) => {
  const { fake, coletor } = await montar(t);
  await coletor.executar();
  const antes = fake.requisicoes.length;
  await coletor.executar();
  assert.deepEqual(fake.requisicoes.slice(antes), [
    '/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0078/p003220-ac-m01066-z0004-s0078-aux.json',
  ]);
});

test('arquivo que falhou numa execução entra no zip na seguinte', async (t) => {
  const falhas = { [nomeArquivo('3220', 'bu.dat')]: ['corromper', 'corromper', 'corromper'] };
  const { dados, manifest, coletor } = await montar(t, { falhas });
  const caminhoZip = path.join(dados, 'raw/AC/3220/01066.zip');
  const bu = `0004/0077/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`;

  await coletor.executar();
  assert.equal(manifest.secao(S77).status, 'erro');
  assert.ok(!(await lerZip(caminhoZip)).has(bu));

  await coletor.executar();
  assert.equal(manifest.secao(S77).status, 'completa');
  const zip = await lerZip(caminhoZip);
  assert.ok(zip.has(bu));
  assert.equal(zip.size, 6);
});

test('para por falta de espaço antes de baixar arquivos', async (t) => {
  const { fake, coletor } = await montar(t, { bytesLivres: async () => 0 });
  await coletor.executar();
  assert.match(coletor.estado.motivoParada, /espaço livre abaixo do mínimo/);
  assert.deepEqual(requisicoesDeDados(fake), []);
});

test('UF pausada não é coletada; retomar inicia a coleta', async (t) => {
  const { fake, dados, manifest, coletor } = await montar(t);
  manifest.registrarUfs(['ac']);
  coletor.pausar('ac');
  await coletor.executar();
  assert.equal(coletor.estado.motivoParada, 'concluída');
  assert.deepEqual(requisicoesDeDados(fake), []);

  await coletor.retomar('ac');
  await access(path.join(dados, 'raw/AC/3220/01066.zip'));
});

test('parar interrompe a execução', async (t) => {
  const { fake, coletor } = await montar(t);
  const execucao = coletor.executar();
  coletor.parar();
  await execucao;
  assert.equal(coletor.estado.motivoParada, 'parada solicitada');
  assert.deepEqual(requisicoesDeDados(fake), []);
});

test('HD inacessível interrompe com mensagem clara', async (t) => {
  const { manifest, coletor } = await montar(t, { subpastaDados: 'hd-desconectado' });
  await coletor.executar();
  assert.match(coletor.estado.motivoParada, /^HD inacessível: .*O HD está conectado\?/);
  assert.equal(manifest.eventos(1)[0].nivel, 'erro');
});

test('zip corrompido é posto de lado e refeito a partir do staging', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.executar();
  const pasta = path.join(dados, 'raw/AC/3220');
  const caminhoZip = path.join(pasta, '01066.zip');
  await writeFile(caminhoZip, Buffer.from('lixo que não é um zip'));
  manifest.finalizarSecao(FX.secao('3220', '0077'), { status: 'erro', erro: 'x' });

  await coletor.executar();
  assert.ok((await readdir(pasta)).some((n) => n.startsWith('01066.zip.corrompido-')));
  assert.equal((await lerZip(caminhoZip)).size, 6);
  assert.equal(manifest.secao(S77).status, 'completa');
  assert.ok(manifest.eventos(20).some((e) => e.nivel === 'aviso' && /zip corrompido/.test(e.msg)));
});

// http falso: responde `resposta(url)` quando ela devolve algo; senão delega ao cliente real.
const interceptar = (resposta) => (real) => ({ get: async (url) => (await resposta(url)) ?? real.get(url) });

test('staging que não confere com o manifest é descartado e refeito', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const bu = path.join(dados, 'staging/AC/3220/01066/0004/0077', FX.hash3220, nomeArquivo('3220', 'bu.dat'));
  const original = await readFile(bu);
  await writeFile(bu, Buffer.alloc(original.length));

  await coletor.executar();
  assert.ok(manifest.eventos(50).some((e) => e.nivel === 'aviso' && /não confere/.test(e.msg)));
  assert.equal(manifest.secao(S77).status, 'erro');

  await coletor.executar();
  assert.equal(manifest.secao(S77).status, 'completa');
  const zip = await lerZip(path.join(dados, 'raw/AC/3220/01066.zip'));
  assert.deepEqual(zip.get(`0004/0077/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`).dados, original);
});

test('índice com hash ou nome de arquivo inválido marca a seção com erro', async (t) => {
  const ruins = [
    { hashes: [{ hash: '../x', arq: [{ nm: 'a.dat', tp: 'bu' }] }] },
    { hashes: [{ hash: 'abc123', arq: [{ nm: '../a.dat', tp: 'bu' }] }] },
    { hashes: [{ hash: 'abc123', arq: [] }] },
  ];
  for (const indice of ruins) {
    const { manifest, coletor } = await montar(t, {
      envolverHttp: interceptar((url) => (url.endsWith('s0077-aux.json')
        ? { status: 200, body: Buffer.from(JSON.stringify(indice)), etag: null } : null)),
    });
    await coletor.planejar();
    await coletor.processarSecao(S77);
    assert.equal(manifest.secao(S77).status, 'erro');
    assert.match(manifest.secao(S77).erro, /^índice inválido: /);
  }
});

test('UF retomada durante a execução é coletada na mesma execução', async (t) => {
  let primeira = true;
  const { dados, coletor } = await montar(t, {
    ufs: ['ac', 'zz'],
    bytesLivres: async () => {
      if (primeira) {
        primeira = false;
        coletor.pausar('ac');
      }
      return 10 ** 12;
    },
  });
  let retomou = false;
  coletor.on('mudou', () => {
    if (!retomou && coletor.estado.ufAtual === 'zz') {
      retomou = true;
      coletor.retomar('ac');
    }
  });
  await coletor.executar();
  assert.ok(retomou);
  assert.equal(coletor.estado.motivoParada, 'concluída');
  assert.equal((await lerZip(path.join(dados, 'raw/AC/3220/01066.zip'))).size, 6);
});

test('verificação "nenhuma" quando não há ETag nem .vsc', async (t) => {
  const corpo = { com: Buffer.from('com etag'), sem: Buffer.from('sem etag') };
  const indice = { st: 'x', hashes: [{ hash: 'abc123', arq: [{ nm: 'a.dat', tp: 'xx' }, { nm: 'b.dat', tp: 'xx' }] }] };
  const { manifest, coletor } = await montar(t, {
    envolverHttp: interceptar((url) => {
      if (url.endsWith('s0077-aux.json')) return { status: 200, body: Buffer.from(JSON.stringify(indice)), etag: null };
      if (url.endsWith('/a.dat')) return { status: 200, body: corpo.com, etag: `"${createHash('md5').update(corpo.com).digest('hex')}"` };
      if (url.endsWith('/b.dat')) return { status: 200, body: corpo.sem, etag: null };
      return null;
    }),
  });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const por = Object.fromEntries(manifest.arquivosDaSecao(S77).map((a) => [a.nome, a.verificacao]));
  assert.deepEqual(por, { 'a.dat': 'md5', 'b.dat': 'nenhuma' });
  assert.equal(manifest.secao(S77).status, 'completa');
});

test('segunda execução não reempacota quando nada novo foi baixado', async (t) => {
  const bu = nomeArquivo('3220', 'bu.dat');
  const { dados, coletor } = await montar(t, { falhas: { [bu]: Array(6).fill('corromper') } });
  const zip = path.join(dados, 'raw/AC/3220/01066.zip');
  await coletor.executar();
  const antes = await stat(zip);
  await new Promise((r) => setTimeout(r, 20));
  await coletor.executar();
  const depois = await stat(zip);
  assert.equal(depois.mtimeMs, antes.mtimeMs);
  assert.equal(depois.size, antes.size);
  await assert.rejects(access(path.join(dados, 'staging/AC/3220/01066')));
});

test('falhas de rede seguidas interrompem a coleta', async (t) => {
  const { coletor, manifest } = await montar(t, {
    limiteFalhasRede: 3,
    envolverHttp: interceptar((url) => {
      if (url.includes('/dados/')) throw new HttpError('falha de rede: ECONNREFUSED', { url });
      return null;
    }),
  });
  await coletor.executar();
  assert.match(coletor.estado.motivoParada, /^sem conexão com o TSE: 3 falhas de rede seguidas; coleta interrompida$/);
  assert.equal(manifest.eventos(1)[0].nivel, 'erro');
  assert.ok(new SemConexaoError('x') instanceof Error);
});

test('planejar ignora UF com status inesperado em vez de abortar', async (t) => {
  const { manifest, coletor } = await montar(t, {
    envolverHttp: interceptar((url) => (url.includes('/config/') && url.includes('-p003221-')
      ? { status: 403, body: Buffer.alloc(0), etag: null } : null)),
  });
  await coletor.planejar();
  assert.ok(manifest.eventos(5).some((e) => e.nivel === 'aviso' && /HTTP 403/.test(e.msg)));
  assert.equal(manifest.secoesPendentes('3220', 'ac', '01066').length, 3);
});

test('arquivo no staging sem registro ok e índice truncado não entram no zip', async (t) => {
  const bu = nomeArquivo('3220', 'bu.dat');
  const { dados, manifest, coletor } = await montar(t, { falhas: { [bu]: Array(6).fill('corromper') } });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  assert.equal(manifest.arquivosDaSecao(S77).find((a) => a.tipo === 'bu').status, 'erro');
  const pasta = path.join(dados, 'staging/AC/3220/01066/0004/0077');
  await writeFile(path.join(pasta, FX.hash3220, bu), Buffer.from('falso'));
  await writeFile(path.join(pasta, 'p003220-ac-m01066-z0004-s0077-aux.json'), Buffer.from('{"hashes": ['));

  await coletor.executar();
  const zip = await lerZip(path.join(dados, 'raw/AC/3220/01066.zip'));
  assert.ok(!zip.has(`0004/0077/${FX.hash3220}/${bu}`));
  assert.ok(!zip.has('0004/0077/p003220-ac-m01066-z0004-s0077-aux.json'));
});

test('arquivo ok ausente do staging e do zip é rebaixado', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const bu = nomeArquivo('3220', 'bu.dat');
  const caminho = path.join(dados, 'staging/AC/3220/01066/0004/0077', FX.hash3220, bu);
  const original = await readFile(caminho);
  await rm(caminho);

  await coletor.executar();
  assert.ok(manifest.eventos(50).some((e) => e.nivel === 'aviso' && /ausente/.test(e.msg)));
  assert.equal(manifest.secao(S77).status, 'erro');

  await coletor.executar();
  assert.equal(manifest.secao(S77).status, 'completa');
  const zip = await lerZip(path.join(dados, 'raw/AC/3220/01066.zip'));
  assert.deepEqual(zip.get(`0004/0077/${FX.hash3220}/${bu}`).dados, original);
});
