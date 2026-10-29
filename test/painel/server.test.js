import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { criarPainel } from '../../src/painel/server.js';

const H = { 'x-tse-auditor': '1' };

async function subir(t, { obterEstado, coletor = { pausar() {}, retomar() {}, executar() {}, parar() {} } }) {
  const servidor = criarPainel({ obterEstado, coletor, intervaloMs: 20 });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }));
  return `http://127.0.0.1:${servidor.address().port}`;
}

test('serve página, estáticos, estado e controles', async (t) => {
  const chamadas = [];
  const coletor = {
    pausar: (uf) => chamadas.push(['pausar', uf]), retomar: (uf) => chamadas.push(['retomar', uf]),
    executar: () => chamadas.push(['executar']), parar: () => chamadas.push(['parar']),
  };
  const base = await subir(t, { obterEstado: async () => ({ teste: 1 }), coletor });

  assert.match(await (await fetch(`${base}/`)).text(), /TSE Auditor/);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/estilo.css`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/estado`)).json(), { teste: 1 });

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
  const leitor = resp.body.getReader();
  const decodificador = new TextDecoder();
  let texto = '';
  while (!texto.includes('"n":2')) texto += decodificador.decode((await leitor.read()).value);
  assert.match(texto, /^data: \{"n":1\}\n\n/);
  controle.abort();
});

test('erro ao montar o estado vira 500', async (t) => {
  const base = await subir(t, { obterEstado: async () => { throw new Error('quebrou'); } });
  const r = await fetch(`${base}/api/estado`);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { erro: 'quebrou' });
});

test('recusa Origin estranho, POST sem cabeçalho e Host errado', async (t) => {
  const chamadas = [];
  const coletor = { pausar: (uf) => chamadas.push(uf), retomar() {}, executar() {}, parar() {} };
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
