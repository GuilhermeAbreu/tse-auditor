import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { SecaoChave } from '../../src/tipos/dominio.ts';

export type Falha = number | 'corromper' | 'corromperComEtag';
export interface FakeTse {
  base: string;
  requisicoes: string[];
  fechar: () => Promise<void>;
}

export const RAIZ_FIXTURES = fileURLToPath(new URL('../fixtures/tse', import.meta.url));

// Dados das fixtures reais (seção AC / 01066 / 0004 / 0077).
export const FX = {
  hash3220: '4a6b704a7350756e6a5a496433337049453538516932486a676159553779785542752d6d765749354f41343d',
  hash3221: '50394b614b6e4150306b5a49585533766870625955416c32685761495a53564a426a3371786d767a676c383d',
  dirSecao: (pleito: string, secao = '0077'): string => `oficial/ele2026/arquivo-urna/${pleito}/dados/ac/01066/0004/${secao}`,
  secao: (pleito: string, secao = '0077'): SecaoChave => ({ pleito, uf: 'ac', mun: '01066', zona: '0004', secao }),
};

export const lerFixture = (relativo: string): Promise<Buffer> => readFile(path.join(RAIZ_FIXTURES, relativo));

const md5 = (buf: Buffer) => createHash('md5').update(buf).digest('hex');

// Imita resultados.tse.jus.br servindo test/fixtures/tse, com ETag = MD5 como o servidor real.
// falhas: { '<sufixo do caminho>': [503, 'corromper', 'corromperComEtag', ...] }, consumidas uma por requisição.
//   número             → responde com esse status
//   'corromper'        → altera o 1º byte e mantém o ETag do original (erro de transmissão)
//   'corromperComEtag' → altera o 1º byte e calcula o ETag sobre o conteúdo alterado (arquivo trocado na origem)
export async function iniciarFakeTse({ falhas = {} }: { falhas?: Record<string, Falha[]> } = {}): Promise<FakeTse> {
  const pendentes = Object.fromEntries(Object.entries(falhas).map(([k, v]) => [k, [...v]]));
  const requisicoes: string[] = [];
  const servidor = http.createServer(async (req, res) => {
    try {
      const caminho = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
      requisicoes.push(caminho);
      const chave = Object.keys(pendentes).find((k) => caminho.endsWith(k) && pendentes[k]!.length > 0);
      const falha = chave ? pendentes[chave]!.shift() : undefined;
      if (typeof falha === 'number') {
        res.writeHead(falha);
        res.end();
        return;
      }
      let corpo: Buffer;
      try {
        const alvo = path.resolve(RAIZ_FIXTURES, `.${caminho}`);
        if (!alvo.startsWith(RAIZ_FIXTURES + path.sep)) throw new Error('fora da raiz');
        corpo = await readFile(alvo);
      } catch {
        res.writeHead(404);
        res.end('NoSuchKey');
        return;
      }
      let etag = md5(corpo);
      if (falha === 'corromper' || falha === 'corromperComEtag') {
        corpo = Buffer.from(corpo);
        corpo[0]! ^= 0xff;
        if (falha === 'corromperComEtag') etag = md5(corpo);
      }
      res.writeHead(200, { etag: `"${etag}"`, 'content-length': corpo.length });
      res.end(corpo);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
    requisicoes,
    fechar: () => new Promise<void>((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }),
  };
}
