import http from 'node:http';
import { readFile } from 'node:fs/promises';

const PUBLICO = new URL('./public/', import.meta.url);
const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/estilo.css': ['estilo.css', 'text/css; charset=utf-8'],
};

function json(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

function sse(req, res, obterEstado, intervaloMs) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let ativo = true;
  let timer;
  const enviar = async () => {
    if (!ativo) return;
    try {
      res.write(`data: ${JSON.stringify(await obterEstado())}\n\n`);
    } catch (err) {
      res.write(`event: falha\ndata: ${JSON.stringify(err.message)}\n\n`);
    }
    if (ativo) timer = setTimeout(enviar, intervaloMs);
  };
  req.on('close', () => {
    ativo = false;
    clearTimeout(timer);
  });
  enviar();
}

// Painel local: página estática, estado em JSON, estado ao vivo por SSE e pausar/iniciar por UF.
export function criarPainel({ obterEstado, coletor, intervaloMs = 2000 }) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ESTATICOS[pathname]) {
        const [arquivo, tipo] = ESTATICOS[pathname];
        res.writeHead(200, { 'content-type': tipo });
        res.end(await readFile(new URL(arquivo, PUBLICO)));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/estado') return json(res, 200, await obterEstado());
      if (req.method === 'GET' && pathname === '/api/eventos') return sse(req, res, obterEstado, intervaloMs);
      const controle = /^\/api\/uf\/([a-z]{2})\/(pausar|iniciar)$/.exec(pathname);
      if (req.method === 'POST' && controle) {
        const [, uf, acao] = controle;
        if (acao === 'pausar') coletor.pausar(uf);
        else coletor.retomar(uf); // a execução roda em segundo plano e nunca rejeita
        return json(res, 200, { ok: true });
      }
      json(res, 404, { erro: 'não encontrado' });
    } catch (err) {
      json(res, 500, { erro: err.message });
    }
  });
}
