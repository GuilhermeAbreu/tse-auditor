import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpError } from '../../src/net/http.js';

function fetchRoteirizado(respostas) {
  const chamadas = [];
  const fetchImpl = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} });
  };
  return { fetchImpl, chamadas };
}

function semEspera() {
  const esperas = [];
  return { esperas, dormir: async (ms) => { esperas.push(ms); } };
}

test('devolve status, corpo e etag em 200 e envia o User-Agent', async () => {
  const { fetchImpl, chamadas } = fetchRoteirizado([{ status: 200, body: 'ok', headers: { etag: '"abc"' } }]);
  const http = new HttpClient({ fetchImpl, userAgent: 'teste/1' });
  const r = await http.get('http://x/a');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'ok');
  assert.equal(r.etag, '"abc"');
  assert.equal(chamadas[0].opcoes.headers['user-agent'], 'teste/1');
});

test('404 volta sem retentar', async () => {
  const { fetchImpl, chamadas } = fetchRoteirizado([{ status: 404 }]);
  const r = await new HttpClient({ fetchImpl }).get('http://x/a');
  assert.equal(r.status, 404);
  assert.equal(chamadas.length, 1);
});

test('retenta 429 e 5xx com espera progressiva', async () => {
  const { fetchImpl, chamadas } = fetchRoteirizado([{ status: 429 }, { status: 503 }, { status: 200, body: 'ok' }]);
  const { esperas, dormir } = semEspera();
  const r = await new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100 }).get('http://x/a');
  assert.equal(r.status, 200);
  assert.equal(chamadas.length, 3);
  assert.deepEqual(esperas, [100, 200]);
});

test('respeita Retry-After', async () => {
  const { fetchImpl } = fetchRoteirizado([{ status: 429, headers: { 'retry-after': '7' } }, { status: 200 }]);
  const { esperas, dormir } = semEspera();
  await new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100 }).get('http://x/a');
  assert.deepEqual(esperas, [7000]);
});

test('falha de rede também é retentada', async () => {
  const { fetchImpl } = fetchRoteirizado([new TypeError('fetch failed'), { status: 200, body: 'ok' }]);
  const { esperas, dormir } = semEspera();
  const r = await new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100 }).get('http://x/a');
  assert.equal(r.body.toString(), 'ok');
  assert.deepEqual(esperas, [100]);
});

test('desiste depois do número de tentativas', async () => {
  const { fetchImpl } = fetchRoteirizado([{ status: 500 }, { status: 500 }, { status: 500 }]);
  const { esperas, dormir } = semEspera();
  const http = new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100, tentativas: 3 });
  await assert.rejects(http.get('http://x/a'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 500);
    assert.match(err.message, /HTTP 500 após 3 tentativas/);
    return true;
  });
  assert.deepEqual(esperas, [100, 200]);
});

test('limita as conexões simultâneas', async () => {
  let ativas = 0;
  let maximo = 0;
  const fetchImpl = async () => {
    ativas++;
    maximo = Math.max(maximo, ativas);
    await new Promise((r) => setTimeout(r, 10));
    ativas--;
    return new Response('ok');
  };
  const http = new HttpClient({ fetchImpl, concorrencia: 2 });
  await Promise.all(Array.from({ length: 6 }, (_, i) => http.get(`http://x/${i}`)));
  assert.equal(maximo, 2);
});
