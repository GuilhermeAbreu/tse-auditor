#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { PADRAO, pastaDados } from './config.ts';
import { configInicial, lerConfigSalva } from './configSalva.ts';
import { UFS } from './ufs.ts';
import { fmtBytes, linhaDeProgresso } from './formatar.ts';
import { HttpClient } from './net/http.ts';
import { buscarEleicoes } from './tse/eleicoes.ts';
import { ControleColeta } from './coleta/controle.ts';
import { criarPainel } from './painel/server.ts';
import { extrairUF } from './extracao/extrator.ts';
import { analisarUF, resumir } from './cruzamentos/index.ts';

const AJUDA = `uso:
  tse-auditor eleicoes
  tse-auditor coletar --pleito 3220,3221 [--uf ac,al] [--dados <pasta>] [--concorrencia 4]
  tse-auditor painel  [--pleito 3220,3221] [--uf ac,al] [--dados <pasta>] [--concorrencia 4] [--porta 3000] [--sem-iniciar]
  tse-auditor extrair --uf ac [--pleito 3220,3221] [--dados <pasta>]   (BU/RDV/log -> parquet/<UF>/)
  tse-auditor analisar --uf ac [--dados <pasta>] [--turnos 3220,3221]  (cruzamentos -> parquet/<UF>/achados.parquet)
    sem --turnos, o 1º/2º turno sai do ele-c.json (pleitos presentes nos Parquet); "--turnos 3220" = só um turno

O painel também configura pleitos, UFs e concorrência; a última configuração aplicada fica em
$XDG_CONFIG_HOME/tse-auditor/config.json (ou TSE_CONFIG) e é usada quando o painel abre sem opções.`;

function listarEleicoes({ pleitos }) {
  for (const p of pleitos) {
    console.log(`${p.cd.padEnd(6)} ${p.ciclo}  ${p.data}`);
    for (const e of p.eleicoes) {
      const cargos = e.cargos.map((c) => c.nome).join(', ');
      console.log(`    ${e.cd} ${e.turno}º turno  ${e.nome}${cargos ? ` (${cargos})` : ''}`);
    }
  }
}

const lista = (texto) => texto.split(',').map((x) => x.trim()).filter(Boolean);

// Primeiro Ctrl-C: parada ordenada. Segundo: força a saída (fecha o manifest se der).
function tratarCtrlC(controle, aoParar) {
  let vezes = 0;
  process.on('SIGINT', () => {
    vezes++;
    if (vezes > 1) {
      controle.fecharJa();
      process.exit(130);
    }
    console.log('encerrando: aguardando as seções em andamento; Ctrl-C de novo força a saída');
    aoParar();
  });
}

async function coletar(controle, opcoes) {
  if (!opcoes.pleito) throw new Error('informe --pleito (veja "tse-auditor eleicoes")');
  await controle.aplicar({
    pleitos: lista(opcoes.pleito),
    ufs: opcoes.uf ? lista(opcoes.uf) : UFS,
    concorrencia: opcoes.concorrencia ?? PADRAO.concorrencia,
  }, { salvar: false });
  console.log(`dados em ${controle.configuracao().dados}`);
  let ativo = true;
  const relogio = setInterval(async () => {
    if (!ativo) return;
    try {
      const estado = await controle.obterEstado();
      if (ativo) console.log(linhaDeProgresso(estado));
    } catch (err) {
      console.error(`erro ao ler o progresso: ${err.message}`);
    }
  }, 10_000);
  tratarCtrlC(controle, () => controle.coletor.parar());
  await controle.coletor.executar();
  ativo = false;
  clearInterval(relogio);
  const estado = await controle.obterEstado();
  console.log(linhaDeProgresso(estado));
  if (estado.disco.projecaoBytes != null) {
    console.log(`projeção do total: ${fmtBytes(estado.disco.projecaoBytes)}${estado.disco.projecaoPreliminar ? ' (preliminar)' : ''}`);
  }
  console.log(`fim: ${estado.coleta.motivoParada}`);
  await controle.fechar();
  if (estado.coleta.motivoParada !== 'concluída') process.exitCode = 1;
}

async function painel(controle, opcoes) {
  const inicial = configInicial(opcoes, await lerConfigSalva(controle.arquivoConfig));
  if (inicial) {
    try {
      await controle.aplicar(inicial.config, { iniciar: !opcoes['sem-iniciar'] });
    } catch (err) {
      if (inicial.origem === 'linha de comando') throw err;
      console.error(`configuração salva não aplicada (${err.message}); escolha outra no painel`);
    }
  } else if (opcoes.uf !== undefined || opcoes.concorrencia !== undefined) {
    console.error('sem --pleito nem configuração salva: escolha os pleitos no painel');
  }

  const porta = opcoes.porta ?? PADRAO.porta;
  const servidor = criarPainel({ controle });
  try {
    await new Promise((resolve, reject) => {
      servidor.once('error', reject);
      servidor.listen(porta, '127.0.0.1', resolve);
    });
  } catch (err) {
    await controle.fechar();
    throw err.code === 'EADDRINUSE' ? new Error(`porta ${porta} em uso; use --porta`) : err;
  }
  if (!controle.configuracao()) console.log('sem configuração: escolha pleitos e UFs no painel');
  console.log(`painel em http://localhost:${servidor.address().port}`);
  tratarCtrlC(controle, async () => {
    await controle.fechar();
    process.exit(0);
  });
}

async function extrair(opcoes) {
  if (!opcoes.uf) throw new Error('informe --uf');
  const dados = opcoes.dados ?? pastaDados(PADRAO.hd, 'ele2026');
  for (const uf of lista(opcoes.uf)) {
    const inicio = Date.now();
    const stats = await extrairUF({
      dados, uf, pleitos: opcoes.pleito ? lista(opcoes.pleito) : undefined,
      aoProgresso: (p) => process.stderr.write(`\r${uf} ${p.pleito} mun ${p.mun}: ${p.secoes} seções, ${p.comInconsistencia} com inconsistência   `),
    });
    process.stderr.write('\n');
    console.log(JSON.stringify({ uf, segundos: Math.round((Date.now() - inicio) / 1000), ...stats }, null, 2));
  }
}

async function analisar(opcoes) {
  if (!opcoes.uf) throw new Error('informe --uf');
  const dados = opcoes.dados ?? pastaDados(PADRAO.hd, 'ele2026');
  let turnos;
  let eleicoes;
  if (opcoes.turnos !== undefined) {
    const [primeiro = null, segundo = null] = lista(opcoes.turnos).map(Number);
    turnos = { primeiro, segundo };
  } else {
    eleicoes = await buscarEleicoes(new HttpClient({ concorrencia: 1, userAgent: PADRAO.userAgent }), PADRAO);
  }
  for (const uf of lista(opcoes.uf)) {
    const inicio = Date.now();
    const r = await analisarUF({ dados, uf, turnos, eleicoes });
    const { destino, rows } = r;
    const { contagem, ranking } = resumir(rows);
    console.log(JSON.stringify({ uf, segundos: Math.round((Date.now() - inicio) / 1000), destino, turnos: r.turnos, achados: rows.length, contagem }, null, 2));
    console.log('top 10 seções (mun/zona/secao, pontuação máxima, sinais, explicações candidatas):');
    for (const s of ranking) console.log(`  ${s.secao}  ${s.max}  ${s.sinais.join(' ')}  [${s.explicacoes.join(',')}]`);
  }
}

function inteiro(valor, nome, minimo = 1) {
  if (valor === undefined) return undefined;
  if (!/^\d+$/.test(valor) || Number(valor) < minimo) {
    throw new Error(`${nome} precisa ser um inteiro ${minimo ? 'positivo' : 'não negativo'}: ${valor}`);
  }
  return Number(valor);
}

async function main(argv) {
  const { values: opcoes, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pleito: { type: 'string' },
      uf: { type: 'string' },
      dados: { type: 'string' },
      concorrencia: { type: 'string' },
      porta: { type: 'string' },
      turnos: { type: 'string' },
      'sem-iniciar': { type: 'boolean' },
    },
  });
  const [comando] = positionals;
  if (!['eleicoes', 'coletar', 'painel', 'extrair', 'analisar'].includes(comando)) {
    console.log(AJUDA);
    process.exitCode = 1;
    return;
  }
  if (comando === 'extrair') return extrair(opcoes);
  if (comando === 'analisar') return analisar(opcoes);
  opcoes.concorrencia = inteiro(opcoes.concorrencia, '--concorrencia');
  opcoes.porta = inteiro(opcoes.porta, '--porta', 0); // 0: porta livre qualquer
  const http = new HttpClient({ concorrencia: PADRAO.concorrencia, userAgent: PADRAO.userAgent });
  const eleicoes = await buscarEleicoes(http, PADRAO);
  if (comando === 'eleicoes') return listarEleicoes(eleicoes);
  const controle = new ControleColeta({ ...PADRAO, eleicoes, dadosFixo: opcoes.dados });
  if (comando === 'coletar') return coletar(controle, opcoes);
  return painel(controle, opcoes);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`erro: ${err.message}`);
  process.exitCode = 1;
});
