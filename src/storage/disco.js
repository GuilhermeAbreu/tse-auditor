import { stat, statfs } from 'node:fs/promises';

const CODIGOS_DE_VOLUME = new Set(['EIO', 'ENOTCONN', 'ENXIO', 'ENODEV', 'EROFS']);

export class VolumeError extends Error {}

export function ehErroDeVolume(err) {
  return err instanceof VolumeError || CODIGOS_DE_VOLUME.has(err?.code);
}

export async function garantirVolume(pasta) {
  try {
    await stat(pasta);
  } catch (err) {
    throw new VolumeError(`pasta de dados inacessível (${err.code}): ${pasta}. O HD está conectado?`);
  }
}

export async function bytesLivres(pasta) {
  const s = await statfs(pasta);
  return s.bavail * s.bsize;
}
