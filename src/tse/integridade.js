import { createHash } from 'node:crypto';

// Cadeia de integridade dos arquivos de urna publicados pelo TSE (confirmada em 2026):
//   hash do diretório = hex(base64(sha256(-vota.vsc)))
//   o .vsc (ASN.1 assinado) contém o sha512 de bu.dat, rdv.dat e log.jez
// A verificação da assinatura do .vsc fica na etapa de verificação, não na coleta.

export const md5 = (buf) => createHash('md5').update(buf).digest('hex');
export const sha512Hex = (buf) => createHash('sha512').update(buf).digest('hex');

export function digestoDoDiretorio(hashDiretorio) {
  const base64 = Buffer.from(hashDiretorio, 'hex').toString('ascii');
  // O TSE usa '-' no lugar de '/' (confirmado nas fixtures); '_' no lugar de '+' é suposição, ainda não visto.
  return Buffer.from(base64.replaceAll('-', '/').replaceAll('_', '+'), 'base64');
}

export function vscConfereComDiretorio(vsc, hashDiretorio) {
  const esperado = digestoDoDiretorio(hashDiretorio);
  return esperado.length === 32 && createHash('sha256').update(vsc).digest().equals(esperado);
}

export function vscContemSha512(vsc, conteudo) {
  return vsc.includes(createHash('sha512').update(conteudo).digest());
}

// ETag do armazenamento do TSE é o MD5 do arquivo; ETag de upload multipart ("...-N") não é.
export function md5DoEtag(etag) {
  const m = /^(?:W\/)?"?([0-9a-f]{32})"?$/i.exec(etag ?? '');
  return m ? m[1].toLowerCase() : null;
}
