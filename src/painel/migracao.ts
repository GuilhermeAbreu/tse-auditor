// Movimentação de votos de presidente entre o 1º e o 2º turno. Duas contas, ambas determinísticas:
// - balancoSecao: saldo exato de uma seção (quem ganhou, quem perdeu, eleitores a mais/a menos) e, para cada
//   ganho, a faixa possível de quanto veio de eleitores novos e quanto de votos liberados. É só o saldo líquido:
//   eleitores podem ter trocado de lado nos dois sentidos, e o voto é secreto, então não há como saber quem foi.
// - estimarTransferencias: inferência ecológica (regressão de Goodman com restrições) sobre muitas seções; estima
//   que fração de cada grupo do 1º turno foi para cada destino do 2º. Vale para o conjunto, nunca para uma seção.

export interface Movimento { chave: string; votos: number }
export interface Ganho { chave: string; ganho: number; deNovos: [number, number]; deLiberados: [number, number] }
export interface Balanco {
  fontes: Movimento[]; // quem perdeu votos (eliminados, brancos/nulos que caíram, candidato que caiu)
  novos: number; // eleitores a mais no 2º turno
  liberados: number; // soma das perdas
  ganhos: Ganho[]; // quem ganhou votos, incluindo "deixaram de votar" quando o comparecimento cai
  fecha: boolean; // a soma das diferenças bate com a diferença de comparecimento
}

export const DEIXARAM = 'deixaram_de_votar';

// votos1/votos2: chave ('c13', 'branco', 'nulo') → votos; comparecimento de cada turno.
export function balancoSecao(votos1: Record<string, number>, votos2: Record<string, number>, comparecimento1: number, comparecimento2: number): Balanco {
  const chaves = [...new Set([...Object.keys(votos1), ...Object.keys(votos2)])];
  const dif = chaves.map((chave) => ({ chave, d: (votos2[chave] ?? 0) - (votos1[chave] ?? 0) }));
  const delta = comparecimento2 - comparecimento1;
  const fontes = dif.filter((x) => x.d < 0).map((x) => ({ chave: x.chave, votos: -x.d })).sort((a, b) => b.votos - a.votos || a.chave.localeCompare(b.chave));
  const liberados = fontes.reduce((s, f) => s + f.votos, 0);
  const novos = Math.max(0, delta);
  const destinos = dif.filter((x) => x.d > 0).map((x) => ({ chave: x.chave, ganho: x.d }));
  if (delta < 0) destinos.push({ chave: DEIXARAM, ganho: -delta });
  const ganhos = destinos.sort((a, b) => b.ganho - a.ganho || a.chave.localeCompare(b.chave)).map(({ chave, ganho }) => ({
    chave, ganho,
    // quem deixou de votar só pode vir de votos do 1º turno
    deNovos: (chave === DEIXARAM ? [0, 0] : [Math.max(0, ganho - liberados), Math.min(ganho, novos)]) as [number, number],
    deLiberados: (chave === DEIXARAM ? [ganho, ganho] : [Math.max(0, ganho - novos), Math.min(ganho, liberados)]) as [number, number],
  }));
  return { fontes, novos, liberados, ganhos, fecha: dif.reduce((s, x) => s + x.d, 0) === delta };
}

// Projeção euclidiana no simplex {b ≥ 0, Σb = 1}.
export function projetarSimplex(v: number[]): number[] {
  const u = [...v].sort((a, b) => b - a);
  let acumulado = 0;
  let theta = 0;
  for (let i = 0; i < u.length; i++) {
    acumulado += u[i]!;
    const t = (acumulado - 1) / (i + 1);
    if (u[i]! - t > 0) theta = t;
  }
  return v.map((x) => Math.max(0, x - theta));
}

export interface Amostra { x: number[]; y: number[]; peso: number }
export interface Ajuste { matriz: number[][]; rmse: number; r2: number[] }

// Minimiza Σ peso·‖y − x·B‖² com cada linha de B no simplex (cada grupo do 1º turno se reparte entre os destinos do 2º),
// por gradiente projetado. Um termo mínimo de regularização rumo à divisão uniforme torna a solução única quando
// grupos andam juntos entre as seções (o mesmo dado sempre dá o mesmo resultado).
export function estimarTransferencias(amostras: Amostra[], nFontes: number, nDestinos: number, { iteracoes = 50_000, tolerancia = 1e-12 } = {}): Ajuste {
  const A = Array.from({ length: nFontes }, () => new Array<number>(nFontes).fill(0));
  const C = Array.from({ length: nFontes }, () => new Array<number>(nDestinos).fill(0));
  let pesoTotal = 0;
  for (const { x, y, peso } of amostras) {
    pesoTotal += peso;
    for (let i = 0; i < nFontes; i++) {
      for (let j = 0; j < nFontes; j++) A[i]![j]! += peso * x[i]! * x[j]!;
      for (let k = 0; k < nDestinos; k++) C[i]![k]! += peso * x[i]! * y[k]!;
    }
  }
  const traco = A.reduce((s, l, i) => s + l[i]!, 0);
  const lambda = 1e-6 * (traco / Math.max(1, nFontes));
  // maior autovalor de A por iteração de potência (A é simétrica e semidefinida)
  let v = new Array<number>(nFontes).fill(1);
  let autovalor = 0;
  for (let it = 0; it < 200; it++) {
    const w = A.map((l) => l.reduce((s, a, j) => s + a * v[j]!, 0));
    const n = Math.hypot(...w);
    if (n === 0) break;
    autovalor = n / Math.hypot(...v);
    v = w.map((x) => x / n);
  }
  const passo = 1 / (2 * (autovalor + lambda) || 1);
  const uniforme = 1 / nDestinos;
  let B = Array.from({ length: nFontes }, () => new Array<number>(nDestinos).fill(uniforme));
  for (let it = 0; it < iteracoes; it++) {
    let mudanca = 0;
    B = B.map((linha, i) => {
      const nova = projetarSimplex(linha.map((b, k) => {
        let ab = 0;
        for (let j = 0; j < nFontes; j++) ab += A[i]![j]! * B[j]![k]!;
        return b - passo * 2 * (ab - C[i]![k]! + lambda * (b - uniforme));
      }));
      for (let k = 0; k < nDestinos; k++) mudanca = Math.max(mudanca, Math.abs(nova[k]! - linha[k]!));
      return nova;
    });
    if (mudanca < tolerancia) break;
  }
  // qualidade: erro médio (em fração dos aptos) e R² de cada destino, ponderados pelo peso
  let erro = 0;
  const media = new Array<number>(nDestinos).fill(0);
  for (const { y, peso } of amostras) for (let k = 0; k < nDestinos; k++) media[k]! += (peso * y[k]!) / (pesoTotal || 1);
  const ssRes = new Array<number>(nDestinos).fill(0);
  const ssTot = new Array<number>(nDestinos).fill(0);
  for (const { x, y, peso } of amostras) {
    for (let k = 0; k < nDestinos; k++) {
      let previsto = 0;
      for (let j = 0; j < nFontes; j++) previsto += x[j]! * B[j]![k]!;
      ssRes[k]! += peso * (y[k]! - previsto) ** 2;
      ssTot[k]! += peso * (y[k]! - media[k]!) ** 2;
      erro += peso * (y[k]! - previsto) ** 2;
    }
  }
  return {
    matriz: B,
    rmse: Math.sqrt(erro / ((pesoTotal || 1) * nDestinos)),
    r2: ssRes.map((r, k) => (ssTot[k]! > 0 ? 1 - r / ssTot[k]! : 1)),
  };
}
