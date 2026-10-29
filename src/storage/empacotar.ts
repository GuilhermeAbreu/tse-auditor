import yazl from 'yazl';
import yauzl from 'yauzl';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { bytesLivres as bytesLivresPadrao } from './disco.ts';

// Erros de sistema (EIO, ENOTCONN, EMFILE, EACCES...) trazem code; os do yauzl, de formato, não.
export function ehErroDeFormatoZip(err) {
  return !err?.code;
}

const abrirZip = promisify(yauzl.open);

export class ZipCorrompidoError extends Error {
  constructor(caminhoZip, causa) {
    super(`zip existente ilegível (${causa.message}): ${caminhoZip}`);
    this.caminhoZip = caminhoZip;
    this.cause = causa;
  }
}

async function listarArquivos(pasta) {
  let itens;
  try {
    itens = await readdir(pasta, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return itens
    .filter((d) => d.isFile() && !d.name.endsWith('.part'))
    .map((d) => path.relative(pasta, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort();
}

async function lerEntradas(caminhoZip) {
  const zip = await abrirZip(caminhoZip, { lazyEntries: true, autoClose: false });
  const entradas = [];
  try {
    await new Promise((ok, falha) => {
      zip.on('entry', (e) => {
        entradas.push(e);
        zip.readEntry();
      });
      zip.on('end', ok);
      zip.on('error', falha);
      zip.readEntry();
    });
  } catch (err) {
    zip.close();
    throw err;
  }
  return { zip, entradas };
}

// Nomes das entradas de um zip (só o diretório central). Zip ausente ou ilegível dá conjunto vazio;
// o caso ilegível é tratado por empacotarMunicipio (ZipCorrompidoError).
export async function listarNomesZip(caminhoZip) {
  let lido;
  try {
    lido = await lerEntradas(caminhoZip);
  } catch (err) {
    if (err.code === 'ENOENT' || ehErroDeFormatoZip(err)) return new Set();
    throw err;
  }
  lido.zip.close();
  return new Set(lido.entradas.map((e) => e.fileName));
}

async function conferirZip(caminho, esperado) {
  const { zip, entradas } = await lerEntradas(caminho);
  zip.close();
  const problemas = [];
  if (entradas.length !== esperado.size) problemas.push(`${entradas.length} entradas, esperado ${esperado.size}`);
  for (const e of entradas) {
    if (esperado.get(e.fileName) !== e.uncompressedSize) problemas.push(`${e.fileName}: ${e.uncompressedSize} bytes`);
  }
  if (problemas.length) throw new Error(`zip inconsistente ${caminho}: ${problemas.join('; ')}`);
}

async function sincronizarPasta(pasta) {
  try {
    const d = await open(pasta, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch (err) {
    // Alguns sistemas de arquivos não suportam fsync de diretório.
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP', 'ENOSYS'].includes(err.code)) throw err;
  }
}

// Junta o staging de um município num .zip sem compressão (o NTFS sofre com milhões de arquivos
// pequenos; o conteúdo fica byte a byte igual ao original). Se o zip já existe, as entradas antigas
// são copiadas e as do staging têm prioridade. Escreve em .part, confere, renomeia e apaga o staging.
export async function empacotarMunicipio({
  pastaStaging, caminhoZip, bytesLivres = bytesLivresPadrao, minLivreBytes = 0,
}) {
  const novos = await listarArquivos(pastaStaging);
  const esperado = new Map();
  let tamanhoStaging = 0;
  for (const nome of novos) {
    const { size } = await stat(path.join(pastaStaging, nome));
    esperado.set(nome, size);
    tamanhoStaging += size;
  }

  let antigo = null;
  let tamanhoAntigo = 0;
  try {
    tamanhoAntigo = (await stat(caminhoZip)).size;
    antigo = await lerEntradas(caminhoZip);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // sem zip anterior
    } else if (!ehErroDeFormatoZip(err)) {
      throw err;
    } else {
      await rename(caminhoZip, `${caminhoZip}.corrompido-${Date.now()}`);
      throw new ZipCorrompidoError(caminhoZip, err);
    }
  }

  const temporario = `${caminhoZip}.part`;
  let fh;
  let leitura = null;
  try {
    await mkdir(path.dirname(caminhoZip), { recursive: true });
    const necessario = tamanhoAntigo + tamanhoStaging + minLivreBytes;
    if ((await bytesLivres(path.dirname(caminhoZip))) < necessario) {
      throw new Error(`espaço insuficiente para empacotar ${caminhoZip}: precisa de ${necessario} bytes`);
    }

    fh = await open(temporario, 'w');
    const zip = new yazl.ZipFile();
    const saida = fh.createWriteStream({ autoClose: false });
    const falhou = new Promise((_, rejeitar) => {
      zip.on('error', rejeitar);
      zip.outputStream.on('error', rejeitar);
      saida.on('error', rejeitar);
    });
    falhou.catch(() => {});
    const aguardar = (x) => Promise.race([finished(x), falhou]);
    try {
      zip.outputStream.pipe(saida);
      if (antigo) {
        const abrir = promisify(antigo.zip.openReadStream.bind(antigo.zip));
        for (const e of antigo.entradas) {
          if (e.fileName.endsWith('/') || esperado.has(e.fileName)) continue;
          esperado.set(e.fileName, e.uncompressedSize);
          leitura = await abrir(e);
          zip.addReadStream(leitura, e.fileName, { compress: false, size: e.uncompressedSize, mtime: e.getLastModDate() });
          await aguardar(leitura);
          leitura = null;
        }
      }
      for (const nome of novos) zip.addFile(path.join(pastaStaging, nome), nome, { compress: false });
      zip.end();
      await Promise.race([once(saida, 'finish'), falhou]);
      await fh.sync();
      saida.destroy(); // com autoClose false, libera o stream para o fh.close() não ficar esperando
    } catch (err) {
      leitura?.destroy();
      saida.destroy();
      zip.outputStream.destroy();
      throw err;
    }
    await fh.close();
    fh = null;

    await conferirZip(temporario, esperado);
    await rename(temporario, caminhoZip);
    await sincronizarPasta(path.dirname(caminhoZip));
  } catch (err) {
    await fh?.close().catch(() => {});
    await rm(temporario, { force: true }).catch(() => {});
    throw err;
  } finally {
    antigo?.zip.close();
  }

  await rm(pastaStaging, { recursive: true, force: true });
  return { entradas: esperado.size, bytes: (await stat(caminhoZip)).size };
}
