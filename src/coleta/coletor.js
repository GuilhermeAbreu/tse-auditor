import { EventEmitter } from 'node:events';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lerConfigSecoes } from '../tse/configSecoes.js';
import { lerIndiceSecao } from '../tse/indiceSecao.js';
import { nomeConfigSecoes, nomeIndiceSecao } from '../tse/urls.js';
import { md5, md5DoEtag, sha512Hex, vscConfereComDiretorio, vscContemSha512 } from '../tse/integridade.js';
import { empacotarMunicipio } from '../storage/empacotar.js';
import { bytesLivres as bytesLivresDoDisco, ehErroDeVolume, garantirVolume } from '../storage/disco.js';

const TIPOS_NO_VSC = new Set(['bu', 'rdv', 'log']);
const TENTATIVAS_VERIFICACAO = 3;
const JANELA_VELOCIDADE_MS = 60_000;
const GB = 1024 ** 3;

export class EspacoInsuficienteError extends Error {}

async function gravarAtomico(caminho, conteudo) {
  await mkdir(path.dirname(caminho), { recursive: true });
  await writeFile(`${caminho}.part`, conteudo);
  await rename(`${caminho}.part`, caminho);
}

async function existe(caminho) {
  try {
    await access(caminho);
    return true;
  } catch {
    return false;
  }
}

// Executa fn sobre os itens com no máximo `limite` em paralelo. Na primeira falha os demais
// trabalhadores param de pegar itens; espera todos terminarem e relança o erro.
async function emParalelo(itens, limite, fn) {
  let proximo = 0;
  let falhou = false;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (!falhou && proximo < itens.length) {
      try {
        await fn(itens[proximo++]);
      } catch (err) {
        falhou = true;
        throw err;
      }
    }
  });
  const resultados = await Promise.allSettled(trabalhadores);
  const rejeitado = resultados.find((r) => r.status === 'rejected');
  if (rejeitado) throw rejeitado.reason;
}

export class Coletor extends EventEmitter {
  #parar = false;
  #planejado = false;
  #execucao = null;
  #amostras = [];

  constructor({
    manifest, http, urls, pastaDados, ciclo, pleitos, ufs, minLivreBytes,
    concorrencia = 4, bytesLivres = bytesLivresDoDisco, agora = Date.now,
  }) {
    super();
    Object.assign(this, { manifest, http, urls, pastaDados, ciclo, pleitos, ufs, minLivreBytes, concorrencia, bytesLivres, agora });
    this.estado = { rodando: false, ufAtual: null, municipioAtual: null, motivoParada: null };
  }

  #pastaRaw(uf) {
    return path.join(this.pastaDados, 'raw', uf.toUpperCase());
  }

  #caminhoZip(pleito, uf, mun) {
    return path.join(this.#pastaRaw(uf), pleito, `${mun}.zip`);
  }

  #pastaStaging(pleito, uf, mun) {
    return path.join(this.pastaDados, 'staging', uf.toUpperCase(), pleito, mun);
  }

  // Baixa a config de seções de cada UF × pleito, guarda o original em raw/ e registra as seções.
  async planejar() {
    this.manifest.registrarUfs(this.ufs);
    for (const uf of this.ufs) {
      for (const pleito of this.pleitos) {
        const url = this.urls.configSecoes({ ciclo: this.ciclo, pleito, uf });
        const r = await this.http.get(url);
        if (r.status === 404) {
          this.manifest.registrarEvento('aviso', uf, `pleito ${pleito} sem configuração de seções para ${uf.toUpperCase()} (HTTP 404)`);
          continue;
        }
        if (r.status !== 200) throw new Error(`configuração de seções ${uf.toUpperCase()}/${pleito}: HTTP ${r.status} (${url})`);
        await gravarAtomico(path.join(this.#pastaRaw(uf), pleito, nomeConfigSecoes({ pleito, uf })), r.body);
        this.manifest.registrarConfig(pleito, uf, lerConfigSecoes(JSON.parse(r.body.toString('utf8'))).municipios);
      }
    }
  }

  aguardar() {
    return this.#execucao ?? Promise.resolve();
  }
}
