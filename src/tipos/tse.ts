// Formato cru dos JSON publicados pelo TSE (só os campos que o projeto lê).

// ele-c.json
export interface EleCJson {
  arq?: { tp: string; dir: string }[];
  pl: {
    cd: string;
    c: string;
    dt: string;
    e: { cd: string; nm: string; t: string | number; abr?: { cp?: { cd: number | string; ds: string }[] }[] }[];
  }[];
}

// <uf>-p<pleito>-cs.json
export interface ConfigSecoesJson {
  abr?: {
    cd: string;
    mu: {
      cd: string;
      nm: string;
      zon: { cd: string; sec: { ns: string; nsp?: string; nsa?: string[] }[] }[];
    }[];
  }[];
}

// p<pleito>-<uf>-m<mun>-z<zona>-s<secao>-aux.json
export interface IndiceSecaoJson {
  st?: string;
  hashes?: {
    hash: string;
    st?: string;
    dr?: string;
    hr?: string;
    arq?: { nm: string; tp: string }[];
    nmarq?: string[];
  }[];
}
