// Navegador de pastas do painel (escolher onde salvar os arquivos): lista subpastas de um caminho absoluto,
// atalhos (pasta pessoal, discos montados, letras de unidade no Windows) e cria uma pasta nova a pedido do usuário.
// Só nomes de pastas e espaço livre; nunca lê conteúdo de arquivos.
import { access, constants, mkdir, readdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class PastaInvalida extends Error {}

export interface Atalho { rotulo: string; caminho: string }
export interface ListaPastas {
  caminho: string; pai: string | null; pastas: string[]; truncado: boolean;
  livreBytes: number | null; gravavel: boolean; atalhos: Atalho[];
}

export const MAX_PASTAS = 500;

function normalizar(caminho: string): string {
  const c = caminho.trim();
  if (!c || !path.isAbsolute(c) || c.includes('\0')) throw new PastaInvalida(`o caminho precisa ser absoluto: ${JSON.stringify(caminho)}`);
  return path.resolve(c);
}

const existeDir = (c: string) => stat(c).then((s) => s.isDirectory(), () => false);

async function subpastas(c: string): Promise<string[]> {
  try {
    return (await readdir(c, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch {
    return [];
  }
}

// Pasta pessoal, discos montados (Linux: /media/<usuário>/*, /run/media/<usuário>/*, /mnt/*) e unidades do Windows.
export async function atalhos(plataforma = process.platform): Promise<Atalho[]> {
  const r: Atalho[] = [{ rotulo: 'Pasta pessoal', caminho: os.homedir() }];
  if (plataforma === 'win32') {
    for (const letra of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const raiz = `${letra}:\\`;
      if (await existeDir(raiz)) r.push({ rotulo: `Unidade ${letra}:`, caminho: raiz });
    }
    return r;
  }
  const usuario = os.userInfo().username;
  for (const base of [`/media/${usuario}`, `/run/media/${usuario}`, '/mnt', '/Volumes']) {
    for (const nome of (await subpastas(base)).sort()) r.push({ rotulo: nome, caminho: path.join(base, nome) });
  }
  return r;
}

export async function listarPastas(caminho?: string | null): Promise<ListaPastas> {
  const c = normalizar(caminho || os.homedir());
  if (!(await existeDir(c))) throw new PastaInvalida(`pasta não encontrada: ${c}`);
  const todas = (await subpastas(c)).sort((a, b) => a.localeCompare(b, 'pt', { sensitivity: 'base', numeric: true }));
  const pai = path.dirname(c);
  let livreBytes: number | null = null;
  try {
    const s = await statfs(c);
    livreBytes = s.bavail * s.bsize;
  } catch {
    // sem informação de espaço
  }
  const gravavel = await access(c, constants.W_OK).then(() => true, () => false);
  return { caminho: c, pai: pai === c ? null : pai, pastas: todas.slice(0, MAX_PASTAS), truncado: todas.length > MAX_PASTAS, livreBytes, gravavel, atalhos: await atalhos() };
}

// Cria <caminho>/<nome>; o nome é um único componente (sem barras, sem "." ou "..").
export async function criarPasta(caminho: string, nome: string): Promise<string> {
  const base = normalizar(caminho);
  const n = String(nome ?? '').trim();
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n) || n.length > 120) throw new PastaInvalida(`nome de pasta inválido: ${JSON.stringify(nome)}`);
  if (!(await existeDir(base))) throw new PastaInvalida(`pasta não encontrada: ${base}`);
  const nova = path.join(base, n);
  try {
    await mkdir(nova);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new PastaInvalida(`já existe: ${nova}`);
    if (code === 'EACCES' || code === 'EPERM') throw new PastaInvalida(`sem permissão para criar em ${base}`);
    throw err;
  }
  return nova;
}
