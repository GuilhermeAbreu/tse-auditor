// Tipos do domínio compartilhados entre coleta, extração, análise e painel.

export interface SecaoChave {
  pleito: string;
  uf: string;
  mun: string;
  zona: string;
  secao: string;
}

// Seção na config de seções (cs.json). `principal`: seção à qual esta foi agregada.
export interface SecaoConfig {
  zona: string;
  secao: string;
  principal: string | null;
}

export interface MunicipioConfig {
  mun: string;
  nome: string;
  secoes: SecaoConfig[];
}

export interface ConfigSecoes {
  uf: string;
  municipios: MunicipioConfig[];
}

// Arquivo de um conjunto do -aux.json da seção.
export interface Arquivo {
  nome: string;
  tipo: string | undefined;
}

export interface Conjunto {
  hash: string;
  status: string | null;
  data: string | null;
  hora: string | null;
  arquivos: Arquivo[];
}

export interface IndiceSecao {
  status: string | null;
  conjuntos: Conjunto[];
}

export interface Cargo {
  cd: number | string;
  nome: string;
}

export interface Eleicao {
  cd: string;
  nome: string;
  turno: number;
  cargos: Cargo[];
}

export interface Pleito {
  cd: string;
  ciclo: string;
  data: string;
  eleicoes: Eleicao[];
}

export interface Templates {
  cs: string;
  aux: string;
}

export interface Eleicoes {
  templates: Templates;
  pleitos: Pleito[];
}

export interface Turnos {
  primeiro: number | null;
  segundo: number | null;
}

export interface OpcoesHttp {
  tentativas: number;
  esperaBaseMs: number;
  esperaMaxMs: number;
  timeoutMs: number;
  userAgent: string;
}

// Opções da coleta ajustáveis no painel.
export interface Opcoes {
  concorrencia: number;
  http: OpcoesHttp;
  tentativasVerificacao: number;
  limiteFalhasRede: number;
  minLivreGB: number;
  intervaloCommitMs: number;
  intervaloPainelMs: number;
  analisarAoConcluir: boolean;
  hd: string;
}

// Configuração validada (ControleColeta.validar).
export interface Configuracao extends Opcoes {
  pleitos: string[];
  ufs: string[];
  ciclo: string;
}

// Entrada de configuração vinda do painel, do CLI ou do arquivo salvo (ainda não validada).
export type ConfigEntrada = Record<string, unknown> & {
  pleitos?: unknown;
  ufs?: unknown;
  http?: Record<string, unknown>;
};

export interface RespostaHttp {
  status: number;
  body: Buffer;
  etag: string | null;
}

export interface ClienteHttp {
  get(url: string): Promise<RespostaHttp>;
}

export interface EstadoColeta {
  rodando: boolean;
  ufAtual: string | null;
  municipioAtual: string | null;
  motivoParada: string | null;
}

export type StatusUf = 'pausando' | 'baixando' | 'pausada' | 'baixado_com_erros' | 'baixado' | 'aguardando';

export interface UfResumo {
  uf: string;
  pausada: boolean;
  total: number;
  concluidas: number;
  erros: number;
  semArquivos: number;
  agregadas: number;
  bytes: number;
}

export interface Totais {
  secoes: number;
  concluidas: number;
  erros: number;
  semArquivos: number;
  bytes: number;
}

export interface ErroSecao extends SecaoChave {
  erro: string | null;
  atualizado_em: string | null;
}

export interface Evento {
  ts: string;
  nivel: string;
  uf: string | null;
  msg: string;
}

// O que o painel e o CLI exibem.
export interface EstadoPainel {
  geradoEm: string;
  configuracao?: (Configuracao & { dados: string | null }) | null;
  coleta: EstadoColeta & { velocidadeBps: number };
  totais: Totais;
  disco: { livres: number | null; projecaoBytes: number | null; projecaoPreliminar: boolean };
  ufs: (UfResumo & { status: StatusUf })[];
  errosSecoes: ErroSecao[];
  eventos: Evento[];
  manifestErro: string | null;
}

// Linha de achados.parquet (cruzamentos).
export interface Achado {
  cruzamento: string;
  uf: string;
  mun: string;
  zona: string;
  secao: string;
  pleito: number;
  sinal: string;
  pontuacao: number;
  valor: number | null;
  referencia: number | null;
  explicacoesCandidatas: string;
  detalhe: string | null;
}

// Linha genérica devolvida pelo DuckDB (getRowObjectsJson).
export type Linha = Record<string, unknown>;
