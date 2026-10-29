// Lê o -aux.json da seção. Cada item de "hashes" é um conjunto de arquivos de uma urna;
// urna substituída (contingência) gera mais de um conjunto, e todos são mantidos.
// 2026 usa "arq: [{ nm, tp }]"; 2022 usava "nmarq: [nome]".
export function lerIndiceSecao(json) {
  return {
    status: json.st ?? null,
    conjuntos: (json.hashes ?? []).map((h) => ({
      hash: h.hash,
      status: h.st ?? null,
      data: h.dr ?? null,
      hora: h.hr ?? null,
      arquivos: h.arq
        ? h.arq.map((a) => ({ nome: a.nm, tipo: a.tp }))
        : (h.nmarq ?? []).map((nome) => ({ nome, tipo: nome.split('.').pop() })),
    })),
  };
}
