// Decodifica o Boletim de Urna (bu.dat): envelope EntidadeEnvelopeGenerico + EntidadeBoletimUrna
// (docs/tse/formato-bu-rdv/spec/bu.asn1, IMPLICIT TAGS).
//
// O BU de 2026 diverge da especificação de 2022 publicada (ver docs/planos/2026-10-29-extracao.md):
//  - logo após dadosSecaoSA vem um INTEGER sem tag (= comparecimento) e um [1] SEQUENCE de 3 INTEGERs
//    no lugar de [1] qtdEleitoresLibCodigo / [2] qtdEleitoresCompBiometrico;
//  - resultadosVotacaoPorEleicao vem como SEQUENCE universal (não [3]);
//  - ResultadoVotacaoPorEleicao traz 3 INTEGERs após idEleicao (o 1º = aptos) e um OCTET STRING no fim;
//  - TotalVotosVotavel traz um INTEGER (sequencial) antes da assinatura;
//  - Carga traz uma SEQUENCE de 3 strings a mais.
// O decodificador anda por tags/posições e registra em camposDesconhecidos o que não reconhece.
import {
  raiz, filhos, inteiro, texto, bytes, descrever, ehUniversal, ehContexto, T, CONTEXTO,
} from './ber.ts';
import type { Descricao, No } from './ber.ts';

export type Desconhecido = { onde: string } & Partial<Descricao> & { tag: string };

export interface Voto {
  tipo: string | null;
  quantidade: number | null;
  partido: number | null;
  numero: number | null;
}

export interface CargoBU {
  codigoCargo: number;
  cargo: string;
}

export interface ResultadoBU extends CargoBU {
  eleicao: number;
  tipoCargo: number;
  aptos: number | null;
  comparecimento: number;
  votos: Voto[];
}

export interface Urna {
  tipoUrna: string;
  versaoVotacao: string;
  numeroInternoUrna?: number;
  dataHoraCarga?: string;
  codigoCarga?: string | undefined;
  tipoArquivo?: number;
}

export interface IdentificacaoSecao {
  municipio: number;
  zona: number;
  local: number;
  secao: number;
}

export type CampoHabilitacao = 'qtdHabilitacaoAnoNascimento' | 'qtdHabilitacaoBiometrica' | 'qtdHabilitacaoMesario';

export type BU = Urna & IdentificacaoSecao & Record<CampoHabilitacao, number | null> & {
  pleito: number;
  fase: number;
  dataHoraEmissao: string;
  dataHoraAbertura: string | null;
  dataHoraEncerramento: string | null;
  comparecimento: number | null;
  qtdEleitoresLibCodigo: number | null;
  qtdEleitoresCompBiometrico: number | null;
  resultados: ResultadoBU[];
  camposDesconhecidos: Desconhecido[];
};

export const CARGOS: Record<number, string> = {
  1: 'Presidente', 2: 'Vice-presidente', 3: 'Governador', 4: 'Vice-governador', 5: 'Senador',
  6: 'Deputado Federal', 7: 'Deputado Estadual', 8: 'Deputado Distrital', 9: '1º Suplente de Senador',
  10: '2º Suplente de Senador', 11: 'Prefeito', 12: 'Vice-prefeito', 13: 'Vereador',
};
const TIPO_VOTO_BU: Record<number, string> = { 1: 'nominal', 2: 'branco', 3: 'nulo', 4: 'legenda', 5: 'cargoSemCandidato' };
const TIPO_URNA: Record<number, string> = { 1: 'secao', 3: 'contingencia', 4: 'reservaSecao', 6: 'reservaEncerrandoSecao' };

// INFERIDO (não oficial): ordem dos 3 INTEGERs do [1] após o comparecimento, conferida contra o log
// em todas as seções do AC (ver extrator.ts, coluna inconsistencias, e o doc do plano).
export const CAMPOS_HABILITACAO: CampoHabilitacao[] = ['qtdHabilitacaoAnoNascimento', 'qtdHabilitacaoBiometrica', 'qtdHabilitacaoMesario'];

// DataHoraJE "YYYYMMDDThhmmss" -> "YYYY-MM-DD hh:mm:ss" (hora local da urna)
export function dataHoraJE(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : s;
}

export function abrirEnvelope(buf: Buffer): { tipoEnvelope: number | null; conteudo: Buffer } {
  const env = filhos(raiz(buf));
  const conteudo = env.at(-1)!;
  if (!ehUniversal(conteudo, T.OCTET_STRING)) throw new Error('envelope sem conteudo OCTET STRING');
  const tipo = env.find((n) => ehUniversal(n, T.ENUMERATED) && n !== env[1]);
  return { tipoEnvelope: tipo ? inteiro(tipo) : null, conteudo: Buffer.from(bytes(conteudo)) };
}

export function cabecalho(no: No): { dataGeracao: string; idEleitoral: number; tipoId: number } {
  const [data, id] = filhos(no) as [No, No];
  return { dataGeracao: dataHoraJE(texto(data)), idEleitoral: inteiro(id), tipoId: id.tag };
}

export function identificacaoSecao(no: No): IdentificacaoSecao {
  const [mz, local, secao] = filhos(no) as [No, No, No];
  const [municipio, zona] = filhos(mz).map(inteiro) as [number, number];
  return { municipio, zona, local: inteiro(local), secao: inteiro(secao) };
}

export function codigoCargo(no: No): CargoBU {
  // CHOICE: [1] cargoConstitucional | [2] numeroCargoConsultaLivre
  const v = inteiro(no);
  return { codigoCargo: no.tag === 1 ? v : 100 + v, cargo: no.tag === 1 ? (CARGOS[v] ?? `cargo ${v}`) : `consulta ${v}` };
}

function urna(no: No, desconhecidos: Desconhecido[]): Urna {
  const f = filhos(no) as [No, No, No, No, ...No[]];
  const r: Urna = { tipoUrna: TIPO_URNA[inteiro(f[0])] ?? String(inteiro(f[0])), versaoVotacao: texto(f[1]) };
  const carga = filhos(filhos(f[2])[1]!);
  r.numeroInternoUrna = inteiro(carga[0]!);
  const strs = carga.filter((n) => ehUniversal(n, T.GENERAL_STRING)).map(texto);
  r.dataHoraCarga = dataHoraJE(strs.find((s) => /^\d{8}T\d{6}$/.test(s)) ?? '');
  r.codigoCarga = strs.at(-1);
  r.tipoArquivo = inteiro(f[3]);
  for (const n of f.slice(5)) desconhecidos.push({ onde: 'urna', ...descrever(n) });
  return r;
}

function votavel(no: No, desconhecidos: Desconhecido[]): Voto {
  const v: Voto = { tipo: null, quantidade: null, partido: null, numero: null };
  for (const n of filhos(no)) {
    if (ehContexto(n, 1)) v.tipo = TIPO_VOTO_BU[inteiro(n)] ?? `tipo ${inteiro(n)}`;
    else if (ehContexto(n, 2)) v.quantidade = inteiro(n);
    else if (ehContexto(n, 3)) [v.partido, v.numero] = filhos(n).map(inteiro) as [number, number];
    else if (ehUniversal(n, T.INTEGER) || ehUniversal(n, T.OCTET_STRING)) continue; // sequencial / assinatura
    else desconhecidos.push({ onde: 'votavel', ...descrever(n) });
  }
  return v;
}

function resultadoPorEleicao(no: No, desconhecidos: Desconhecido[]): ResultadoBU[] {
  const f = filhos(no);
  const ints = f.filter((n) => ehUniversal(n, T.INTEGER)).map(inteiro);
  const lista = f.find((n) => ehUniversal(n, T.SEQUENCE));
  const eleicao = ints[0]!;
  const aptos = ints[1] ?? null;
  if (ints.length > 2) desconhecidos.push({ onde: `eleicao ${eleicao}`, tag: 'inteiros extras', valor: ints.slice(2) });
  const resultados: ResultadoBU[] = [];
  for (const rv of lista ? filhos(lista) : []) {
    const g = filhos(rv) as [No, No, No];
    const tipoCargo = inteiro(g[0]);
    const comparecimento = inteiro(g[1]);
    for (const tc of filhos(g[2])) {
      const h = filhos(tc);
      const cargo = codigoCargo(h[0]!);
      const votos = filhos(h.find((n, i) => i > 0 && ehUniversal(n, T.SEQUENCE))!).map((v) => votavel(v, desconhecidos));
      resultados.push({ eleicao, ...cargo, tipoCargo, aptos, comparecimento, votos });
    }
  }
  return resultados;
}

export function decodificarBU(buf: Buffer): BU {
  const { conteudo } = abrirEnvelope(buf);
  const f = filhos(raiz(conteudo)) as [No, No, No, No, No, ...No[]];
  const camposDesconhecidos: Desconhecido[] = [];
  const cab = cabecalho(f[0]);
  const bu: BU = {
    pleito: cab.idEleitoral,
    fase: inteiro(f[1]),
    ...urna(f[2], camposDesconhecidos),
    ...identificacaoSecao(f[3]),
    dataHoraEmissao: dataHoraJE(texto(f[4])),
    dataHoraAbertura: null,
    dataHoraEncerramento: null,
    comparecimento: null,
    qtdEleitoresLibCodigo: null,
    qtdEleitoresCompBiometrico: null,
    ...(Object.fromEntries(CAMPOS_HABILITACAO.map((c) => [c, null])) as Record<CampoHabilitacao, null>),
    resultados: [],
    camposDesconhecidos,
  };
  for (const n of f.slice(5)) {
    if (n.classe === CONTEXTO && n.tag === 0 && n.construido && bu.dataHoraAbertura == null) {
      const [a, e] = filhos(n).map(texto) as [string, string];
      bu.dataHoraAbertura = dataHoraJE(a);
      bu.dataHoraEncerramento = dataHoraJE(e);
    } else if (ehUniversal(n, T.INTEGER) && bu.comparecimento == null) {
      bu.comparecimento = inteiro(n);
    } else if (ehContexto(n, 1) && n.construido) {
      const v = filhos(n).map(inteiro);
      if (v.length !== CAMPOS_HABILITACAO.length) camposDesconhecidos.push({ onde: 'habilitacoes', ...descrever(n) });
      CAMPOS_HABILITACAO.forEach((c, i) => { bu[c] = v[i] ?? null; });
    } else if (ehContexto(n, 1)) {
      bu.qtdEleitoresLibCodigo = inteiro(n); // formato 2022
    } else if (ehContexto(n, 2) && !n.construido) {
      bu.qtdEleitoresCompBiometrico = inteiro(n); // formato 2022
    } else if ((ehContexto(n, 3) || ehUniversal(n, T.SEQUENCE)) && bu.resultados.length === 0 && ehListaDeEleicoes(n)) {
      bu.resultados = filhos(n).flatMap((e) => resultadoPorEleicao(e, camposDesconhecidos));
    } else {
      camposDesconhecidos.push({ onde: 'boletim', ...descrever(n) });
    }
  }
  if (bu.comparecimento == null && bu.resultados.length) bu.comparecimento = bu.resultados[0]!.comparecimento;
  return bu;
}

function ehListaDeEleicoes(n: No): boolean {
  if (!n.construido) return false;
  const f = filhos(n);
  return f.length > 0 && f.every((e) => e.construido && ehUniversal(filhos(e)[0]!, T.INTEGER));
}
