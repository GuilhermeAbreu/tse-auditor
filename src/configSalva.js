import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Última configuração aplicada (pleitos, UFs, concorrência). Fica na pasta de configuração do
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
    const { pleitos, ufs, concorrencia } = JSON.parse(texto);
    return { pleitos, ufs, concorrencia };
  } catch {
    return null;
  }
}

export async function salvarConfig(caminho, { pleitos, ufs, concorrencia }) {
  await mkdir(path.dirname(caminho), { recursive: true });
  await writeFile(`${caminho}.part`, `${JSON.stringify({ pleitos, ufs, concorrencia }, null, 2)}\n`);
  await rename(`${caminho}.part`, caminho);
}
