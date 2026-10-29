import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PADRAO } from './config.js';
import { UFS } from './ufs.js';

const lista = (texto) => texto.split(',').map((x) => x.trim()).filter(Boolean);

// Última configuração aplicada (pleitos, UFs e as opções de src/coleta/opcoes.js). Fica na pasta de configuração do
// usuário, nunca no HD. TSE_CONFIG troca o caminho (os testes usam um arquivo temporário).
export function caminhoConfigSalva(env = process.env) {
  if (env.TSE_CONFIG) return env.TSE_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tse-auditor', 'config.json');
}

// Devolve null se não houver configuração salva ou se o arquivo estiver ilegível.
export async function lerConfigSalva(caminho) {
  let texto;
  try {
    texto = await readFile(caminho, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const config = JSON.parse(texto);
    return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
  } catch {
    return null;
  }
}

export async function salvarConfig(caminho, config) {
  await mkdir(path.dirname(caminho), { recursive: true });
  await writeFile(`${caminho}.part`, `${JSON.stringify(config, null, 2)}\n`);
  await rename(`${caminho}.part`, caminho);
}

// Configuração inicial do painel: as opções da linha de comando valem sobre a salva, e a salva
// sobre os padrões (o que faltar o ControleColeta completa). Sem pleito em nenhuma das duas,
// o painel abre sem configuração e mostra o formulário.
export function configInicial(opcoes, salva) {
  const flags = opcoes.pleito !== undefined || opcoes.uf !== undefined || opcoes.concorrencia !== undefined;
  if (!flags) return salva ? { config: salva, origem: 'salva' } : null;
  const pleitos = opcoes.pleito ? lista(opcoes.pleito) : salva?.pleitos;
  if (!pleitos?.length) return null;
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
