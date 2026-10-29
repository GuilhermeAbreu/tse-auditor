import yauzl from 'yauzl';
import { buffer } from 'node:stream/consumers';
import { promisify } from 'node:util';

// Lê um zip inteiro: Map<nome da entrada, { dados: Buffer, metodo: número do método de compressão }>.
export async function lerZip(caminho) {
  const zip = await promisify(yauzl.open)(caminho, { lazyEntries: true, autoClose: false });
  const abrir = promisify(zip.openReadStream.bind(zip));
  const conteudo = new Map();
  try {
  await new Promise((ok, falha) => {
    zip.on('entry', async (e) => {
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
