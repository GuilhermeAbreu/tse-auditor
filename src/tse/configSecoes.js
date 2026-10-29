// Lê <uf>-p<pleito>-cs.json. Seção agregada traz "nsp" (a seção principal) e não tem arquivos próprios.
export function lerConfigSecoes(json) {
  const abr = json.abr?.[0];
  if (!abr) throw new Error('config de seções sem "abr"');
  return {
    uf: abr.cd,
    municipios: abr.mu.map((m) => ({
      mun: m.cd,
      nome: m.nm,
      secoes: m.zon.flatMap((z) => z.sec.map((s) => ({ zona: z.cd, secao: s.ns, principal: s.nsp ?? null }))),
    })),
  };
}
