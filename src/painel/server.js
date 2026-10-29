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

function permitido(req, porta) {
  const hosts = [`127.0.0.1:${porta}`, `localhost:${porta}`];
  if (!hosts.includes(req.headers.host)) return false;
  if (req.method === 'POST') {
    if (req.headers['x-tse-auditor'] !== '1') return false;
    const { origin } = req.headers;
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return false;
  }
  return true;
}

// Painel local: página estática, estado em JSON, estado ao vivo por SSE e controles da coleta.
// Só aceita Host/Origin locais e POST com cabeçalho próprio (defesa contra CSRF e DNS rebinding).
export function criarPainel({ obterEstado, coletor, intervaloMs = 2000 }) {
  const servidor = http.createServer(async (req, res) => {
    try {
      if (!permitido(req, servidor.address()?.port)) return json(res, 403, { erro: 'acesso negado' });
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ESTATICOS[pathname]) {
        const [arquivo, tipo] = ESTATICOS[pathname];
        const corpo = await readFile(new URL(arquivo, PUBLICO));
        res.writeHead(200, { 'content-type': tipo });
        res.end(corpo);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/estado') return json(res, 200, await obterEstado());
      if (req.method === 'GET' && pathname === '/api/eventos') return sse(req, res, obterEstado, intervaloMs);
      if (req.method === 'POST' && pathname === '/api/coleta/iniciar') {
        coletor.executar(); // roda em segundo plano
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/coleta/parar') {
        coletor.parar();
        return json(res, 200, { ok: true });
      }
      const controle = /^\/api\/uf\/([a-z]{2})\/(pausar|iniciar)$/.exec(pathname);
      if (req.method === 'POST' && controle) {
        const [, uf, acao] = controle;
        if (acao === 'pausar') coletor.pausar(uf);
        else coletor.retomar(uf); // despausa e inicia a execução se estiver parada
        return json(res, 200, { ok: true });
      }
      json(res, 404, { erro: 'não encontrado' });
    } catch (err) {
      try {
        if (res.headersSent) res.end();
        else json(res, 500, { erro: err.message });
      } catch {
        // nada a fazer
      }
    }
  });
  return servidor;
}
