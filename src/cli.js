#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PADRAO, pastaDados } from './config.js';
import { UFS } from './ufs.js';
import { fmtBytes, linhaDeProgresso } from './formatar.js';
import { HttpClient } from './net/http.js';
import { buscarEleicoes } from './tse/eleicoes.js';
import { criarUrls } from './tse/urls.js';
import { Manifest } from './storage/manifest.js';
import { bytesLivres, garantirVolume } from './storage/disco.js';
import { Coletor } from './coleta/coletor.js';
import { montarEstado } from './coleta/estado.js';
import { criarPainel } from './painel/server.js';

const AJUDA = `uso:
  tse-auditor eleicoes
  tse-auditor coletar --pleito 3220,3221 [--uf ac,al] [--dados <pasta>] [--concorrencia 4]
  tse-auditor painel  --pleito 3220,3221 [--uf ac,al] [--dados <pasta>] [--concorrencia 4] [--porta 3000] [--sem-iniciar]`;

function listarEleicoes({ pleitos }) {
  for (const p of pleitos) {
    console.log(`${p.cd.padEnd(6)} ${p.ciclo}  ${p.data}`);
    for (const e of p.eleicoes) {
      const cargos = e.cargos.map((c) => c.nome).join(', ');
      console.log(`    ${e.cd} ${e.turno}º turno  ${e.nome}${cargos ? ` (${cargos})` : ''}`);
    }
  }
}

async function montarColeta(opcoes, { templates, pleitos: todos }, http, concorrencia) {
  if (!opcoes.pleito) throw new Error('informe --pleito (veja "tse-auditor eleicoes")');
  const pleitos = opcoes.pleito.split(',').map((p) => p.trim());
  const escolhidos = pleitos.map((cd) => {
    const p = todos.find((x) => x.cd === cd);
    if (!p) throw new Error(`pleito ${cd} não existe no ele-c.json`);
    return p;
  });
  const ciclos = [...new Set(escolhidos.map((p) => p.ciclo))];
  if (ciclos.length !== 1) throw new Error(`os pleitos precisam ser do mesmo ciclo: ${ciclos.join(', ')}`);
  const [ciclo] = ciclos;

  const ufs = opcoes.uf ? opcoes.uf.toLowerCase().split(',').map((u) => u.trim()) : UFS;
  for (const uf of ufs) if (!UFS.includes(uf)) throw new Error(`UF desconhecida: ${uf}`);

  if (!opcoes.dados) await garantirVolume(PADRAO.hd);
  const dados = opcoes.dados ?? pastaDados(PADRAO.hd, ciclo);
  await mkdir(dados, { recursive: true });

  const manifest = new Manifest(path.join(dados, 'manifest.sqlite'));
  const coletor = new Coletor({
    manifest,
    http,
    urls: criarUrls({ base: PADRAO.base, ambiente: PADRAO.ambiente, templates }),
    pastaDados: dados,
    ciclo,
    pleitos,
    ufs,
    minLivreBytes: PADRAO.minLivreBytes,
    concorrencia,
  });
  const obterEstado = () => montarEstado({ manifest, coletor, pastaDados: dados, bytesLivres });
  return { manifest, coletor, obterEstado, dados };
}

function fecharManifest(manifest) {
  try {
    manifest.fechar();
  } catch (err) {
    console.error(`erro ao fechar o manifest: ${err.message}`);
  }
}

// Primeiro Ctrl-C: parada ordenada. Segundo: força a saída (fecha o manifest se der).
function tratarCtrlC(coletor, manifest, aoParar) {
  let vezes = 0;
  process.on('SIGINT', async () => {
    vezes++;
    if (vezes > 1) {
      fecharManifest(manifest);
      process.exit(130);
    }
    console.log('encerrando: aguardando o município atual; Ctrl-C de novo força a saída');
    coletor.parar();
    aoParar?.();
  });
}

async function coletar({ manifest, coletor, obterEstado, dados }) {
  console.log(`dados em ${dados}`);
  let ativo = true;
  const relogio = setInterval(async () => {
    if (!ativo) return;
    try {
      const estado = await obterEstado();
      if (ativo) console.log(linhaDeProgresso(estado));
    } catch (err) {
      console.error(`erro ao ler o progresso: ${err.message}`);
    }
  }, 10_000);
  tratarCtrlC(coletor, manifest);
  await coletor.executar();
  ativo = false;
  clearInterval(relogio);
  const estado = await obterEstado();
  console.log(linhaDeProgresso(estado));
  if (estado.disco.projecaoBytes != null) {
    console.log(`projeção do total: ${fmtBytes(estado.disco.projecaoBytes)}${estado.disco.projecaoPreliminar ? ' (preliminar)' : ''}`);
  }
  console.log(`fim: ${estado.coleta.motivoParada}`);
  fecharManifest(manifest);
  if (estado.coleta.motivoParada !== 'concluída') process.exitCode = 1;
}

async function painel({ manifest, coletor, obterEstado }, opcoes) {
  const porta = Number(opcoes.porta ?? PADRAO.porta);
  const servidor = criarPainel({ obterEstado, coletor });
  try {
    await new Promise((resolve, reject) => {
      servidor.once('error', reject);
      servidor.listen(porta, '127.0.0.1', resolve);
    });
  } catch (err) {
    fecharManifest(manifest);
    throw err.code === 'EADDRINUSE' ? new Error(`porta ${porta} em uso; use --porta`) : err;
  }
  console.log(`painel em http://localhost:${porta}`);
  tratarCtrlC(coletor, manifest, async () => {
    await coletor.aguardar();
    fecharManifest(manifest);
    process.exit(0);
  });
  if (!opcoes['sem-iniciar']) coletor.executar();
}

function inteiroPositivo(valor, nome) {
  if (valor === undefined) return undefined;
  if (!/^\d+$/.test(valor) || Number(valor) < 1) throw new Error(`${nome} precisa ser um inteiro positivo: ${valor}`);
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
      'sem-iniciar': { type: 'boolean' },
    },
  });
  const [comando] = positionals;
  if (!['eleicoes', 'coletar', 'painel'].includes(comando)) {
    console.log(AJUDA);
    process.exitCode = 1;
    return;
  }
  const concorrencia = inteiroPositivo(opcoes.concorrencia, '--concorrencia') ?? PADRAO.concorrencia;
  const porta = inteiroPositivo(opcoes.porta, '--porta');
  if (porta !== undefined) opcoes.porta = String(porta);
  const http = new HttpClient({ concorrencia, userAgent: PADRAO.userAgent });
  const eleicoes = await buscarEleicoes(http, PADRAO);
  if (comando === 'eleicoes') return listarEleicoes(eleicoes);
  const coleta = await montarColeta(opcoes, eleicoes, http, concorrencia);
  if (comando === 'coletar') return coletar(coleta);
  return painel(coleta, opcoes);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`erro: ${err.message}`);
  process.exitCode = 1;
});
