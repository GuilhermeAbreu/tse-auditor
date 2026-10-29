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
