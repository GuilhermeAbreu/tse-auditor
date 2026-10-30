// Preferências do aplicativo (não da coleta): por ora, se a coleta começa sozinha quando o serviço sobe.
// Ficam ao lado da configuração salva (~/.config/tse-auditor/preferencias.json), nunca no HD.
import path from 'node:path';
import { caminhoConfigSalva, lerConfigSalva, salvarConfig } from './configSalva.ts';

export interface Preferencias {
  iniciarAoLigar: boolean | null; // null = ainda não perguntado
}

export const caminhoPreferencias = (arquivoConfig = caminhoConfigSalva()) => path.join(path.dirname(arquivoConfig), 'preferencias.json');

export async function lerPreferencias(caminho: string): Promise<Preferencias> {
  const p = (await lerConfigSalva(caminho)) as Partial<Preferencias> | null;
  return { iniciarAoLigar: typeof p?.iniciarAoLigar === 'boolean' ? p.iniciarAoLigar : null };
}

// Aceita só os campos conhecidos, com o tipo certo; devolve null se o corpo for inválido.
export function validarPreferencias(corpo: unknown): Preferencias | null {
  const v = (corpo as Partial<Preferencias> | null)?.iniciarAoLigar;
  return typeof v === 'boolean' ? { iniciarAoLigar: v } : null;
}

export const salvarPreferencias = (caminho: string, p: Preferencias) => salvarConfig(caminho, p);
