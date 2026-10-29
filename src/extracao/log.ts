// Log da urna (-log.jez): ZIP com logd.dat, texto ISO-8859-1, um evento por linha, campos separados
// por TAB: "dd/mm/aaaa hh:mm:ss", nível, id da urna, módulo, mensagem, hash (16 hex).
// Cobre a vida toda da urna (testes, carga, dia da eleição).
import yauzl from 'yauzl';
import { promisify } from 'node:util';
import { buffer as lerStream } from 'node:stream/consumers';

import type { Readable } from 'node:stream';

const deBuffer = promisify(yauzl.fromBuffer) as (buf: Buffer, opcoes: yauzl.Options) => Promise<yauzl.ZipFile>;

export interface EventoLog {
  ts: string;
  nivel: string | undefined;
  urna: string | undefined;
  modulo: string | undefined;
  mensagem: string;
  hash: string | undefined;
}

export interface ResumoLog {
  logDia: string | null;
  logVotosComputados: number;
  logHabilitados: number;
  logHabBiometrica: number;
  logHabMesario: number;
  logHabAnoNascimento: number;
  logMsgMesarioHabilitou: number;
  logTentativasDigital: number;
  logPrimeiroVoto: string | null;
  logUltimoVoto: string | null;
  logVotosPorHora: string;
  logUrnas: string;
}

export async function lerLogJez(buf: Buffer): Promise<string> {
  const zip = await deBuffer(buf, { lazyEntries: true });
  const abrir = promisify(zip.openReadStream.bind(zip)) as (e: yauzl.Entry) => Promise<Readable>;
  try {
    return await new Promise<string>((ok, falha) => {
      zip.on('entry', async (e: yauzl.Entry) => {
        if (e.fileName !== 'logd.dat') return zip.readEntry();
        try {
          ok((await lerStream(await abrir(e))).toString('latin1'));
        } catch (err) {
          falha(err);
        }
      });
      zip.on('end', () => falha(new Error('log.jez sem logd.dat')));
      zip.on('error', falha);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

const RE_DATA = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/;

export function parsearLog(textoLog: string): { eventos: EventoLog[]; linhasInvalidas: number } {
  const eventos: EventoLog[] = [];
  let linhasInvalidas = 0;
  for (const linha of textoLog.split('\n')) {
    const l = linha.replace(/\r$/, '');
    if (!l) continue;
    const c = l.split('\t');
    const m = RE_DATA.exec(c[0]!);
    if (c.length < 6 || !m) {
      linhasInvalidas++;
      continue;
    }
    eventos.push({
      ts: `${m[3]}-${m[2]}-${m[1]}T${m[4]}`,
      nivel: c[1], urna: c[2], modulo: c[3], mensagem: c.slice(4, -1).join('\t'), hash: c.at(-1),
    });
  }
  return { eventos, linhasInvalidas };
}

// Classificação determinística das mensagens ligadas ao voto e à habilitação do eleitor.
const REGRAS: [string, RegExp][] = [
  ['voto_computado', /^O voto do eleitor foi computado/],
  ['voto_cargo', /^Voto confirmado para \[/],
  ['eleitor_habilitado', /^Eleitor foi habilitado/],
  ['hab_biometrica', /^Tipo de habilitação do eleitor \[biométrica\]/],
  ['hab_tipo_outro', /^Tipo de habilitação do eleitor \[/],
  ['hab_mesario', /^Mesário \d+ habilitou o eleitor/],
  ['hab_mesario_nao_associado', /^Digital coletada bate com uma digital gravada após o registro inicial de mesário/],
  ['hab_ano_nascimento', /^Ano de nascimento digitado é igual ao do cadastro/],
  ['hab_manual_solicitada', /^Solicitação de dado pessoal do eleitor para habilitação manual/],
  ['digital_solicitada', /^Solicita digital\. Tentativa/],
  ['digital_capturada', /^Capturada a digital/],
  ['digital_score', /^Batimento de digitais retornou o score/],
  ['identificador_digitado', /^Identificador do eleitor digitado pelo mesário/],
  ['eleitor_inativo', /^Eleitor sem atividade por/],
  ['eleitor_suspenso', /^Mesário digitou o título para suspender o eleitor/],
];

export function tipoEvento(mensagem: string): string | null {
  for (const [tipo, re] of REGRAS) if (re.test(mensagem)) return tipo;
  return null;
}

// Resumo do dia da eleição, módulo VOTA. O log do 2º turno traz também o 1º (mesma carga), então o dia
// vem de fora (data de abertura no BU); sem ela, usa o dia com mais "voto computado".
// Tipo de habilitação por voto computado (máquina de estados): a última mensagem de tipo antes de
// "Eleitor foi habilitado" define o tipo daquela habilitação: "[biométrica]" -> biométrica,
// "Ano de nascimento digitado é igual" -> ano de nascimento, "Mesário N habilitou"/"Digital ... de mesário"
// ou nenhuma -> mesário. O tipo só conta quando o voto é computado (habilitações canceladas ou de
// eleitor que desistiu ficam fora). A contagem crua de mensagens não fecha com o BU: nem toda
// habilitação por mesário gera "Mesário N habilitou" e há habilitações sem voto.
const TIPO_HAB: Record<string, 'Biometrica' | 'AnoNascimento' | 'Mesario'> = {
  hab_biometrica: 'Biometrica', hab_ano_nascimento: 'AnoNascimento', hab_mesario: 'Mesario', hab_mesario_nao_associado: 'Mesario',
};

export function resumirLog(eventos: EventoLog[], diaEleicao: string | null = null): ResumoLog {
  const porDia = new Map<string, number>();
  for (const e of eventos) {
    if (e.modulo === 'VOTA' && tipoEvento(e.mensagem) === 'voto_computado') {
      const d = e.ts.slice(0, 10);
      porDia.set(d, (porDia.get(d) ?? 0) + 1);
    }
  }
  const dia = diaEleicao ?? [...porDia].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const r: ResumoLog = {
    logDia: dia, logVotosComputados: 0, logHabilitados: 0, logHabBiometrica: 0, logHabMesario: 0,
    logHabAnoNascimento: 0, logMsgMesarioHabilitou: 0, logTentativasDigital: 0, logPrimeiroVoto: null, logUltimoVoto: null,
    logVotosPorHora: '{}', logUrnas: '',
  };
  if (!dia) return r;
  const porHora: Record<string, number> = {};
  const urnas = new Set<string | undefined>();
  let tipoVisto: string | null = null;
  let habilitacao: string | null = null;
  for (const e of eventos) {
    if (e.modulo !== 'VOTA' || !e.ts.startsWith(dia)) continue;
    const t = tipoEvento(e.mensagem);
    if (t && TIPO_HAB[t]) tipoVisto = TIPO_HAB[t];
    if (t === 'hab_mesario') r.logMsgMesarioHabilitou++;
    if (t === 'eleitor_habilitado') {
      r.logHabilitados++;
      habilitacao = tipoVisto ?? 'Mesario';
      tipoVisto = null;
    } else if (t === 'voto_computado') {
      r.logVotosComputados++;
      r[`logHab${(habilitacao ?? 'Mesario') as 'Biometrica' | 'AnoNascimento' | 'Mesario'}`]++;
      habilitacao = null;
      r.logPrimeiroVoto ??= e.ts;
      r.logUltimoVoto = e.ts;
      const h = e.ts.slice(11, 13);
      porHora[h] = (porHora[h] ?? 0) + 1;
      urnas.add(e.urna);
    } else if (t === 'digital_solicitada') r.logTentativasDigital++;
  }
  r.logVotosPorHora = JSON.stringify(Object.fromEntries(Object.entries(porHora).sort()));
  r.logUrnas = [...urnas].join(',');
  return r;
}
