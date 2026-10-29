import { stat, statfs } from 'node:fs/promises';

const CODIGOS_DE_VOLUME = new Set(['EIO', 'ENOTCONN', 'ENXIO', 'ENODEV', 'EROFS']);

export class VolumeError extends Error {}

export function ehErroDeVolume(err: unknown): boolean {
  return err instanceof VolumeError || CODIGOS_DE_VOLUME.has((err as NodeJS.ErrnoException | undefined)?.code ?? '');
}

export async function garantirVolume(pasta: string): Promise<void> {
  try {
    await stat(pasta);
  } catch (err) {
    throw new VolumeError(`pasta de dados inacessível (${(err as NodeJS.ErrnoException).code}): ${pasta}. O HD está conectado?`);
  }
}

export async function bytesLivres(pasta: string): Promise<number> {
  const s = await statfs(pasta);
  return s.bavail * s.bsize;
}
