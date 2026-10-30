import { EventEmitter } from 'node:events';
import { setTimeout as espera } from 'node:timers/promises';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../net/http.ts';
import { lerConfigSecoes } from '../tse/configSecoes.ts';
import { lerIndiceSecao } from '../tse/indiceSecao.ts';
import { nomeConfigSecoes, nomeIndiceSecao } from '../tse/urls.ts';
import { md5, md5DoEtag, sha512Hex, vscConfereComDiretorio, vscContemSha512 } from '../tse/integridade.ts';
import { empacotarMunicipio, listarNomesZip, ZipCorrompidoError } from '../storage/empacotar.ts';
import { bytesLivres as bytesLivresDoDisco, ehErroDeVolume, garantirVolume } from '../storage/disco.ts';
import { TIPOS_OPCIONAIS } from '../storage/manifest.ts';
import type { ArquivoLinha, Manifest } from '../storage/manifest.ts';
import type { Urls } from '../tse/urls.ts';
import type { ClienteHttp, EstadoColeta, IndiceSecao, RespostaHttp, SecaoChave } from '../tipos/dominio.ts';
import type { ConfigSecoesJson, IndiceSecaoJson } from '../tipos/tse.ts';

type Verificacao = { verificacao: string; erro?: undefined } | { erro: string; verificacao?: undefined };
type Ctx = { novos: number };
const mensagem = (err: unknown) => (err as Error).message;

export interface OpcoesColetor {
  manifest: Manifest;
  http: ClienteHttp;
  urls: Urls;
  pastaDados: string;
  ciclo: string;
  pleitos: string[];
  ufs: string[];
  minLivreBytes: number;
  concorrencia?: number;
  bytesLivres?: (pasta: string) => Promise<number>;
  agora?: () => number;
  limiteFalhasRede?: number;
  tentativasVerificacao?: number;
  esperaSegundaPassadaMs?: number | null; // pausa antes de tentar de novo as seções com erro da UF (padrão 30 s; null desliga)
}

export { TIPOS_OPCIONAIS };
const TIPOS_NO_VSC = new Set(['bu', 'rdv', 'log']);
const JANELA_VELOCIDADE_MS = 60_000;
const GB = 1024 ** 3;

export class EspacoInsuficienteError extends Error {}
export class SemConexaoError extends Error {}

const HASH_VALIDO = /^[0-9a-f]+$/i;
const NOME_VALIDO = /^[\w.-]+$/;

// Devolve a descrição do problema do índice, ou null se estiver íntegro.
function problemaNoIndice(indice: IndiceSecao): string | null {
  for (const { hash, arquivos } of indice.conjuntos) {
    if (typeof hash !== 'string' || !HASH_VALIDO.test(hash)) return `hash inválido (${JSON.stringify(hash)})`;
    if (arquivos.length === 0) return `conjunto ${hash} sem arquivos`;
    for (const { nome } of arquivos) {
      if (typeof nome !== 'string' || !NOME_VALIDO.test(nome) || nome === '.' || nome === '..') {
        return `nome de arquivo inválido (${JSON.stringify(nome)})`;
      }
    }
  }
  return null;
}

async function gravarAtomico(caminho: string, conteudo: Buffer): Promise<void> {
  await mkdir(path.dirname(caminho), { recursive: true });
  await writeFile(`${caminho}.part`, conteudo);
  await rename(`${caminho}.part`, caminho);
}

async function existe(caminho: string): Promise<boolean> {
  try {
    await access(caminho);
    return true;
  } catch {
    return false;
  }
}

// Executa fn sobre os itens com no máximo `limite` em paralelo. Na primeira falha os demais
// trabalhadores param de pegar itens; espera todos terminarem e relança o erro.
async function emParalelo<T>(itens: T[], limite: number, fn: (item: T) => Promise<void>): Promise<void> {
  let proximo = 0;
  let falhou = false;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (!falhou && proximo < itens.length) {
      try {
        await fn(itens[proximo++]!);
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
  #execucao: Promise<void> | null = null;
  #amostras: [number, number][] = [];
  #tentadas = new Set<string>();
  #falhasRede = 0;
  declare manifest: Manifest;
  declare http: ClienteHttp;
  declare urls: Urls;
  declare pastaDados: string;
  declare ciclo: string;
  declare pleitos: string[];
  declare ufs: string[];
  declare minLivreBytes: number;
  declare concorrencia: number;
  declare bytesLivres: (pasta: string) => Promise<number>;
  declare agora: () => number;
  declare limiteFalhasRede: number;
  declare tentativasVerificacao: number;
  declare esperaSegundaPassadaMs: number | null;
  estado: EstadoColeta;

  constructor({
    manifest, http, urls, pastaDados, ciclo, pleitos, ufs, minLivreBytes,
    concorrencia = 4, bytesLivres = bytesLivresDoDisco, agora = Date.now, limiteFalhasRede = 20, tentativasVerificacao = 3,
    esperaSegundaPassadaMs = 30_000,
  }: OpcoesColetor) {
    super();
    Object.assign(this, { manifest, http, urls, pastaDados, ciclo, pleitos, ufs, minLivreBytes, concorrencia, bytesLivres, agora, limiteFalhasRede, tentativasVerificacao, esperaSegundaPassadaMs });
    this.estado = { rodando: false, ufAtual: null, municipioAtual: null, motivoParada: null };
  }

  #pastaRaw(uf: string): string {
    return path.join(this.pastaDados, 'raw', uf.toUpperCase());
  }

  #caminhoZip(pleito: string, uf: string, mun: string): string {
    return path.join(this.#pastaRaw(uf), pleito, `${mun}.zip`);
  }

  #pastaStaging(pleito: string, uf: string, mun: string): string {
    return path.join(this.pastaDados, 'staging', uf.toUpperCase(), pleito, mun);
  }

  // GET com disjuntor: falhas de rede (sem resposta HTTP) seguidas interrompem a coleta.
  async #get(url: string): Promise<RespostaHttp> {
    try {
      const r = await this.http.get(url);
      this.#falhasRede = 0;
      return r;
    } catch (err) {
      if (err instanceof HttpError && err.status === undefined && ++this.#falhasRede >= this.limiteFalhasRede) {
        throw new SemConexaoError(`sem conexão com o TSE: ${this.#falhasRede} falhas de rede seguidas; coleta interrompida`);
      }
      throw err;
    }
  }

  // Baixa a config de seções de cada UF × pleito, guarda o original em raw/ e registra as seções.
  async planejar(): Promise<void> {
    this.manifest.registrarUfs(this.ufs);
    for (const uf of this.ufs) {
      for (const pleito of this.pleitos) {
        const url = this.urls.configSecoes({ ciclo: this.ciclo, pleito, uf });
        const r = await this.#get(url);
        if (r.status === 404) {
          this.manifest.registrarEvento('aviso', uf, `pleito ${pleito} sem configuração de seções para ${uf.toUpperCase()} (HTTP 404)`);
          continue;
        }
        if (r.status !== 200) {
          this.manifest.registrarEvento('aviso', uf, `pleito ${pleito}: configuração de seções de ${uf.toUpperCase()} ignorada (HTTP ${r.status})`);
          continue;
        }
        await gravarAtomico(path.join(this.#pastaRaw(uf), pleito, nomeConfigSecoes({ pleito, uf })), r.body);
        this.manifest.registrarConfig(pleito, uf, lerConfigSecoes(JSON.parse(r.body.toString('utf8')) as ConfigSecoesJson).municipios);
      }
    }
  }

  // Baixa o índice da seção e todos os conjuntos de arquivos, verificando cada um.
  // Falhas ficam registradas no manifest; só erros de disco sobem (e param a coleta).
  async processarSecao(s: SecaoChave): Promise<void> {
    const falhar = (erro: string) => this.manifest.finalizarSecao(s, { status: 'erro', erro });
    let r: RespostaHttp;
    try {
      r = await this.#get(this.urls.indiceSecao({ ciclo: this.ciclo, ...s }));
    } catch (err) {
      if (err instanceof SemConexaoError) throw err;
      return falhar(`índice: ${mensagem(err)}`);
    }
    if (r.status !== 200) return falhar(`índice: HTTP ${r.status}`);
    let indice: IndiceSecao;
    try {
      indice = lerIndiceSecao(JSON.parse(r.body.toString('utf8')) as IndiceSecaoJson);
    } catch (err) {
      return falhar(`índice ilegível: ${mensagem(err)}`);
    }
    const problema = problemaNoIndice(indice);
    if (problema) return falhar(`índice inválido: ${problema}`);

    const staging = this.#pastaStaging(s.pleito, s.uf, s.mun);
    const gravarIndice = () => gravarAtomico(path.join(staging, s.zona, s.secao, nomeIndiceSecao(s)), r.body);
    if (indice.conjuntos.length === 0) {
      await gravarIndice();
      this.manifest.finalizarSecao(s, { status: 'sem_arquivos' });
      return;
    }

    this.manifest.registrarIndice(s, indice.conjuntos, (hash, nome) => this.urls.arquivo({ ciclo: this.ciclo, ...s }, hash, nome));
    const ctx = { novos: 0 };
    for (const { hash } of indice.conjuntos) await this.#baixarConjunto(s, hash, staging, ctx);

    const arquivos = this.manifest.arquivosDaSecao(s);
    const bytes = arquivos.reduce((total, a) => total + (a.bytes ?? 0), 0);
    const falha = arquivos.find((a) => a.status !== 'ok' && a.status !== 'indisponivel');
    // O índice só vai para o staging quando há algo novo para o zip (evita reempacotar à toa).
    if (!falha || ctx.novos > 0) await gravarIndice();
    this.manifest.finalizarSecao(s, falha
      ? { status: 'erro', bytes, erro: `${falha.nome}: ${falha.erro}` }
      : { status: 'completa', bytes });
  }

  // Primeiro o .vsc (conferido contra o hash do diretório); depois os demais, conferidos pelo sha512 no .vsc.
  // O .vsc é baixado de novo sempre que o conjunto tem pendências, porque pode já estar só no zip.
  async #baixarConjunto(s: SecaoChave, hash: string, staging: string, ctx: Ctx): Promise<void> {
    const registros = this.manifest.arquivosDaSecao(s).filter((a) => a.hash === hash);
    if (registros.every((a) => a.status === 'ok' || a.status === 'indisponivel')) return;
    const pasta = path.join(staging, s.zona, s.secao, hash);

    const regVsc = registros.find((a) => a.nome.endsWith('.vsc'));
    let vsc: Buffer | null = null;
    if (regVsc) {
      vsc = await this.#baixarArquivo(s, regVsc, pasta, ctx, (buf) => (vscConfereComDiretorio(buf, hash)
        ? { verificacao: 'dir' }
        : { erro: 'sha256 do .vsc não confere com o hash do diretório' }));
    }

    for (const reg of registros) {
      if (reg === regVsc || reg.status === 'ok') continue;
      if (regVsc && !vsc) {
        this.manifest.marcarArquivo(s, reg.hash, reg.nome, { status: 'erro', erro: '.vsc inválido; arquivo não baixado' });
        continue;
      }
      await this.#baixarArquivo(s, reg, pasta, ctx, (buf, { md5Verificado }) => {
        if (vsc && vscContemSha512(vsc, buf)) return { verificacao: 'vsc' };
        if (vsc && TIPOS_NO_VSC.has(reg.tipo ?? '')) return { erro: 'sha512 não consta no .vsc' };
        return { verificacao: md5Verificado ? 'md5' : 'nenhuma' };
      });
    }
  }

  // Devolve o conteúdo verificado, ou null depois de registrar o erro.
  // Conteúdo que não confere é baixado de novo até `tentativasVerificacao` vezes.
  async #baixarArquivo(
    s: SecaoChave, reg: ArquivoLinha, pasta: string, ctx: Ctx,
    verificar: (buf: Buffer, info: { md5Verificado: boolean }) => Verificacao,
  ): Promise<Buffer | null> {
    let erro: string | undefined;
    for (let tentativa = 1; tentativa <= this.tentativasVerificacao; tentativa++) {
      let r: RespostaHttp;
      try {
        r = await this.#get(reg.url);
      } catch (err) {
        if (err instanceof SemConexaoError) throw err;
        erro = mensagem(err);
        break;
      }
      if (r.status === 404 && TIPOS_OPCIONAIS.has(reg.tipo ?? '')) {
        this.manifest.marcarArquivo(s, reg.hash, reg.nome, { status: 'indisponivel', erro: 'não publicado pelo TSE (HTTP 404)' });
        return null;
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
      const v = verificar(r.body, { md5Verificado: Boolean(md5Servidor) });
      if (v.erro) {
        erro = v.erro;
        continue;
      }
      // Arquivo já ok no manifest só é rebaixado para servir de referência (.vsc); já está no zip.
      if (reg.status !== 'ok') {
        await gravarAtomico(path.join(pasta, reg.nome), r.body);
        ctx.novos++;
      }
      this.manifest.marcarArquivo(s, reg.hash, reg.nome, {
        status: 'ok', bytes: r.body.length, md5: md5Real, sha512: sha512Hex(r.body), verificacao: v.verificacao,
      });
      this.#contarBytes(r.body.length);
      return r.body;
    }
    this.manifest.marcarArquivo(s, reg.hash, reg.nome, { status: 'erro', erro });
    return null;
  }

  #contarBytes(n: number): void {
    this.#amostras.push([this.agora(), n]);
    this.#podarAmostras();
  }

  #podarAmostras() {
    const limite = this.agora() - JANELA_VELOCIDADE_MS;
    while (this.#amostras.length && this.#amostras[0]![0] < limite) this.#amostras.shift();
  }

  // Média de bytes por segundo no último minuto.
  velocidadeBps(): number {
    this.#podarAmostras();
    return this.#amostras.reduce((total, [, n]) => total + n, 0) / (JANELA_VELOCIDADE_MS / 1000);
  }

  aguardar(): Promise<void> {
    return this.#execucao ?? Promise.resolve();
  }

  // Uma execução por vez: chamar de novo enquanto roda devolve a mesma promessa.
  // Nunca rejeita: o motivo da parada fica em estado.motivoParada e nos eventos do manifest.
  executar(): Promise<void> {
    this.#execucao ??= this.#executar().finally(() => {
      this.#execucao = null;
    });
    return this.#execucao;
  }

  parar() {
    this.#parar = true;
  }

  pausar(uf: string): void {
    this.manifest.definirPausa(uf, true);
    this.emit('mudou');
  }

  retomar(uf: string): Promise<void> {
    this.manifest.definirPausa(uf, false);
    this.#tentadas.delete(uf);
    this.emit('mudou');
    return this.executar();
  }

  async #executar() {
    this.#parar = false;
    this.#falhasRede = 0;
    Object.assign(this.estado, { rodando: true, motivoParada: null });
    this.emit('mudou');
    try {
      await garantirVolume(this.pastaDados);
      if (!this.#planejado) {
        await this.planejar();
        this.#planejado = true;
      }
      this.#tentadas = new Set();
      let uf: string | undefined;
      while (!this.#parar && (uf = this.#proximaUf(this.#tentadas))) {
        this.#tentadas.add(uf);
        await this.#coletarUf(uf);
      }
      this.estado.motivoParada = this.#parar ? 'parada solicitada' : 'concluída';
      this.manifest.registrarEvento('info', null, `coleta ${this.estado.motivoParada}`);
    } catch (err) {
      const volume = ehErroDeVolume(err) || !(await existe(this.pastaDados));
      this.estado.motivoParada = volume ? `HD inacessível: ${mensagem(err)}` : mensagem(err);
      try {
        this.manifest.registrarEvento('erro', this.estado.ufAtual, this.estado.motivoParada);
      } catch {
        // o manifest está no mesmo HD; se ele sumiu, não há onde registrar
      }
    } finally {
      try {
        this.manifest.descarregar();
      } catch {
        // falha de commit fica em manifest.erro
      }
      Object.assign(this.estado, { rodando: false, ufAtual: null, municipioAtual: null });
      this.emit('mudou');
    }
  }

  // Próxima UF, na ordem de coleta, que não está pausada e ainda não foi tentada nesta execução.
  // Uma UF despausada no meio da execução entra na fila.
  #proximaUf(tentadas: Set<string>): string | undefined {
    return this.manifest.ufs().find((u) => this.ufs.includes(u.uf) && !u.pausada && !tentadas.has(u.uf))?.uf;
  }

  #deveParar(uf: string): boolean {
    return this.#parar || this.manifest.ufPausada(uf);
  }

  // Município por município, os dois turnos juntos. No fim, se sobrou seção com erro (falha momentânea do servidor,
  // por exemplo), espera um pouco e passa mais uma vez só pelos municípios com erro.
  async #coletarUf(uf: string): Promise<void> {
    this.estado.ufAtual = uf;
    this.emit('mudou');
    for (const { mun } of this.manifest.municipiosDaUf(uf)) {
      for (const pleito of this.pleitos) {
        if (this.#deveParar(uf)) return;
        await this.#coletarMunicipio(pleito, uf, mun);
      }
    }
    if (this.esperaSegundaPassadaMs == null) return;
    const comErro = this.manifest.municipiosComErro(uf).filter((m) => this.pleitos.includes(m.pleito));
    if (!comErro.length) return;
    this.manifest.registrarEvento('info', uf, `${uf.toUpperCase()}: tentando de novo as seções com erro em ${comErro.length} município(s)`);
    const fim = Date.now() + this.esperaSegundaPassadaMs; // espera curta e interrompível
    while (Date.now() < fim) {
      if (this.#deveParar(uf)) return;
      await espera(Math.min(1000, fim - Date.now()));
    }
    for (const { pleito, mun } of comErro) {
      if (this.#deveParar(uf)) return;
      await this.#coletarMunicipio(pleito, uf, mun);
    }
  }

  async #coletarMunicipio(pleito: string, uf: string, mun: string, retentativa = false): Promise<void> {
    const municipio = this.manifest.municipio(pleito, uf, mun);
    if (!municipio) return;
    this.estado.municipioAtual = `${mun} ${municipio.nome}`;
    const staging = this.#pastaStaging(pleito, uf, mun);
    let interrompido = false;
    await emParalelo(this.manifest.secoesPendentes(pleito, uf, mun), this.concorrencia * 2, async (s) => {
      if (this.#deveParar(uf)) {
        interrompido = true;
        return;
      }
      await this.#garantirEspaco();
      await this.processarSecao(s);
    });
    if (interrompido) return; // o staging fica para a próxima execução; não empacota pela metade
    const noStaging = await this.#conferirStaging(pleito, uf, mun, staging);
    if (noStaging === 0) { // nada novo para o zip
      await rm(staging, { recursive: true, force: true });
      return;
    }
    let bytes: number;
    try {
      ({ bytes } = await empacotarMunicipio({
        pastaStaging: staging,
        caminhoZip: this.#caminhoZip(pleito, uf, mun),
        bytesLivres: this.bytesLivres,
        minLivreBytes: this.minLivreBytes,
      }));
    } catch (err) {
      if (!(err instanceof ZipCorrompidoError) || retentativa) throw err;
      this.manifest.reabrirMunicipio(pleito, uf, mun);
      this.manifest.registrarEvento('aviso', uf, `zip corrompido posto de lado e município ${mun} (${pleito}) rebaixado: ${err.caminhoZip}`);
      return this.#coletarMunicipio(pleito, uf, mun, true);
    }
    this.manifest.marcarEmpacotado(pleito, uf, mun, bytes);
  }

  // Antes de empacotar, confere o staging com o manifest e o manifest com staging + zip.
  // Percorre a listagem do staging: só fica o que o manifest dá como ok e cujo conteúdo confere
  // (gravação interrompida deixa arquivo truncado; sobra de execução antiga não pode entrar no zip).
  // Seções afetadas ficam em 'erro' e são retentadas na próxima execução. Devolve quantos arquivos ficaram no staging.
  async #conferirStaging(pleito: string, uf: string, mun: string, staging: string): Promise<number> {
    const aviso = (msg: string) => this.manifest.registrarEvento('aviso', uf, `${pleito} ${mun}: ${msg}`);
    const noStaging = new Set<string>();
    let itens: import('node:fs').Dirent[] = [];
    try {
      itens = await readdir(staging, { recursive: true, withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const d of itens) {
      if (!d.isFile()) continue;
      const caminho = path.join(d.parentPath, d.name);
      const rel = path.relative(staging, caminho).split(path.sep);
      if (d.name.endsWith('.part')) {
        await rm(caminho, { force: true });
        continue;
      }
      const [zona = '', secao = '', hash = ''] = rel;
      const s = { pleito, uf, mun, zona, secao };
      if (rel.length === 3 && d.name.endsWith('-aux.json')) {
        try {
          lerIndiceSecao(JSON.parse((await readFile(caminho)).toString('utf8')) as IndiceSecaoJson);
          noStaging.add(rel.join('/'));
        } catch {
          await rm(caminho, { force: true });
          this.manifest.finalizarSecao(s, { status: 'erro', erro: 'índice no staging ilegível' });
          aviso(`${d.name}: índice no staging ilegível; será baixado de novo`);
        }
        continue;
      }
      const reg = rel.length === 4 ? this.manifest.arquivo(s, hash, d.name) : undefined;
      if (reg?.status === 'ok') {
        const conteudo = await readFile(caminho);
        if (conteudo.length === reg.bytes && sha512Hex(conteudo) === reg.sha512) {
          noStaging.add(rel.join('/'));
          continue;
        }
        await rm(caminho, { force: true });
        this.manifest.marcarArquivoInconsistente(s, hash, d.name, 'conteúdo no staging não confere com o manifest (gravação interrompida?)');
        aviso(`${d.name} (${zona}/${secao}): conteúdo no staging não confere com o manifest; será baixado de novo`);
      } else {
        await rm(caminho, { force: true }); // sem registro ok: não entra no zip; será baixado de novo
      }
    }

    const noZip = await listarNomesZip(this.#caminhoZip(pleito, uf, mun));
    for (const r of this.manifest.arquivosOkDoMunicipio(pleito, uf, mun)) {
      const nome = `${r.zona}/${r.secao}/${r.hash}/${r.nome}`;
      if (noStaging.has(nome) || noZip.has(nome)) continue;
      const s = { pleito, uf, mun, zona: r.zona, secao: r.secao };
      this.manifest.marcarArquivoInconsistente(s, r.hash, r.nome, 'arquivo ausente do staging e do zip');
      aviso(`${r.nome} (${r.zona}/${r.secao}): arquivo ausente do staging e do zip; será baixado de novo`);
    }
    return noStaging.size;
  }

  async #garantirEspaco(): Promise<void> {
    const livres = await this.bytesLivres(this.pastaDados);
    if (livres < this.minLivreBytes) {
      throw new EspacoInsuficienteError(
        `espaço livre abaixo do mínimo (${(livres / GB).toFixed(1)} GB livres, mínimo ${(this.minLivreBytes / GB).toFixed(0)} GB): ` +
        'coleta interrompida. Libere espaço e inicie de novo.',
      );
    }
  }
}
