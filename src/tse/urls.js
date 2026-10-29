const p6 = (pleito) => String(pleito).padStart(6, '0');

export const nomeConfigSecoes = ({ pleito, uf }) => `${uf}-p${p6(pleito)}-cs.json`;

export const nomeIndiceSecao = ({ pleito, uf, mun, zona, secao }) =>
  `p${p6(pleito)}-${uf}-m${mun}-z${zona}-s${secao}-aux.json`;

function preencher(template, valores) {
  return template.replace(/<(\w+)>/g, (_, chave) => {
    if (!(chave in valores)) throw new Error(`template sem valor para <${chave}>: ${template}`);
    return valores[chave];
  });
}

// Monta as URLs a partir dos templates do ele-c.json, para não fixar o formato de um ano no código.
export function criarUrls({ base, ambiente, templates }) {
  const dirSecao = ({ ciclo, pleito, uf, mun, zona, secao }) =>
    preencher(templates.aux, { base, ambiente, ciclo, cd_pleito: pleito, uf, municipio: mun, zona, secao });
  return {
    configSecoes: ({ ciclo, pleito, uf }) =>
      `${preencher(templates.cs, { base, ambiente, ciclo, cd_pleito: pleito, uf })}/${nomeConfigSecoes({ pleito, uf })}`,
    indiceSecao: (s) => `${dirSecao(s)}/${nomeIndiceSecao(s)}`,
    arquivo: (s, hash, nome) => `${dirSecao(s)}/${hash}/${nome}`,
  };
}
