// Lê o ele-c.json do TSE: pleitos (o que os arquivos de urna usam), eleições, cargos
// e os templates de diretório de onde ficam config e dados das urnas.
export function lerEleicoes(json) {
  const templates = Object.fromEntries((json.arq ?? []).map((a) => [a.tp, a.dir]));
  for (const tp of ['cs', 'aux']) {
    if (!templates[tp]) throw new Error(`ele-c.json sem o diretório "${tp}"`);
  }
  const pleitos = json.pl.map((p) => ({
    cd: p.cd,
    ciclo: p.c,
    data: p.dt,
    eleicoes: p.e.map((e) => ({
      cd: e.cd,
      nome: e.nm,
      turno: Number(e.t),
      cargos: (e.abr ?? []).flatMap((a) => a.cp ?? []).map((c) => ({ cd: c.cd, nome: c.ds })),
    })),
  }));
  return { templates: { cs: templates.cs, aux: templates.aux }, pleitos };
}

export async function buscarEleicoes(http, { base, ambiente }) {
  const url = `${base}/${ambiente}/comum/config/ele-c.json`;
  const r = await http.get(url);
  if (r.status !== 200) throw new Error(`ele-c.json: HTTP ${r.status} em ${url}`);
  return lerEleicoes(JSON.parse(r.body.toString('utf8')));
}
