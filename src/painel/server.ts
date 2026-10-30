import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { detalharSecao, FilaAnalise, listarUfs, ranking, turnosPelasEleicoes } from './analise.ts';
import { comparativo, distribuicao, dispersao, mapa, nomesCandidatos, ParametroInvalido, ufsComparacao } from './graficos.ts';
import { PADRAO } from '../config.ts';
import { UFS } from '../ufs.ts';
import type { AddressInfo } from 'node:net';
import type { ControleColeta } from '../coleta/controle.ts';
import type { EstadoPainel } from '../tipos/dominio.ts';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
export type ServidorPainel = http.Server & { fila: FilaAnalise };
// O que o painel usa do ControleColeta (os testes passam um dublê).
export type ControlePainel = Pick<ControleColeta,
  'eleicoes' | 'obterEstado' | 'configuracao' | 'intervaloPainelMs' | 'padroes' | 'limites' | 'disponiveis' | 'somenteLeitura' | 'aplicar' | 'coletor'>;

const PUBLICO = new URL('./public/', import.meta.url);
const ESTATICOS: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/estilo.css': ['estilo.css', 'text/css; charset=utf-8'],
  '/mapa-br.json': ['mapa-br.json', 'application/json; charset=utf-8'],
};
// Bibliotecas servidas de node_modules (sem CDN).
const VENDOR: Record<string, [string, string]> = {
  '/vendor/echarts.min.js': [createRequire(import.meta.url).resolve('echarts/dist/echarts.min.js'), 'text/javascript; charset=utf-8'],
};

function json(res: Res, status: number, corpo: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

// O intervalo é lido a cada envio: mudar a configuração muda o ritmo das conexões abertas.
function sse(req: Req, res: Res, obterEstado: () => Promise<EstadoPainel>, intervaloMs: () => number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let ativo = true;
  let timer: NodeJS.Timeout | undefined;
  const enviar = async () => {
    if (!ativo) return;
    try {
      res.write(`data: ${JSON.stringify(await obterEstado())}\n\n`);
    } catch (err) {
      res.write(`event: falha\ndata: ${JSON.stringify((err as Error).message)}\n\n`);
    }
    if (ativo) timer = setTimeout(enviar, intervaloMs());
  };
  req.on('close', () => {
    ativo = false;
    clearTimeout(timer);
  });
  enviar();
}

function permitido(req: Req, porta: number | undefined): boolean {
  const hosts = [`127.0.0.1:${porta}`, `localhost:${porta}`];
  if (!hosts.includes(req.headers.host ?? '')) return false;
  if (req.method === 'POST') {
    if (req.headers['x-tse-auditor'] !== '1') return false;
    const { origin } = req.headers;
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return false;
  }
  return true;
}

const LIMITE_CORPO = 64 * 1024;

class CorpoInvalido extends Error {
  status: number;

  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}

async function lerJson(req: Req): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new CorpoInvalido(415, 'envie JSON (content-type: application/json)');
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of req as AsyncIterable<Buffer>) {
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

async function aplicarConfig(req: Req, res: Res, controle: ControlePainel): Promise<void> {
  let corpo: unknown;
  try {
    corpo = await lerJson(req);
  } catch (err) {
    if (!(err instanceof CorpoInvalido)) throw err;
    if (err.status === 413) res.setHeader('connection', 'close');
    return json(res, err.status, { erro: err.message });
  }
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return json(res, 400, { erro: 'envie um objeto JSON' });
  const { iniciar, ...config } = corpo as Record<string, unknown>;
  try {
    const atual = await controle.aplicar(config, { iniciar: iniciar === true });
    return json(res, 200, { ok: true, atual });
  } catch (err) {
    return json(res, 400, { erro: (err as Error).message });
  }
}

// Painel local: página estática, estado em JSON, estado ao vivo por SSE, configuração e controles da coleta.
// Só aceita Host/Origin locais e POST com cabeçalho próprio (defesa contra CSRF e DNS rebinding).
export function criarPainel({ controle, fila = new FilaAnalise({ turnosDe: turnosPelasEleicoes(controle.eleicoes) }) }: {
  controle: ControlePainel;
  fila?: FilaAnalise;
}): ServidorPainel {
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
  const porta = () => (servidor.address() as AddressInfo | null)?.port;
  const servidor = http.createServer(async (req, res) => {
    try {
      if (!permitido(req, porta())) return json(res, 403, { erro: 'acesso negado' });
      const { pathname } = new URL(req.url!, 'http://localhost');
      if (req.method === 'GET' && ESTATICOS[pathname]) {
        const [arquivo, tipo] = ESTATICOS[pathname];
        const corpo = await readFile(new URL(arquivo, PUBLICO));
        res.writeHead(200, { 'content-type': tipo });
        res.end(corpo);
        return;
      }
      if (req.method === 'GET' && VENDOR[pathname]) {
        const [arquivo, tipo] = VENDOR[pathname];
        res.writeHead(200, { 'content-type': tipo, 'cache-control': 'max-age=86400' });
        res.end(await readFile(arquivo));
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
          somenteLeitura: { ...controle.somenteLeitura(), porta: porta() },
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
        else if (daUf![2] === 'pausar') coletor.pausar(daUf![1]!);
        else coletor.retomar(daUf![1]!); // despausa e inicia a execução se estiver parada
        return json(res, 200, { ok: true });
      }
      if (pathname.startsWith('/api/analise/')) return analise(req, res, pathname, new URL(req.url!, 'http://localhost').searchParams);
      json(res, 404, { erro: 'não encontrado' });
    } catch (err) {
      try {
        if (res.headersSent) res.end();
        else json(res, 500, { erro: (err as Error).message });
      } catch {
        // nada a fazer
      }
    }
  });
  servidor.on('close', () => clearInterval(vigia));
  const painel = Object.assign(servidor, { fila });

  async function analise(req: Req, res: Res, pathname: string, q: URLSearchParams): Promise<void> {
    if (req.method === 'GET' && pathname === '/api/analise/jobs') return json(res, 200, fila.listar());
    const pasta = dados();
    if (!pasta) return json(res, 409, { erro: 'sem configuração' });
    if (req.method === 'GET' && pathname === '/api/analise/ufs') return json(res, 200, { ufs: await listarUfs(pasta) });
    const g = /^\/api\/analise\/(comparativo|ufs-comparacao|dispersao|distribuicao|mapa|candidatos)$/.exec(pathname)?.[1];
    if (g) {
      if (req.method !== 'GET') return json(res, 405, { erro: 'método não permitido' });
      const ufs = (q.get('ufs') ?? '').toLowerCase().split(',').map((u) => u.trim()).filter(Boolean);
      const el = controle.eleicoes;
      try {
        if (g === 'comparativo') return json(res, 200, await comparativo(pasta, { escopo: q.get('escopo'), ufs, zona: q.get('zona'), mun: q.get('mun') }, el));
        if (g === 'ufs-comparacao') return json(res, 200, await ufsComparacao(pasta, { ufs }, el));
        if (g === 'dispersao') {
          return json(res, 200, await dispersao(pasta, { uf: (q.get('uf') ?? '').toLowerCase(), nivel: q.get('nivel') ?? 'zona', candidato: q.get('candidato') }, el));
        }
        if (g === 'distribuicao') return json(res, 200, await distribuicao(pasta, { ufs, metrica: q.get('metrica') ?? 'mesario' }, el));
        if (g === 'mapa') return json(res, 200, await mapa(pasta, { turno: q.get('turno') ?? 1 }, el));
        const c = controle as Partial<{ base: string; ambiente: string }>;
        return json(res, 200, await nomesCandidatos(el, { base: c.base ?? PADRAO.base, ambiente: c.ambiente ?? PADRAO.ambiente }));
      } catch (err) {
        if (err instanceof ParametroInvalido) return json(res, 400, { erro: err.message });
        throw err;
      }
    }
    const m = /^\/api\/analise\/([a-z]{2})\/(ranking|executar|secao\/(\d{1,6})\/(\d{1,6})\/(\d{1,6}))$/.exec(pathname);
    if (!m || !UFS.includes(m[1]!)) return json(res, 404, { erro: 'não encontrado' });
    const [, uf, acao, mun, zona, secao] = m as unknown as [string, string, string, string, string, string];
    if (req.method === 'POST' && acao === 'executar') return json(res, 202, { ok: true, job: fila.enfileirar(uf, pasta) });
    if (req.method !== 'GET') return json(res, 405, { erro: 'método não permitido' });
    if (acao === 'ranking') {
      return json(res, 200, await ranking(pasta, uf, { sinal: q.get('sinal') ?? '', limite: q.get('limite') ?? 200 }));
    }
    if (acao === 'executar') return json(res, 405, { erro: 'use POST' });
    return json(res, 200, await detalharSecao(pasta, uf, { mun, zona, secao }));
  }
  return painel;
}
