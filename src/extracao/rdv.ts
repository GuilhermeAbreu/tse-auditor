// Decodifica o Registro Digital do Voto (rdv.dat): EntidadeResultadoRDV { cabecalho, urna, rdv }
// (docs/tse/formato-bu-rdv/spec/rdv.asn1). Em 2026 o rdv traz um SEQUENCE extra (código da carga)
// antes de eleicoes; o decodificador acha eleicoes pela tag e registra o resto como desconhecido.
// Saída: votos agregados por eleição/cargo/tipo/número, no mesmo formato do BU, para o cruzamento BU × RDV.
import { raiz, filhos, inteiro, texto, descrever, ehUniversal, ehContexto, T } from './ber.ts';
import { cabecalho, identificacaoSecao, codigoCargo } from './bu.ts';

// TipoVoto do RDV (difere do BU). Variantes "após suspensão"/"por repetição" etc. somam em branco/nulo.
const TIPO_VOTO_RDV = {
  1: 'legenda', 2: 'nominal', 3: 'branco', 4: 'nulo', 5: 'branco', 6: 'nulo', 7: 'nulo', 8: 'nulo', 9: 'nulo',
};

export function decodificarRDV(buf) {
  const topo = filhos(raiz(buf));
  const cab = cabecalho(topo[0]);
  const rdvNo = topo.find((n, i) => i > 1 && ehUniversal(n, T.SEQUENCE));
  const camposDesconhecidos = [];
  const f = filhos(rdvNo);
  const rdv = { pleito: inteiro(f[0]) ?? cab.idEleitoral, fase: inteiro(f[1]), ...identificacaoSecao(f[2]), resultados: [], camposDesconhecidos };
  for (const n of f.slice(3)) {
    // Spec: [0] eleicoesVota | [1] eleicoesSA. Em 2026 os votos da urna vêm em [1] com o formato de
    // EleicaoVota { idEleicao, votosCargos }; aceita qualquer das duas tags e usa o último SEQUENCE.
    if ((ehContexto(n, 0) || ehContexto(n, 1)) && n.construido) rdv.resultados = filhos(n).flatMap(eleicaoVota);
    else camposDesconhecidos.push({ onde: 'rdv', ...descrever(n) });
  }
  return rdv;
}

function eleicaoVota(no) {
  const f = filhos(no);
  const id = f[0];
  const lista = f.findLast((x) => ehUniversal(x, T.SEQUENCE));
  const eleicao = inteiro(id);
  return filhos(lista).map((vc) => {
    const [cargoNo, escolhas, votosNo] = filhos(vc);
    const contagem = new Map();
    let eleitores = 0;
    for (const v of filhos(votosNo)) {
      eleitores++;
      const [tipoNo, dig] = filhos(v);
      const tipo = TIPO_VOTO_RDV[inteiro(tipoNo)] ?? `tipo ${inteiro(tipoNo)}`;
      const digitado = dig && ehUniversal(dig, T.NUMERIC_STRING) ? texto(dig) : null;
      // Legenda: a digitação guarda o que o eleitor teclou (ex.: 1112, candidato inexistente do partido 11);
      // o voto conta para o partido = 2 primeiros dígitos, como no BU.
      let numero = null;
      if (tipo === 'nominal') numero = Number(digitado);
      else if (tipo === 'legenda') numero = Number(digitado.slice(0, 2));
      const chave = `${tipo}|${numero}`;
      const atual = contagem.get(chave) ?? { tipo, partido: numero == null ? null : Number(String(numero).slice(0, 2)), numero, quantidade: 0 };
      atual.quantidade++;
      contagem.set(chave, atual);
    }
    return { eleicao, ...codigoCargo(cargoNo), quantidadeEscolhas: inteiro(escolhas), registros: eleitores, votos: [...contagem.values()] };
  });
}
