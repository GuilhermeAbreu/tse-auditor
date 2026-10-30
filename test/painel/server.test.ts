import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { criarPainel } from '../../src/painel/server.ts';
import { ControleColeta } from '../../src/coleta/controle.ts';
import { HttpClient } from '../../src/net/http.ts';
import { buscarEleicoes } from '../../src/tse/eleicoes.ts';
import { iniciarFakeTse } from '../helpers/fakeTse.ts';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { OpcoesHttpClient } from '../../src/net/http.ts';

type Controle = Parameters<typeof criarPainel>[0]['controle'];
type Falso = { obterEstado: () => Promise<unknown>; coletor?: unknown; intervaloPainelMs?: () => number; controle?: Controle };

const H: Record<string, string> = { 'x-tse-auditor': '1' };
const HJ: Record<string, string> = { ...H, 'content-type': 'application/json' };
const COLETOR_NULO = { pausar() {}, retomar() {}, executar() {}, parar() {} };

// Controle falso: só o que o servidor usa.
const falso = ({ obterEstado, coletor = COLETOR_NULO, intervaloPainelMs = () => 20 }: Falso) => ({
  obterEstado, coletor, intervaloPainelMs, configuracao: () => null, disponiveis: () => ({ pleitos: [], ufs: [] }),
}) as unknown as Controle;

async function subir(t: TestContext, opcoes: Falso) {
  return subirControle(t, opcoes.controle ?? falso(opcoes));
}

async function subirControle(t: TestContext, controle: Controle) {
  const servidor = criarPainel({ controle });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }));
  return `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
}

test('serve página, estáticos, estado e controles', async (t) => {
  const chamadas: string[][] = [];
  const coletor = {
    pausar: (uf: string) => chamadas.push(['pausar', uf]), retomar: (uf: string) => chamadas.push(['retomar', uf]),
    executar: () => chamadas.push(['executar']), parar: () => chamadas.push(['parar']),
  };
  const base = await subir(t, { obterEstado: async () => ({ teste: 1 }), coletor });

  assert.match(await (await fetch(`${base}/`)).text(), /TSE Auditor/);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/estilo.css`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/estado`)).json() as any, { teste: 1 });

  assert.equal((await fetch(`${base}/api/uf/ac/pausar`, { method: 'POST', headers: H })).status, 200);
  assert.equal((await fetch(`${base}/api/uf/sp/iniciar`, { method: 'POST', headers: H })).status, 200);
  assert.equal((await fetch(`${base}/api/coleta/iniciar`, { method: 'POST', headers: H })).status, 200);
  assert.equal((await fetch(`${base}/api/coleta/parar`, { method: 'POST', headers: H })).status, 200);
  assert.deepEqual(chamadas, [['pausar', 'ac'], ['retomar', 'sp'], ['executar'], ['parar']]);

  assert.equal((await fetch(`${base}/api/uf/ac/pausar`)).status, 404, 'controle só por POST');
  assert.equal((await fetch(`${base}/api/nada`)).status, 404);
});

test('SSE envia o estado periodicamente', async (t) => {
  let n = 0;
  const base = await subir(t, { obterEstado: async () => ({ n: ++n }) });
  const controle = new AbortController();
  const resp = await fetch(`${base}/api/eventos`, { signal: controle.signal });
  assert.equal(resp.headers.get('content-type'), 'text/event-stream');
  const leitor = resp.body!.getReader();
  const decodificador = new TextDecoder();
  let texto = '';
  while (!texto.includes('"n":2')) texto += decodificador.decode((await leitor.read()).value);
  assert.match(texto, /^data: \{"n":1\}\n\n/);
  controle.abort();
});

test('SSE lê o intervalo do controle a cada envio', async (t) => {
  let intervalo = 20;
  let lidas = 0;
  let n = 0;
  const base = await subir(t, { obterEstado: async () => ({ n: ++n }), intervaloPainelMs: () => (lidas++, intervalo) });
  const controle = new AbortController();
  const leitor = (await fetch(`${base}/api/eventos`, { signal: controle.signal })).body!.getReader();
  const decodificador = new TextDecoder();
  let texto = '';
  while (!texto.includes('"n":3')) texto += decodificador.decode((await leitor.read()).value);
  assert.ok(lidas >= 2);
  intervalo = 60_000;
  await new Promise((r) => setTimeout(r, 200));
  const ate = n;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(n, ate, 'com intervalo longo não envia mais');
  assert.ok(n <= 5);
  controle.abort();
});

test('erro ao montar o estado vira 500', async (t) => {
  const base = await subir(t, { obterEstado: async () => { throw new Error('quebrou'); } });
  const r = await fetch(`${base}/api/estado`);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json() as any, { erro: 'quebrou' });
});

test('recusa Origin estranho, POST sem cabeçalho e Host errado', async (t) => {
  const chamadas: string[] = [];
  const coletor = { pausar: (uf: string) => chamadas.push(uf), retomar() {}, executar() {}, parar() {} };
  const base = await subir(t, { obterEstado: async () => ({}), coletor });
  const url = `${base}/api/uf/ac/pausar`;
  assert.equal((await fetch(url, { method: 'POST', headers: { ...H, origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...H, origin: base } })).status, 200);
  assert.deepEqual(chamadas, ['ac']);

  const { port } = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/estado', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

async function controleReal(t: TestContext) {
  const fake = await iniciarFakeTse();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-painel-'));
  const criarHttp = (opcoes: OpcoesHttpClient) => new HttpClient({ ...opcoes, esperaBaseMs: 1, tentativas: 2 });
  const eleicoes = await buscarEleicoes(criarHttp({}), { base: fake.base, ambiente: 'oficial' });
  const controle = new ControleColeta({
    eleicoes, hd: '/nao/existe', base: fake.base, ambiente: 'oficial',
    dadosFixo: path.join(dir, 'dados'), arquivoConfig: path.join(dir, 'config.json'), criarHttp, bytesLivres: async () => 10 ** 12,
  });
  t.after(async () => {
    await controle.fechar();
    await fake.fechar();
  });
  return controle;
}

test('configuração: GET mostra atual e disponíveis; POST aplica ou recusa', async (t) => {
  const controle = await controleReal(t);
  const base = await subirControle(t, controle);
  const post = (corpo: unknown, headers = HJ) => fetch(`${base}/api/config`, { method: 'POST', headers, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });

  let r = await fetch(`${base}/api/config`);
  assert.equal(r.status, 200);
  let cfg = await r.json() as any;
  assert.equal(cfg.atual, null);
  assert.ok(cfg.disponiveis.pleitos.some((p: { cd: string }) => p.cd === '3220'));
  assert.equal(cfg.disponiveis.ufs.length, 28);
  assert.equal(cfg.padroes.concorrencia, 4);
  assert.equal(cfg.padroes.http.tentativas, 8);
  assert.deepEqual(cfg.limites.concorrencia, { min: 1, max: 64, alerta: 16 });
  assert.deepEqual(cfg.somenteLeitura, { base: controle.base, ambiente: 'oficial', dadosFixo: controle.dadosFixo, porta: Number(new URL(base).port) });

  assert.equal((await fetch(`${base}/api/uf/ac/pausar`, { method: 'POST', headers: H })).status, 409, 'sem configuração');
  assert.deepEqual(await (await fetch(`${base}/api/coleta/iniciar`, { method: 'POST', headers: H })).json() as any, { erro: 'sem configuração' });
  assert.equal((await fetch(`${base}/api/estado`)).status, 200);

  assert.equal((await post({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 2 }, { 'content-type': 'application/json' })).status, 403, 'sem cabeçalho');
  assert.equal((await post({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 2 }, H)).status, 415, 'sem JSON');
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(70 * 1024))).status, 413);
  r = await post({ pleitos: ['3220', '452'], ufs: ['ac'], concorrencia: 2 });
  assert.equal(r.status, 400);
  assert.match((await r.json() as any).erro, /mesmo ciclo/);
  assert.equal((await post({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 99 })).status, 400);
  assert.equal((await post([1])).status, 400);
  r = await post({ pleitos: ['3220'], ufs: ['ac'], http: { esperaBaseMs: 5000, esperaMaxMs: 1000 } });
  assert.equal(r.status, 400);
  assert.match((await r.json() as any).erro, /espera máxima/);
  assert.equal(controle.configuracao(), null);

  r = await post({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 2, iniciar: false });
  assert.equal(r.status, 200);
  const { ok, atual } = await r.json() as any;
  assert.equal(ok, true);
  assert.deepEqual([atual.pleitos, atual.ufs, atual.concorrencia, atual.ciclo], [['3220'], ['ac'], 2, 'ele2026']);
  cfg = await (await fetch(`${base}/api/config`)).json() as any;
  assert.deepEqual(cfg.atual, atual);
  assert.equal(controle.coletor!.estado.rodando, false);
  assert.deepEqual((await (await fetch(`${base}/api/estado`)).json() as any).configuracao, atual);
  assert.equal((await fetch(`${base}/api/uf/ac/pausar`, { method: 'POST', headers: H })).status, 200);

  r = await post({ pleitos: ['3220'], ufs: ['ac'], concorrencia: 2, iniciar: true });
  assert.equal(r.status, 200);
  assert.equal(controle.coletor!.estado.rodando, true);
  await controle.coletor!.aguardar();
});

test('preferências: começa sem resposta, salva só booleano e exige o cabeçalho', async (t) => {
  const arquivo = path.join(await mkdtemp(path.join(os.tmpdir(), 'tse-pref-')), 'preferencias.json');
  const servidor = criarPainel({ controle: falso({ obterEstado: async () => ({}) }), preferencias: arquivo, servico: true });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }));
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  assert.deepEqual(await (await fetch(`${base}/api/preferencias`)).json(), { iniciarAoLigar: null, servico: true });
  const enviar = (corpo: unknown, headers = HJ) => fetch(`${base}/api/preferencias`, { method: 'POST', headers, body: JSON.stringify(corpo) });
  assert.equal((await enviar({ iniciarAoLigar: true }, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await enviar({ iniciarAoLigar: 'sim' })).status, 400);
  assert.equal((await enviar({ iniciarAoLigar: true })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/preferencias`)).json(), { iniciarAoLigar: true, servico: true });
});
