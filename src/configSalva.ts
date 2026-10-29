import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PADRAO } from './config.ts';
import { UFS } from './ufs.ts';
import type { ConfigEntrada } from './tipos/dominio.ts';

const lista = (texto: string) => texto.split(',').map((x) => x.trim()).filter(Boolean);

// Última configuração aplicada (pleitos, UFs e as opções de src/coleta/opcoes.ts). Fica na pasta de configuração do
// usuário, nunca no HD. TSE_CONFIG troca o caminho (os testes usam um arquivo temporário).
export function caminhoConfigSalva(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TSE_CONFIG) return env.TSE_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tse-auditor', 'config.json');
}

// Devolve null se não houver configuração salva ou se o arquivo estiver ilegível.
export async function lerConfigSalva(caminho: string): Promise<ConfigEntrada | null> {
  let texto: string;
  try {
    texto = await readFile(caminho, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const config: unknown = JSON.parse(texto);
    return config && typeof config === 'object' && !Array.isArray(config) ? (config as ConfigEntrada) : null;
  } catch {
    return null;
  }
}

export async function salvarConfig(caminho: string, config: object): Promise<void> {
  await mkdir(path.dirname(caminho), { recursive: true });
  await writeFile(`${caminho}.part`, `${JSON.stringify(config, null, 2)}\n`);
  await rename(`${caminho}.part`, caminho);
}

// Configuração inicial do painel: as opções da linha de comando valem sobre a salva, e a salva
// sobre os padrões (o que faltar o ControleColeta completa). Sem pleito em nenhuma das duas,
// o painel abre sem configuração e mostra o formulário.
export function configInicial(
  opcoes: { pleito?: string; uf?: string; concorrencia?: number },
  salva: ConfigEntrada | null,
): { config: ConfigEntrada; origem: 'salva' | 'linha de comando' } | null {
  const flags = opcoes.pleito !== undefined || opcoes.uf !== undefined || opcoes.concorrencia !== undefined;
  if (!flags) return salva ? { config: salva, origem: 'salva' } : null;
  const pleitos = opcoes.pleito ? lista(opcoes.pleito) : salva?.pleitos;
  if (!Array.isArray(pleitos) || !pleitos.length) return null;
  return {
    config: {
      ...salva,
      pleitos,
      ufs: opcoes.uf ? lista(opcoes.uf) : salva?.ufs ?? UFS,
      concorrencia: opcoes.concorrencia ?? salva?.concorrencia ?? PADRAO.concorrencia,
    },
    origem: 'linha de comando',
  };
}
