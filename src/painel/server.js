import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { detalharSecao, FilaAnalise, listarUfs, ranking, turnosPelasEleicoes } from './analise.js';
import { UFS } from '../ufs.js';

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

// O intervalo é lido a cada envio: mudar a configuração muda o ritmo das conexões abertas.
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
    if (ativo) timer = setTimeout(enviar, intervaloMs());
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

const LIMITE_CORPO = 64 * 1024;

class CorpoInvalido extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

async function lerJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new CorpoInvalido(415, 'envie JSON (content-type: application/json)');
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > LIMITE_CORPO) throw new CorpoInvalido(413, 'corpo grande demais');
    partes.push(parte);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8'));
  } catch {
    throw new CorpoInvalido(400, 'JSON inválido');
  }
}

async function aplicarConfig(req, res, controle) {
  let corpo;
  try {
    corpo = await lerJson(req);
  } catch (err) {
    if (!(err instanceof CorpoInvalido)) throw err;
    if (err.status === 413) res.setHeader('connection', 'close');
    return json(res, err.status, { erro: err.message });
  }
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return json(res, 400, { erro: 'envie um objeto JSON' });
  const { iniciar, ...config } = corpo;
  try {
    const atual = await controle.aplicar(config, { iniciar: iniciar === true });
    return json(res, 200, { ok: true, atual });
  } catch (err) {
    return json(res, 400, { erro: err.message });
  }
}

// Painel local: página estática, estado em JSON, estado ao vivo por SSE, configuração e controles da coleta.
// Só aceita Host/Origin locais e POST com cabeçalho próprio (defesa contra CSRF e DNS rebinding).
export function criarPainel({ controle, fila = new FilaAnalise({ turnosDe: turnosPelasEleicoes(controle.eleicoes) }) }) {
  const obterEstado = () => controle.obterEstado();
  const dados = () => controle.configuracao()?.dados ?? null;
  // automação: UF cuja coleta termina nesta execução entra na fila de análise (analisarAoConcluir)
  const vigia = setInterval(async () => {
    try {
      const cfg = controle.configuracao();
      if (cfg) fila.observar(await obterEstado(), cfg.dados, cfg.analisarAoConcluir !== false);
    } catch {
      // estado indisponível: tenta na próxima
    }
  }, 15_000);
  vigia.unref();
  const intervaloMs = () => controle.intervaloPainelMs();
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
      if (req.method === 'GET' && pathname === '/api/config') {
        return json(res, 200, {
          atual: controle.configuracao(),
          padroes: controle.padroes,
          limites: controle.limites(),
          disponiveis: controle.disponiveis(),
          somenteLeitura: { ...controle.somenteLeitura(), porta: servidor.address()?.port },
        });
      }
      if (req.method === 'POST' && pathname === '/api/config') return aplicarConfig(req, res, controle);

      const global = /^\/api\/coleta\/(iniciar|parar)$/.exec(pathname);
      const daUf = /^\/api\/uf\/([a-z]{2})\/(pausar|iniciar)$/.exec(pathname);
      if (req.method === 'POST' && (global || daUf)) {
        const { coletor } = controle;
        if (!coletor) return json(res, 409, { erro: 'sem configuração' });
        if (global?.[1] === 'iniciar') coletor.executar(); // roda em segundo plano
        else if (global) coletor.parar();
        else if (daUf[2] === 'pausar') coletor.pausar(daUf[1]);
        else coletor.retomar(daUf[1]); // despausa e inicia a execução se estiver parada
        return json(res, 200, { ok: true });
      }
      if (pathname.startsWith('/api/analise/')) return analise(req, res, pathname, new URL(req.url, 'http://localhost').searchParams);
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
  servidor.on('close', () => clearInterval(vigia));
  servidor.fila = fila;

  async function analise(req, res, pathname, q) {
    if (req.method === 'GET' && pathname === '/api/analise/jobs') return json(res, 200, fila.listar());
    const pasta = dados();
    if (!pasta) return json(res, 409, { erro: 'sem configuração' });
    if (req.method === 'GET' && pathname === '/api/analise/ufs') return json(res, 200, { ufs: await listarUfs(pasta) });
    const m = /^\/api\/analise\/([a-z]{2})\/(ranking|executar|secao\/(\d{1,6})\/(\d{1,6})\/(\d{1,6}))$/.exec(pathname);
    if (!m || !UFS.includes(m[1])) return json(res, 404, { erro: 'não encontrado' });
    const [, uf, acao, mun, zona, secao] = m;
    if (req.method === 'POST' && acao === 'executar') return json(res, 202, { ok: true, job: fila.enfileirar(uf, pasta) });
    if (req.method !== 'GET') return json(res, 405, { erro: 'método não permitido' });
    if (acao === 'ranking') {
      return json(res, 200, await ranking(pasta, uf, { sinal: q.get('sinal') ?? '', limite: q.get('limite') ?? 200 }));
    }
    if (acao === 'executar') return json(res, 405, { erro: 'use POST' });
    return json(res, 200, await detalharSecao(pasta, uf, { mun, zona, secao }));
  }
  return servidor;
}
