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

  // Baixa o índice da seção e todos os conjuntos de arquivos, verificando cada um.
  // Falhas ficam registradas no manifest; só erros de disco sobem (e param a coleta).
  async processarSecao(s) {
    const falhar = (erro) => this.manifest.finalizarSecao(s, { status: 'erro', erro });
    let r;
    try {
      r = await this.http.get(this.urls.indiceSecao({ ciclo: this.ciclo, ...s }));
    } catch (err) {
      return falhar(`índice: ${err.message}`);
    }
    if (r.status !== 200) return falhar(`índice: HTTP ${r.status}`);
    let indice;
    try {
      indice = lerIndiceSecao(JSON.parse(r.body.toString('utf8')));
    } catch (err) {
      return falhar(`índice ilegível: ${err.message}`);
    }

    const staging = this.#pastaStaging(s.pleito, s.uf, s.mun);
    await gravarAtomico(path.join(staging, s.zona, s.secao, nomeIndiceSecao(s)), r.body);
    if (indice.conjuntos.length === 0) {
      this.manifest.finalizarSecao(s, { status: 'sem_arquivos' });
      return;
    }

    this.manifest.registrarIndice(s, indice.conjuntos, (hash, nome) => this.urls.arquivo({ ciclo: this.ciclo, ...s }, hash, nome));
    for (const { hash } of indice.conjuntos) await this.#baixarConjunto(s, hash, staging);

    const arquivos = this.manifest.arquivosDaSecao(s);
    const bytes = arquivos.reduce((total, a) => total + (a.bytes ?? 0), 0);
    const falha = arquivos.find((a) => a.status !== 'ok');
    this.manifest.finalizarSecao(s, falha
      ? { status: 'erro', bytes, erro: `${falha.nome}: ${falha.erro}` }
      : { status: 'completa', bytes });
  }

  // Primeiro o .vsc (conferido contra o hash do diretório); depois os demais, conferidos pelo sha512 no .vsc.
  // O .vsc é baixado de novo sempre que o conjunto tem pendências, porque pode já estar só no zip.
  async #baixarConjunto(s, hash, staging) {
    const registros = this.manifest.arquivosDaSecao(s).filter((a) => a.hash === hash);
    if (registros.every((a) => a.status === 'ok')) return;
    const pasta = path.join(staging, s.zona, s.secao, hash);

    const regVsc = registros.find((a) => a.nome.endsWith('.vsc'));
    let vsc = null;
    if (regVsc) {
      vsc = await this.#baixarArquivo(s, regVsc, pasta, (buf) => (vscConfereComDiretorio(buf, hash)
        ? { verificacao: 'dir' }
        : { erro: 'sha256 do .vsc não confere com o hash do diretório' }));
    }

    for (const reg of registros) {
      if (reg === regVsc || reg.status === 'ok') continue;
      if (regVsc && !vsc) {
        this.manifest.marcarArquivo(s, reg.hash, reg.nome, { status: 'erro', erro: '.vsc inválido; arquivo não baixado' });
        continue;
      }
      await this.#baixarArquivo(s, reg, pasta, (buf) => {
        if (vsc && vscContemSha512(vsc, buf)) return { verificacao: 'vsc' };
        if (vsc && TIPOS_NO_VSC.has(reg.tipo)) return { erro: 'sha512 não consta no .vsc' };
        return { verificacao: 'md5' };
      });
    }
  }

  // Devolve o conteúdo verificado, ou null depois de registrar o erro.
  // Conteúdo que não confere é baixado de novo até TENTATIVAS_VERIFICACAO vezes.
  async #baixarArquivo(s, reg, pasta, verificar) {
    let erro;
    for (let tentativa = 1; tentativa <= TENTATIVAS_VERIFICACAO; tentativa++) {
      let r;
      try {
        r = await this.http.get(reg.url);
      } catch (err) {
        erro = err.message;
        break;
      }
      if (r.status !== 200) {
        erro = `HTTP ${r.status}`;
        break;
      }
      const md5Real = md5(r.body);
      const md5Servidor = md5DoEtag(r.etag);
      if (md5Servidor && md5Servidor !== md5Real) {
        erro = 'md5 não confere com o ETag';
        continue;
      }
      const v = verificar(r.body);
      if (v.erro) {
        erro = v.erro;
        continue;
      }
      await gravarAtomico(path.join(pasta, reg.nome), r.body);
      this.manifest.marcarArquivo(s, reg.hash, reg.nome, {
        status: 'ok', bytes: r.body.length, md5: md5Real, sha512: sha512Hex(r.body), verificacao: v.verificacao,
      });
      this.#contarBytes(r.body.length);
      return r.body;
    }
    this.manifest.marcarArquivo(s, reg.hash, reg.nome, { status: 'erro', erro });
    return null;
  }

  #contarBytes(n) {
    this.#amostras.push([this.agora(), n]);
    this.#podarAmostras();
  }

  #podarAmostras() {
    const limite = this.agora() - JANELA_VELOCIDADE_MS;
    while (this.#amostras.length && this.#amostras[0][0] < limite) this.#amostras.shift();
  }

  // Média de bytes por segundo no último minuto.
  velocidadeBps() {
    this.#podarAmostras();
    return this.#amostras.reduce((total, [, n]) => total + n, 0) / (JANELA_VELOCIDADE_MS / 1000);
  }

  aguardar() {
    return this.#execucao ?? Promise.resolve();
  }
}
