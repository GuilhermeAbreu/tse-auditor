import yauzl from 'yauzl';
import { buffer } from 'node:stream/consumers';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';

// Lê um zip inteiro: Map<nome da entrada, { dados: Buffer, metodo: número do método de compressão }>.
export async function lerZip(caminho: string): Promise<Map<string, { dados: Buffer; metodo: number }>> {
  const abrirZip = promisify(yauzl.open) as (caminho: string, opcoes: yauzl.Options) => Promise<yauzl.ZipFile>;
  const zip = await abrirZip(caminho, { lazyEntries: true, autoClose: false });
  const abrir = promisify(zip.openReadStream.bind(zip)) as (e: yauzl.Entry) => Promise<Readable>;
  const conteudo = new Map<string, { dados: Buffer; metodo: number }>();
  try {
    await new Promise<void>((ok, falha) => {
      zip.on('entry', async (e: yauzl.Entry) => {
        try {
          conteudo.set(e.fileName, { dados: await buffer(await abrir(e)), metodo: e.compressionMethod });
          zip.readEntry();
        } catch (err) {
          falha(err);
        }
      });
      zip.on('end', ok);
      zip.on('error', falha);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return conteudo;
}
