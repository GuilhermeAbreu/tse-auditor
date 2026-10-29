import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const BASE = new URL('../fixtures/tse/oficial/ele2026/arquivo-urna/', import.meta.url).pathname;

// Arquivo de urna real da seção AC 01066/0004/0077 ('bu' | 'rdv' | 'log' | 'vota').
export function arquivoUrna(pleito: string | number, tp: 'bu' | 'rdv' | 'log' | 'vota'): Buffer {
  const pasta = path.join(BASE, String(pleito), 'dados/ac/01066/0004/0077');
  const hash = readdirSync(pasta, { withFileTypes: true }).find((d) => d.isDirectory())!.name;
  const ext = { bu: 'bu.dat', rdv: 'rdv.dat', log: 'log.jez', vota: 'vota.vsc' }[tp];
  return readFileSync(path.join(pasta, hash, `o0${pleito}ac0106600040077-${ext}`));
}
