// Etapa 2: lê os zips de raw/<UF>/<pleito>/<mun>.zip, decodifica BU, RDV e log de cada seção e grava
// parquet/<UF>/{secoes,votos,eventos_log,falhas}.parquet. Seção sem arquivo ou com erro de decodificação
// aparece em secoes com status "sem dados"/"parcial" e o motivo em falhas; nunca é pulada em silêncio.
// Tudo é código determinístico; as conferências de consistência vão na coluna inconsistencias.
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { promisify } from 'node:util';
import { buffer as lerStream } from 'node:stream/consumers';
import { decodificarBU, CAMPOS_HABILITACAO } from './bu.ts';
import { decodificarRDV } from './rdv.ts';
import { lerLogJez, parsearLog, resumirLog, tipoEvento } from './log.ts';
import { GravadorParquet } from './parquet.ts';

const deBuffer = promisify(yauzl.fromBuffer);

const LOC = [['pleito', 'INTEGER'], ['uf', 'VARCHAR'], ['mun', 'VARCHAR'], ['zona', 'VARCHAR'], ['secao', 'VARCHAR']];
export const TABELAS = {
  secoes: [...LOC,
    ['status', 'VARCHAR'], ['local', 'INTEGER'], ['aptos', 'INTEGER'], ['comparecimento', 'INTEGER'], ['abstencao', 'INTEGER'],
    ...CAMPOS_HABILITACAO.map((c) => [c, 'INTEGER']),
    ['tipoUrna', 'VARCHAR'], ['numeroInternoUrna', 'INTEGER'], ['versaoVotacao', 'VARCHAR'], ['dataHoraCarga', 'TIMESTAMP'],
    ['abertura', 'TIMESTAMP'], ['encerramento', 'TIMESTAMP'], ['emissao', 'TIMESTAMP'],
    ['agregada', 'BOOLEAN'], ['secoesAgregadas', 'VARCHAR'], ['agregadaEm', 'VARCHAR'], ['substituida', 'BOOLEAN'], ['conjuntos', 'INTEGER'],
    ['logDia', 'VARCHAR'], ['logVotosComputados', 'INTEGER'], ['logHabilitados', 'INTEGER'], ['logHabBiometrica', 'INTEGER'],
    ['logHabMesario', 'INTEGER'], ['logHabAnoNascimento', 'INTEGER'], ['logMsgMesarioHabilitou', 'INTEGER'], ['logTentativasDigital', 'INTEGER'],
    ['logPrimeiroVoto', 'TIMESTAMP'], ['logUltimoVoto', 'TIMESTAMP'], ['logVotosPorHora', 'VARCHAR'], ['logUrnas', 'VARCHAR'],
    ['logLinhasInvalidas', 'INTEGER'], ['camposDesconhecidos', 'VARCHAR'], ['inconsistencias', 'VARCHAR']],
  votos: [...LOC, ['origem', 'VARCHAR'], ['eleicao', 'INTEGER'], ['codigoCargo', 'INTEGER'], ['cargo', 'VARCHAR'],
    ['tipo', 'VARCHAR'], ['numero', 'INTEGER'], ['partido', 'INTEGER'], ['quantidade', 'INTEGER']],
  eventos_log: [...LOC, ['ts', 'TIMESTAMP'], ['nivel', 'VARCHAR'], ['urna', 'VARCHAR'], ['modulo', 'VARCHAR'],
    ['tipo', 'VARCHAR'], ['mensagem', 'VARCHAR']],
  falhas: [...LOC, ['arquivo', 'VARCHAR'], ['erro', 'VARCHAR']],
};

// Conferências automáticas (mapeamento INFERIDO dos 3 números do BU; ver bu.ts). Devolve códigos curtos.
export function conferir(bu, log, rdv) {
  const p = [];
  if (bu) {
    const soma = CAMPOS_HABILITACAO.reduce((s, c) => s + (bu[c] ?? 0), 0);
    if (bu.qtdHabilitacaoBiometrica != null && soma !== bu.comparecimento) p.push(`hab_soma(${soma})!=comparecimento(${bu.comparecimento})`);
    for (const r of bu.resultados) {
      const total = r.votos.reduce((s, v) => s + v.quantidade, 0);
      if (total % r.comparecimento !== 0 && r.comparecimento > 0) p.push(`votos_${r.codigoCargo}(${total})!=k*comparecimento`);
    }
  }
  if (bu && log?.logDia) {
    const pares = [
      ['comparecimento', 'logVotosComputados'], ['qtdHabilitacaoBiometrica', 'logHabBiometrica'],
      ['qtdHabilitacaoMesario', 'logHabMesario'], ['qtdHabilitacaoAnoNascimento', 'logHabAnoNascimento'],
    ];
    for (const [a, b] of pares) if (bu[a] != null && bu[a] !== log[b]) p.push(`${a}(${bu[a]})!=${b}(${log[b]})`);
  }
  if (bu && rdv) {
    const chave = (r, v) => `${r.eleicao}|${r.codigoCargo}|${v.tipo}|${v.numero}`;
    const m = new Map();
    for (const r of bu.resultados) for (const v of r.votos) if (v.quantidade) m.set(chave(r, v), (m.get(chave(r, v)) ?? 0) + v.quantidade);
    for (const r of rdv.resultados) for (const v of r.votos) m.set(chave(r, v), (m.get(chave(r, v)) ?? 0) - v.quantidade);
    const dif = [...m].filter(([, d]) => d !== 0);
    if (dif.length) p.push(`bu!=rdv(${dif.slice(0, 3).map(([k, d]) => `${k}:${d}`).join(',')}${dif.length > 3 ? ',…' : ''})`);
  }
  return p;
}

// Abre o zip do município e indexa as entradas sem lê-las: cada arquivo é lido só quando a seção
// precisa dele (o zip de uma capital passa de GB; ler tudo de uma vez estoura a memória).
async function abrirZip(caminho) {
  const zip = await promisify(yauzl.open)(caminho, { lazyEntries: true, autoClose: false });
  const abrir = promisify(zip.openReadStream.bind(zip));
  const entradas = new Map();
  await new Promise((ok, falha) => {
    zip.on('entry', (e) => {
      if (!e.fileName.endsWith('/')) entradas.set(e.fileName, e);
      zip.readEntry();
    });
    zip.on('end', ok);
    zip.on('error', falha);
    zip.readEntry();
  });
  const arquivos = new Map([...entradas].map(([nome, e]) => [nome, async () => lerStream(await abrir(e))]));
  return { arquivos, fechar: () => zip.close() };
}

function secoesDoConfig(json) {
  const abr = json.abr[0];
  return abr.mu.map((m) => ({
    mun: m.cd,
    secoes: m.zon.flatMap((z) => z.sec.map((s) => ({ zona: z.cd, secao: s.ns, nsa: s.nsa ?? [], nsp: s.nsp && s.nsp !== s.ns ? s.nsp : null }))),
  }));
}

export async function extrairUF({ dados, uf, pleitos, aoProgresso = () => {} }) {
  const UF = uf.toUpperCase();
  const pastaRaw = path.join(dados, 'raw', UF);
  const saida = path.join(dados, 'parquet', UF);
  await mkdir(saida, { recursive: true });
  pleitos ??= (await readdir(pastaRaw)).filter((p) => /^\d+$/.test(p)).sort();
  const g = await GravadorParquet.abrir(path.join(saida, '.extracao.duckdb'));
  const stats = { secoes: 0, ok: 0, parcial: 0, semDados: 0, agregadasEm: 0, comInconsistencia: 0, inconsistencias: {} };
  try {
    for (const [nome, cols] of Object.entries(TABELAS)) await g.criar(nome, cols);
    for (const pleito of pleitos) {
      const pastaPleito = path.join(pastaRaw, String(pleito));
      const cfg = JSON.parse(await readFile(path.join(pastaPleito, `${uf.toLowerCase()}-p${String(pleito).padStart(6, '0')}-cs.json`), 'latin1'));
      for (const { mun, secoes } of secoesDoConfig(cfg)) {
        let zip = { arquivos: new Map(), fechar() {} };
        let erroZip = null;
        try {
          zip = await abrirZip(path.join(pastaPleito, `${mun}.zip`));
        } catch (err) {
          erroZip = err.code === 'ENOENT' ? 'zip do município ausente' : `zip ilegível: ${err.message}`;
        }
        try {
          for (const s of secoes) {
            const loc = { pleito: Number(pleito), uf: UF, mun, zona: s.zona, secao: s.secao };
            await extrairSecao({ g, loc, s, arquivos: zip.arquivos, erroZip, stats });
          }
        } finally {
          zip.fechar();
        }
        g.descarregar(); // grava o município no banco em disco antes do próximo
        aoProgresso({ pleito, mun, ...stats });
      }
    }
    stats.linhas = await g.exportar(saida);
  } finally {
    await g.fechar();
  }
  return stats;
}

async function extrairSecao({ g, loc, s, arquivos, erroZip, stats }) {
  stats.secoes++;
  const linha = {
    ...loc, agregada: s.nsa.length > 0, secoesAgregadas: s.nsa.join(',') || null, agregadaEm: s.nsp,
  };
  const falhar = (arquivo, erro) => g.inserir('falhas', { ...loc, arquivo, erro });
  if (s.nsp) {
    // seção agregada a outra: não tem arquivos próprios, os votos estão na principal
    stats.agregadasEm++;
    g.inserir('secoes', { ...linha, status: 'agregada' });
    return;
  }
  const pre = `${s.zona}/${s.secao}/`;
  let aux = null;
  try {
    if (erroZip) throw new Error(erroZip);
    const auxNome = [...arquivos.keys()].find((k) => k.startsWith(pre) && k.endsWith('.json') && k.split('/').length === 3);
    if (!auxNome) throw new Error('aux.json da seção ausente');
    aux = JSON.parse((await arquivos.get(auxNome)()).toString('latin1'));
  } catch (err) {
    falhar('aux', err.message);
    stats.semDados++;
    g.inserir('secoes', { ...linha, status: 'sem dados' });
    return;
  }
  const hashes = aux.hashes ?? [];
  linha.conjuntos = hashes.length;
  linha.substituida = hashes.length > 1;
  const escolhido = hashes.findLast((h) => /totaliz/i.test(h.st ?? '')) ?? hashes.at(-1);
  const arq = async (tp) => {
    const nm = escolhido?.arq?.find((a) => a.tp === tp)?.nm;
    const ler = nm ? arquivos.get(`${pre}${escolhido.hash}/${nm}`) : undefined;
    return ler ? ler() : undefined;
  };
  const tentar = async (tp, fn) => {
    let buf;
    try {
      buf = await arq(tp);
    } catch (err) {
      falhar(tp, err.message);
      return null;
    }
    if (!buf) {
      falhar(tp, 'arquivo ausente');
      return null;
    }
    try {
      return fn(buf);
    } catch (err) {
      falhar(tp, err.message);
      return null;
    }
  };

  const bu = await tentar('bu', decodificarBU);
  const rdv = await tentar('rdv', decodificarRDV);
  let log = null;
  let bufLog;
  let erroLog = 'arquivo ausente';
  try {
    bufLog = await arq('log');
  } catch (err) {
    erroLog = err.message;
  }
  if (!bufLog) falhar('log', erroLog);
  else {
    try {
      const { eventos, linhasInvalidas } = parsearLog(await lerLogJez(bufLog));
      log = { ...resumirLog(eventos, bu?.dataHoraAbertura?.slice(0, 10) ?? null), logLinhasInvalidas: linhasInvalidas };
      for (const e of eventos) g.inserir('eventos_log', { ...loc, ...e, tipo: tipoEvento(e.mensagem) });
    } catch (err) {
      falhar('log', err.message);
    }
  }

  if (bu) {
    const aptos = bu.resultados[0]?.aptos ?? null;
    Object.assign(linha, {
      local: bu.local, aptos, comparecimento: bu.comparecimento,
      abstencao: aptos != null && bu.comparecimento != null ? aptos - bu.comparecimento : null,
      ...Object.fromEntries(CAMPOS_HABILITACAO.map((c) => [c, bu[c]])),
      tipoUrna: bu.tipoUrna, numeroInternoUrna: bu.numeroInternoUrna, versaoVotacao: bu.versaoVotacao,
      dataHoraCarga: bu.dataHoraCarga, abertura: bu.dataHoraAbertura, encerramento: bu.dataHoraEncerramento,
      emissao: bu.dataHoraEmissao,
      camposDesconhecidos: bu.camposDesconhecidos.length ? JSON.stringify(bu.camposDesconhecidos) : null,
    });
    for (const r of bu.resultados) for (const v of r.votos) g.inserir('votos', { ...loc, origem: 'BU', ...r, ...v });
  }
  if (rdv) for (const r of rdv.resultados) for (const v of r.votos) g.inserir('votos', { ...loc, origem: 'RDV', ...r, ...v });
  if (log) Object.assign(linha, log);

  const inc = conferir(bu, log, rdv);
  linha.inconsistencias = inc.length ? inc.join('; ') : null;
  if (inc.length) stats.comInconsistencia++;
  for (const i of inc) {
    const k = i.replace(/\(.*$/, '').replace(/[^a-z_A-Z!=]/g, '');
    stats.inconsistencias[k] = (stats.inconsistencias[k] ?? 0) + 1;
  }
  const completo = bu && rdv && log;
  linha.status = completo ? 'ok' : (bu || rdv || log ? 'parcial' : 'sem dados');
  stats[completo ? 'ok' : (linha.status === 'parcial' ? 'parcial' : 'semDados')]++;
  g.inserir('secoes', linha);
}
