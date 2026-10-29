import type { SecaoChave, Templates } from '../tipos/dominio.ts';

type Valores = Record<string, string | number | null | undefined>;

const p6 = (pleito: string | number) => String(pleito).padStart(6, '0');

export const nomeConfigSecoes = ({ pleito, uf }: { pleito: string; uf: string }) => `${uf}-p${p6(pleito)}-cs.json`;

export const nomeIndiceSecao = ({ pleito, uf, mun, zona, secao }: SecaoChave) =>
  `p${p6(pleito)}-${uf}-m${mun}-z${zona}-s${secao}-aux.json`;

function preencher(template: string, valores: Valores): string {
  return template.replace(/<(\w+)>/g, (_, chave: string) => {
    if (valores[chave] == null) throw new Error(`template sem valor para <${chave}>: ${template}`);
    return String(valores[chave]);
  });
}

export type SecaoComCiclo = SecaoChave & { ciclo: string };

export interface Urls {
  configSecoes(p: { ciclo: string; pleito: string; uf: string }): string;
  indiceSecao(s: SecaoComCiclo): string;
  arquivo(s: SecaoComCiclo, hash: string, nome: string): string;
}

// Monta as URLs a partir dos templates do ele-c.json, para não fixar o formato de um ano no código.
export function criarUrls({ base, ambiente, templates }: { base: string; ambiente: string; templates: Templates }): Urls {
  const dirSecao = ({ ciclo, pleito, uf, mun, zona, secao }: SecaoComCiclo) =>
    preencher(templates.aux, { base, ambiente, ciclo, cd_pleito: pleito, uf, municipio: mun, zona, secao });
  return {
    configSecoes: ({ ciclo, pleito, uf }) =>
      `${preencher(templates.cs, { base, ambiente, ciclo, cd_pleito: pleito, uf })}/${nomeConfigSecoes({ pleito, uf })}`,
    indiceSecao: (s) => `${dirSecao(s)}/${nomeIndiceSecao(s)}`,
    arquivo: (s, hash, nome) => `${dirSecao(s)}/${hash}/${nome}`,
  };
}
