import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PADRAO, pastaDados } from '../config.ts';
import { caminhoConfigSalva, salvarConfig } from '../configSalva.ts';
import { UFS } from '../ufs.ts';
import { HttpClient } from '../net/http.ts';
import { criarUrls } from '../tse/urls.ts';
import { Manifest } from '../storage/manifest.ts';
import { bytesLivres as bytesLivresDoDisco, garantirVolume } from '../storage/disco.ts';
import { Coletor } from './coletor.ts';
import { montarEstado } from './estado.ts';
import { LIMITES, normalizarOpcoes, padroes } from './opcoes.ts';
import type { OpcoesHttpClient } from '../net/http.ts';
import type { OpcoesColetor } from './coletor.ts';
import type { ClienteHttp, ConfigEntrada, Configuracao, Eleicoes, EstadoPainel, Opcoes } from '../tipos/dominio.ts';

export interface OpcoesControle {
  eleicoes: Eleicoes;
  hd?: string;
  base: string;
  ambiente: string;
  dadosFixo?: string;
  arquivoConfig?: string;
  criarHttp?: (opcoes: OpcoesHttpClient) => ClienteHttp;
  criarColetor?: (opcoes: OpcoesColetor) => Coletor;
  bytesLivres?: (pasta: string) => Promise<number>;
}

export type ConfiguracaoComDados = Configuracao & { dados: string | null };

const GB = 1024 ** 3;
const dataIso = (dt: string) => dt.split('/').reverse().join('-'); // dd/mm/aaaa → aaaa-mm-dd

// Dono da configuração da coleta e dos objetos vivos: manifest, cliente HTTP e coletor.
// Aplicar uma configuração nova para o coletor atual, reabre o manifest se a pasta ou o
// intervalo de gravação mudou e monta um coletor novo; o que já foi baixado continua no manifest.
export class ControleColeta {
  #config: Configuracao | null = null;
  #coletor: Coletor | null = null;
  #manifest: Manifest | null = null;
  #dados: string | null = null;
  declare eleicoes: Eleicoes;
  declare base: string;
  declare ambiente: string;
  declare dadosFixo: string | undefined;
  declare arquivoConfig: string;
  declare criarHttp: (opcoes: OpcoesHttpClient) => ClienteHttp;
  declare criarColetor: (opcoes: OpcoesColetor) => Coletor;
  declare bytesLivres: (pasta: string) => Promise<number>;
  padroes: Opcoes;
  #fila: Promise<unknown> = Promise.resolve();

  constructor({
    eleicoes, hd = PADRAO.hd, base, ambiente, dadosFixo,
    arquivoConfig = caminhoConfigSalva(),
    criarHttp = (opcoes) => new HttpClient(opcoes),
    criarColetor = (opcoes) => new Coletor(opcoes),
    bytesLivres = bytesLivresDoDisco,
  }: OpcoesControle) {
    Object.assign(this, { eleicoes, base, ambiente, dadosFixo, arquivoConfig, criarHttp, criarColetor, bytesLivres });
    this.padroes = padroes({ hd });
  }

  get coletor(): Coletor | null {
    return this.#coletor;
  }

  get manifest(): Manifest | null {
    return this.#manifest;
  }

  configuracao(): ConfiguracaoComDados | null {
    return this.#config ? structuredClone({ ...this.#config, dados: this.#dados }) : null;
  }

  intervaloPainelMs(): number {
    return (this.#config ?? this.padroes).intervaloPainelMs;
  }

  // O que o painel mostra mas não deixa mudar (a porta o servidor acrescenta).
  somenteLeitura() {
    return { base: this.base, ambiente: this.ambiente, dadosFixo: this.dadosFixo ?? null };
  }

  limites() {
    return LIMITES;
  }

  disponiveis() {
    const pleitos = this.eleicoes.pleitos
      .map((p) => ({
        cd: p.cd,
        ciclo: p.ciclo,
        data: p.data,
        eleicoes: p.eleicoes.map((e) => ({ cd: e.cd, nome: e.nome, turno: e.turno, cargos: e.cargos.map((c) => c.nome) })),
      }))
      .sort((a, b) => dataIso(b.data).localeCompare(dataIso(a.data)) || a.cd.localeCompare(b.cd, 'en', { numeric: true }));
    return { pleitos, ufs: UFS };
  }

  // Completa a entrada com a configuração atual (ou os padrões) e valida.
  // Lança Error com mensagem em português se algo não serve.
  validar(entrada: ConfigEntrada | null = {}): Configuracao {
    const e: ConfigEntrada = entrada ?? {};
    const anterior: Opcoes & { pleitos?: string[]; ufs: string[] } = this.#config ?? { ...this.padroes, pleitos: undefined, ufs: UFS };
    const pleitos = e.pleitos ?? anterior.pleitos;
    const ufs = e.ufs ?? anterior.ufs;
    if (!Array.isArray(pleitos) || pleitos.length === 0) throw new Error('escolha ao menos um pleito');
    if (!Array.isArray(ufs) || ufs.length === 0) throw new Error('escolha ao menos uma UF');
    const escolhidos = [...new Set(pleitos.map(String))].map((cd) => {
      const p = this.eleicoes.pleitos.find((x) => x.cd === cd);
      if (!p) throw new Error(`pleito ${cd} não existe no ele-c.json`);
      return p;
    });
    const ciclos = [...new Set(escolhidos.map((p) => p.ciclo))];
    if (ciclos.length !== 1) throw new Error(`os pleitos precisam ser do mesmo ciclo: ${ciclos.join(', ')}`);
    const normalizadas = [...new Set(ufs.map((u) => String(u).trim().toLowerCase()))];
    for (const uf of normalizadas) if (!UFS.includes(uf)) throw new Error(`UF desconhecida: ${uf}`);
    return {
      pleitos: escolhidos.map((p) => p.cd),
      ufs: UFS.filter((u) => normalizadas.includes(u)), // ordem de coleta
      ...normalizarOpcoes(e, anterior),
      ciclo: ciclos[0]!,
    };
  }

  // Aplica uma configuração nova. Uma por vez: chamadas simultâneas entram na fila.
  aplicar(config: ConfigEntrada, opcoes: { iniciar?: boolean; salvar?: boolean } = {}): Promise<ConfiguracaoComDados | null> {
    const vez = this.#fila.then(() => this.#aplicar(config, opcoes));
    this.#fila = vez.catch(() => {});
    return vez;
  }

  async #aplicar(config: ConfigEntrada, { iniciar = false, salvar = true }: { iniciar?: boolean; salvar?: boolean }): Promise<ConfiguracaoComDados | null> {
    const nova = this.validar(config);
    const dados = this.dadosFixo ?? pastaDados(nova.hd, nova.ciclo);
    const outraPasta = dados !== this.#dados;
    const reabrir = outraPasta || nova.intervaloCommitMs !== this.#config?.intervaloCommitMs;
    const abrir = () => new Manifest(path.join(dados, 'manifest.sqlite'), { intervaloCommitMs: nova.intervaloCommitMs });

    // Pasta nova: abre o manifest antes de parar o atual; se o HD não estiver lá, nada muda.
    let manifest = this.#manifest;
    if (outraPasta) {
      if (!this.dadosFixo) await garantirVolume(nova.hd);
      await mkdir(dados, { recursive: true });
      manifest = abrir();
    }

    await this.#pararColetor();
    if (reabrir) this.#fecharManifest();
    if (reabrir && !outraPasta) {
      // mesmo arquivo: só dá para reabrir depois de fechar
      try {
        manifest = abrir();
      } catch (err) {
        this.#esquecer();
        throw new Error(`não foi possível reabrir o manifest: ${(err as Error).message}`);
      }
    }

    if (!manifest) throw new Error('manifest não aberto');
    this.#manifest = manifest;
    this.#dados = dados;
    this.#config = nova;
    this.#coletor = this.criarColetor({
      manifest,
      http: this.criarHttp({ concorrencia: nova.concorrencia, ...nova.http }),
      urls: criarUrls({ base: this.base, ambiente: this.ambiente, templates: this.eleicoes.templates }),
      pastaDados: dados,
      ciclo: nova.ciclo,
      pleitos: nova.pleitos,
      ufs: nova.ufs,
      minLivreBytes: nova.minLivreGB * GB,
      concorrencia: nova.concorrencia,
      tentativasVerificacao: nova.tentativasVerificacao,
      limiteFalhasRede: nova.limiteFalhasRede,
      bytesLivres: this.bytesLivres,
    });

    if (salvar) {
      const { ciclo, ...salvavel } = nova;
      try {
        await salvarConfig(this.arquivoConfig, salvavel);
      } catch (err) {
        try {
          manifest.registrarEvento('aviso', null, `não foi possível salvar a configuração em ${this.arquivoConfig}: ${(err as Error).message}`);
        } catch {
          // manifest com erro de gravação: o painel já mostra
        }
      }
    }
    if (iniciar) this.#coletor.executar(); // roda em segundo plano
    return this.configuracao();
  }

  #esquecer() {
    this.#manifest = null;
    this.#coletor = null;
    this.#config = null;
    this.#dados = null;
  }

  async #pararColetor() {
    if (!this.#coletor) return;
    this.#coletor.parar();
    await this.#coletor.aguardar();
  }

  #fecharManifest() {
    if (!this.#manifest) return;
    try {
      this.#manifest.fechar();
    } catch (err) {
      console.error(`erro ao fechar o manifest: ${(err as Error).message}`);
    }
    this.#manifest = null;
  }

  async obterEstado(): Promise<EstadoPainel> {
    const configuracao = this.configuracao();
    if (!configuracao) {
      return {
        geradoEm: new Date().toISOString(),
        configuracao: null,
        coleta: { rodando: false, ufAtual: null, municipioAtual: null, motivoParada: null, velocidadeBps: 0 },
        totais: { secoes: 0, concluidas: 0, erros: 0, semArquivos: 0, bytes: 0 },
        disco: { livres: null, projecaoBytes: null, projecaoPreliminar: true },
        ufs: [],
        errosSecoes: [],
        eventos: [],
        manifestErro: null,
      };
    }
    const estado = await montarEstado({
      manifest: this.#manifest!,
      coletor: this.#coletor!,
      pastaDados: this.#dados!,
      bytesLivres: this.bytesLivres,
      ufs: configuracao.ufs,
    });
    return { ...estado, configuracao };
  }

  // Para a coleta (espera as seções em andamento) e fecha o manifest.
  async fechar() {
    await this.#fila;
    await this.#pararColetor();
    this.#fecharManifest();
  }

  // Saída forçada (segundo Ctrl-C): só fecha o manifest.
  fecharJa() {
    this.#fecharManifest();
  }
}
