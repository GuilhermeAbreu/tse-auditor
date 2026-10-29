import yazl from 'yazl';
import yauzl from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const abrirZip = promisify(yauzl.open);

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
  await new Promise((ok, falha) => {
    zip.on('entry', (e) => {
      entradas.push(e);
      zip.readEntry();
    });
    zip.on('end', ok);
    zip.on('error', falha);
    zip.readEntry();
  });
  return { zip, entradas };
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

// Junta o staging de um município num .zip sem compressão (o NTFS sofre com milhões de arquivos
// pequenos; o conteúdo fica byte a byte igual ao original). Se o zip já existe, as entradas antigas
// são copiadas e as do staging têm prioridade. Escreve em .part, confere, renomeia e apaga o staging.
export async function empacotarMunicipio({ pastaStaging, caminhoZip }) {
  const novos = await listarArquivos(pastaStaging);
  const esperado = new Map();
  for (const nome of novos) esperado.set(nome, (await stat(path.join(pastaStaging, nome))).size);

  let antigo = null;
  try {
    antigo = await lerEntradas(caminhoZip);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await mkdir(path.dirname(caminhoZip), { recursive: true });
  const temporario = `${caminhoZip}.part`;
  const zip = new yazl.ZipFile();
  const saida = createWriteStream(temporario);
  zip.outputStream.pipe(saida);
  try {
    if (antigo) {
      const abrir = promisify(antigo.zip.openReadStream.bind(antigo.zip));
      for (const e of antigo.entradas) {
        if (e.fileName.endsWith('/') || esperado.has(e.fileName)) continue;
        esperado.set(e.fileName, e.uncompressedSize);
        const leitura = await abrir(e);
        zip.addReadStream(leitura, e.fileName, { compress: false, size: e.uncompressedSize, mtime: e.getLastModDate() });
        await finished(leitura);
      }
    }
    for (const nome of novos) zip.addFile(path.join(pastaStaging, nome), nome, { compress: false });
    zip.end();
    await finished(saida);
  } finally {
    antigo?.zip.close();
  }

  await conferirZip(temporario, esperado);
  await rename(temporario, caminhoZip);
  await rm(pastaStaging, { recursive: true, force: true });
  return { entradas: esperado.size, bytes: (await stat(caminhoZip)).size };
}
