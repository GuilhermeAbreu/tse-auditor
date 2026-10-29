// Leitor BER/DER mínimo: o suficiente para os arquivos de urna do TSE (BU, RDV).
// Um nó é { classe, construido, tag, buf, inicio, fim }: o valor fica em buf[inicio, fim).

export const UNIVERSAL = 0;
export const APLICACAO = 1;
export const CONTEXTO = 2;
export const PRIVADA = 3;

export interface No {
  classe: number;
  construido: boolean;
  tag: number;
  buf: Buffer;
  inicio: number;
  fim: number;
}

export type Descricao = { tag: string; filhos?: Descricao[]; valor?: number | number[]; hex?: string };

export const T = { INTEGER: 2, OCTET_STRING: 4, ENUMERATED: 10, SEQUENCE: 16, NUMERIC_STRING: 18, GENERAL_STRING: 27 };

export function lerNo(buf: Buffer, pos = 0, limite = buf.length): No {
  if (pos >= limite) throw new Error(`BER: fim inesperado em ${pos}`);
  const b0 = buf[pos++]!;
  const classe = b0 >> 6;
  const construido = (b0 & 0x20) !== 0;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b: number;
    do {
      if (pos >= limite) throw new Error('BER: tag longa truncada');
      b = buf[pos++]!;
      tag = tag * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (pos >= limite) throw new Error('BER: comprimento ausente');
  let tam = buf[pos++]!;
  if (tam === 0x80) throw new Error('BER: comprimento indefinido não suportado');
  if (tam & 0x80) {
    const n = tam & 0x7f;
    if (n > 6 || pos + n > limite) throw new Error(`BER: comprimento inválido em ${pos}`);
    tam = 0;
    for (let i = 0; i < n; i++) tam = tam * 256 + buf[pos++]!;
  }
  const fim = pos + tam;
  if (fim > limite) throw new Error(`BER: valor de ${tam} bytes passa do fim (${fim} > ${limite})`);
  return { classe, construido, tag, buf, inicio: pos, fim };
}

export function filhos(no: No): No[] {
  if (!no.construido) throw new Error(`BER: nó [${no.classe}:${no.tag}] não é construído`);
  const lista = [];
  let pos = no.inicio;
  while (pos < no.fim) {
    const f = lerNo(no.buf, pos, no.fim);
    lista.push(f);
    pos = f.fim;
  }
  return lista;
}

export function raiz(buf: Buffer): No {
  return lerNo(buf, 0);
}

export function inteiro(no: No): number {
  const n = no.fim - no.inicio;
  if (n === 0) return 0;
  if (n > 6) return Number(bigInteiro(no));
  let v = 0;
  for (let i = no.inicio; i < no.fim; i++) v = v * 256 + no.buf[i]!;
  if (no.buf[no.inicio]! & 0x80) v -= 2 ** (8 * n); // complemento de dois
  return v;
}

function bigInteiro(no: No): bigint {
  let v = 0n;
  for (let i = no.inicio; i < no.fim; i++) v = v * 256n + BigInt(no.buf[i]!);
  if (no.buf[no.inicio]! & 0x80) v -= 1n << BigInt(8 * (no.fim - no.inicio));
  return v;
}

export function texto(no: No): string {
  return no.buf.toString('latin1', no.inicio, no.fim);
}

export function bytes(no: No): Buffer {
  return no.buf.subarray(no.inicio, no.fim);
}

export const hex = (no: No): string => bytes(no).toString('hex');

export const ehUniversal = (no: No, tag: number): boolean => no.classe === UNIVERSAL && no.tag === tag;
export const ehContexto = (no: No, tag: number): boolean => no.classe === CONTEXTO && no.tag === tag;

// Descrição curta de um nó, para registrar campos desconhecidos.
export function descrever(no: No): Descricao {
  const rotulo = ['U', 'A', 'C', 'P'][no.classe] + no.tag;
  if (no.construido) return { tag: rotulo, filhos: filhos(no).map(descrever) };
  if (no.fim - no.inicio <= 6 && (no.tag === T.INTEGER || no.tag === T.ENUMERATED || no.classe === CONTEXTO)) {
    return { tag: rotulo, valor: inteiro(no) };
  }
  return { tag: rotulo, hex: hex(no).slice(0, 64) };
}
