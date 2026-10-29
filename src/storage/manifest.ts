import Database from 'better-sqlite3';
import { UFS } from '../ufs.ts';
import type { Conjunto, ErroSecao, Evento, MunicipioConfig, SecaoChave } from '../tipos/dominio.ts';

export interface UfLinha { uf: string; ordem: number; pausada: number }
export interface MunicipioLinha { pleito: string; uf: string; mun: string; nome: string; empacotado_em: string | null; zip_bytes: number | null }
export interface SecaoLinha extends SecaoChave {
  principal: string | null; status: string; bytes: number; erro: string | null; atualizado_em: string | null;
}
export interface ArquivoLinha extends SecaoChave {
  hash: string; nome: string; tipo: string | null; url: string; status: string;
  bytes: number | null; md5: string | null; sha512: string | null; verificacao: string | null;
  tentativas: number; erro: string | null; baixado_em: string | null;
}
export type ArquivoOkLinha = Pick<ArquivoLinha, 'zona' | 'secao' | 'hash' | 'nome' | 'bytes' | 'sha512'>;
export interface ResumoLinha { uf: string; status: string; n: number; bytes: number }
export interface MarcaArquivo {
  status: string; bytes?: number | null; md5?: string | null; sha512?: string | null; verificacao?: string | null; erro?: string | null;
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS ufs (
  uf TEXT PRIMARY KEY,
  ordem INTEGER NOT NULL,
  pausada INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS municipios (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL,
  nome TEXT NOT NULL,
  empacotado_em TEXT,
  zip_bytes INTEGER,
  PRIMARY KEY (pleito, uf, mun)
);
CREATE TABLE IF NOT EXISTS secoes (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL, zona TEXT NOT NULL, secao TEXT NOT NULL,
  principal TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  bytes INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  atualizado_em TEXT,
  PRIMARY KEY (pleito, uf, mun, zona, secao)
);
CREATE INDEX IF NOT EXISTS secoes_uf_status ON secoes (uf, status, bytes);
CREATE INDEX IF NOT EXISTS secoes_status_data ON secoes (status, atualizado_em);
CREATE TABLE IF NOT EXISTS conjuntos (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL, zona TEXT NOT NULL, secao TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT, data TEXT, hora TEXT,
  PRIMARY KEY (pleito, uf, mun, zona, secao, hash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS arquivos (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL, zona TEXT NOT NULL, secao TEXT NOT NULL,
  hash TEXT NOT NULL, nome TEXT NOT NULL,
  tipo TEXT,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  bytes INTEGER, md5 TEXT, sha512 TEXT,
  verificacao TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  baixado_em TEXT,
  PRIMARY KEY (pleito, uf, mun, zona, secao, hash, nome)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  nivel TEXT NOT NULL,
  uf TEXT,
  msg TEXT NOT NULL
);
`;

// Tipos de arquivo que o TSE lista no índice mas às vezes não publica (404 não invalida a seção).
export const TIPOS_OPCIONAIS = new Set(['imgbu']);
const MSG_INDISPONIVEL = 'não publicado pelo TSE (HTTP 404)';

const ONDE_SECAO = 'pleito = @pleito AND uf = @uf AND mun = @mun AND zona = @zona AND secao = @secao';
const chave = (s: SecaoChave): SecaoChave => ({ pleito: s.pleito, uf: s.uf, mun: s.mun, zona: s.zona, secao: s.secao });
const agora = () => new Date().toISOString();

const LIMITE_GRAVACOES = 500;

// Estado persistente da coleta. Fica no HD, ao lado dos dados; journal de rollback (TRUNCATE,
// sem WAL, que depende de memória compartilhada e se dá mal com NTFS) e synchronous NORMAL,
// que ainda protege contra corrupção. As escritas ficam numa transação aberta, confirmada a
// cada 500 escritas ou após intervaloCommitMs; perder ~1 s das últimas atualizações é seguro,
// pois o download é refeito. Leituras usam a mesma conexão e enxergam o que ainda não foi
// confirmado. Erro no commit por timer é guardado e lançado na próxima chamada pública.
export class Manifest {
  #st: Record<string, Database.Statement>;
  #timer: NodeJS.Timeout | null = null;
  #resumo: { ts: number; linhas: ResumoLinha[] } | null = null;
  #gravacoes = 0;
  #erroPendente: unknown = null;
  #intervaloCommitMs: number;
  #cacheResumoMs: number;
  db: Database.Database;

  constructor(caminho: string, { intervaloCommitMs = 1000, cacheResumoMs = 5000 }: { intervaloCommitMs?: number; cacheResumoMs?: number } = {}) {
    this.#intervaloCommitMs = intervaloCommitMs;
    this.#cacheResumoMs = cacheResumoMs;
    this.db = new Database(caminho);
    this.db.pragma('journal_mode = TRUNCATE');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(ESQUEMA);
    this.#corrigirIndisponiveis();
    const p = (sql: string) => this.db.prepare(sql);
    this.#st = {
      inserirUf: p('INSERT OR IGNORE INTO ufs (uf, ordem) VALUES (?, ?)'),
      ufs: p('SELECT uf, ordem, pausada FROM ufs ORDER BY ordem'),
      definirPausa: p('UPDATE ufs SET pausada = ? WHERE uf = ?'),
      ufPausada: p('SELECT pausada FROM ufs WHERE uf = ?'),
      inserirMunicipio: p('INSERT OR IGNORE INTO municipios (pleito, uf, mun, nome) VALUES (@pleito, @uf, @mun, @nome)'),
      inserirSecao: p(`INSERT OR IGNORE INTO secoes (pleito, uf, mun, zona, secao, principal, status, atualizado_em)
                       VALUES (@pleito, @uf, @mun, @zona, @secao, @principal, @status, @agora)`),
      municipiosDaUf: p('SELECT mun, MIN(nome) AS nome FROM municipios WHERE uf = ? GROUP BY mun ORDER BY mun'),
      municipio: p('SELECT * FROM municipios WHERE pleito = ? AND uf = ? AND mun = ?'),
      secoesPendentes: p(`SELECT pleito, uf, mun, zona, secao FROM secoes
                          WHERE pleito = ? AND uf = ? AND mun = ? AND status IN ('pendente', 'erro')
                          ORDER BY zona, secao`),
      secao: p(`SELECT * FROM secoes WHERE ${ONDE_SECAO}`),
      arquivo: p(`SELECT * FROM arquivos WHERE ${ONDE_SECAO} AND hash = @hash AND nome = @nome`),
      arquivosOkDoMunicipio: p(`SELECT zona, secao, hash, nome, bytes, sha512 FROM arquivos
                                WHERE pleito = ? AND uf = ? AND mun = ? AND status = 'ok'`),
      inserirConjunto: p(`INSERT OR IGNORE INTO conjuntos (pleito, uf, mun, zona, secao, hash, status, data, hora)
                          VALUES (@pleito, @uf, @mun, @zona, @secao, @hash, @status, @data, @hora)`),
      inserirArquivo: p(`INSERT OR IGNORE INTO arquivos (pleito, uf, mun, zona, secao, hash, nome, tipo, url)
                         VALUES (@pleito, @uf, @mun, @zona, @secao, @hash, @nome, @tipo, @url)`),
      arquivosDaSecao: p(`SELECT * FROM arquivos WHERE ${ONDE_SECAO} ORDER BY hash, nome`),
      marcarArquivo: p(`UPDATE arquivos SET status = @status, bytes = @bytes, md5 = @md5, sha512 = @sha512,
                          verificacao = @verificacao, erro = @erro, tentativas = tentativas + 1, baixado_em = @agora
                        WHERE ${ONDE_SECAO} AND hash = @hash AND nome = @nome`),
      finalizarSecao: p(`UPDATE secoes SET status = @status, bytes = @bytes, erro = @erro, atualizado_em = @agora
                         WHERE ${ONDE_SECAO}`),
      marcarEmpacotado: p('UPDATE municipios SET empacotado_em = ?, zip_bytes = ? WHERE pleito = ? AND uf = ? AND mun = ?'),
      registrarEvento: p('INSERT INTO eventos (ts, nivel, uf, msg) VALUES (?, ?, ?, ?)'),
      eventos: p('SELECT ts, nivel, uf, msg FROM eventos ORDER BY id DESC LIMIT ?'),
      resumoPorUf: p('SELECT uf, status, COUNT(*) AS n, SUM(bytes) AS bytes FROM secoes GROUP BY uf, status'),
      reabrirSecoes: p(`UPDATE secoes SET status = 'pendente', bytes = 0, erro = NULL
                        WHERE pleito = ? AND uf = ? AND mun = ? AND status != 'agregada'`),
      reabrirArquivos: p("UPDATE arquivos SET status = 'pendente' WHERE pleito = ? AND uf = ? AND mun = ?"),
      reabrirMunicipio: p('UPDATE municipios SET empacotado_em = NULL, zip_bytes = NULL WHERE pleito = ? AND uf = ? AND mun = ?'),
      indisponiveisPorUf: p("SELECT uf, COUNT(*) AS n FROM arquivos WHERE status = 'indisponivel' GROUP BY uf ORDER BY uf"),
      errosRecentes: p(`SELECT pleito, uf, mun, zona, secao, erro, atualizado_em FROM secoes
                        WHERE status = 'erro' ORDER BY atualizado_em DESC LIMIT ?`),
    };
  }

  // Correção única e idempotente de manifests antigos: seções em 'erro' cujos únicos arquivos
  // não-ok são de tipo opcional com HTTP 404 passam a 'completa'; esses arquivos, a 'indisponivel'.
  #corrigirIndisponiveis(): void {
    const opc = [...TIPOS_OPCIONAIS].map((t) => `'${t}'`).join(', ');
    const ehOpc404 = `(a.tipo IN (${opc}) AND a.status = 'erro' AND a.erro LIKE '%HTTP 404%')`;
    const mesma = 'a.pleito = secoes.pleito AND a.uf = secoes.uf AND a.mun = secoes.mun AND a.zona = secoes.zona AND a.secao = secoes.secao';
    this.db.transaction(() => {
      this.db.exec(`UPDATE secoes SET status = 'completa', erro = NULL,
          bytes = COALESCE((SELECT SUM(a.bytes) FROM arquivos a WHERE ${mesma} AND a.status = 'ok'), 0)
        WHERE status = 'erro'
          AND EXISTS (SELECT 1 FROM arquivos a WHERE ${mesma} AND ${ehOpc404})
          AND NOT EXISTS (SELECT 1 FROM arquivos a WHERE ${mesma} AND a.status NOT IN ('ok', 'indisponivel') AND NOT ${ehOpc404})`);
      this.db.exec(`UPDATE arquivos AS a SET status = 'indisponivel', erro = '${MSG_INDISPONIVEL}'
        WHERE ${ehOpc404}
          AND EXISTS (SELECT 1 FROM secoes WHERE ${mesma} AND secoes.status = 'completa')`);
    })();
  }

  fechar() {
    try {
      // Com erro de commit guardado, o rollback acontece ao fechar.
      if (!this.#erroPendente) this.descarregar();
    } finally {
      clearTimeout(this.#timer ?? undefined);
      this.#timer = null;
      if (this.db.open) this.db.close();
    }
  }

  // Erro de commit guardado: só some reabrindo o Manifest depois que o disco voltar.
  get erro(): Error | null {
    return (this.#erroPendente as Error | null) ?? null;
  }

  // Confirma a transação aberta, se houver.
  descarregar(): void {
    this.#verificarErro();
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
    if (!this.db.open || !this.db.inTransaction) return;
    try {
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
      } catch {
        // o disco pode ter sumido; o erro original é o que importa
      }
      this.#erroPendente = err;
      throw err;
    }
  }

  #verificarErro() {
    if (this.#erroPendente) throw this.#erroPendente;
  }

  #abrirTransacao() {
    this.#verificarErro();
    if (!this.db.inTransaction) {
      this.db.exec('BEGIN');
      this.#gravacoes = 0;
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      try {
        this.descarregar();
      } catch {
        // já guardado em #erroPendente
      }
    }, this.#intervaloCommitMs).unref();
  }

  #contar() {
    if (++this.#gravacoes >= LIMITE_GRAVACOES) this.descarregar();
  }

  registrarUfs(ufs: string[]): void {
    this.#abrirTransacao();
    this.db.transaction(() => {
      for (const uf of ufs) this.#st.inserirUf!.run(uf, UFS.indexOf(uf));
    })();
    this.#contar();
  }

  ufs(): UfLinha[] {
    return this.#st.ufs!.all() as UfLinha[];
  }

  definirPausa(uf: string, pausada: boolean): void {
    this.#abrirTransacao();
    this.#st.definirPausa!.run(pausada ? 1 : 0, uf);
    this.#contar();
  }

  ufPausada(uf: string): boolean {
    return (this.#st.ufPausada!.get(uf) as { pausada: number } | undefined)?.pausada === 1;
  }

  registrarConfig(pleito: string, uf: string, municipios: MunicipioConfig[]): void {
    this.#abrirTransacao();
    this.#resumo = null;
    this.db.transaction(() => {
      const ts = agora();
      for (const m of municipios) {
        this.#st.inserirMunicipio!.run({ pleito, uf, mun: m.mun, nome: m.nome });
        for (const s of m.secoes) {
          this.#st.inserirSecao!.run({
            pleito, uf, mun: m.mun, zona: s.zona, secao: s.secao,
            principal: s.principal,
            status: s.principal ? 'agregada' : 'pendente',
            agora: ts,
          });
        }
      }
    })();
    this.#contar();
  }

  municipiosDaUf(uf: string): { mun: string; nome: string }[] {
    return this.#st.municipiosDaUf!.all(uf) as { mun: string; nome: string }[];
  }

  municipio(pleito: string, uf: string, mun: string): MunicipioLinha | undefined {
    return this.#st.municipio!.get(pleito, uf, mun) as MunicipioLinha | undefined;
  }

  secoesPendentes(pleito: string, uf: string, mun: string): SecaoChave[] {
    return this.#st.secoesPendentes!.all(pleito, uf, mun) as SecaoChave[];
  }

  secao(s: SecaoChave): SecaoLinha | undefined {
    return this.#st.secao!.get(chave(s)) as SecaoLinha | undefined;
  }

  registrarIndice(s: SecaoChave, conjuntos: Conjunto[], urlDe: (hash: string, nome: string) => string): void {
    this.#abrirTransacao();
    this.db.transaction(() => {
      for (const c of conjuntos) {
        this.#st.inserirConjunto!.run({ ...chave(s), hash: c.hash, status: c.status, data: c.data, hora: c.hora });
        for (const a of c.arquivos) {
          this.#st.inserirArquivo!.run({ ...chave(s), hash: c.hash, nome: a.nome, tipo: a.tipo, url: urlDe(c.hash, a.nome) });
        }
      }
    })();
    this.#contar();
  }

  arquivosDaSecao(s: SecaoChave): ArquivoLinha[] {
    return this.#st.arquivosDaSecao!.all(chave(s)) as ArquivoLinha[];
  }

  marcarArquivo(s: SecaoChave, hash: string, nome: string, { status, bytes = null, md5 = null, sha512 = null, verificacao = null, erro = null }: MarcaArquivo): void {
    this.#abrirTransacao();
    this.#st.marcarArquivo!.run({ ...chave(s), hash, nome, status, bytes, md5, sha512, verificacao, erro, agora: agora() });
    this.#contar();
  }

  arquivo(s: SecaoChave, hash: string, nome: string): ArquivoLinha | undefined {
    return this.#st.arquivo!.get({ ...chave(s), hash, nome }) as ArquivoLinha | undefined;
  }

  arquivosOkDoMunicipio(pleito: string, uf: string, mun: string): ArquivoOkLinha[] {
    return this.#st.arquivosOkDoMunicipio!.all(pleito, uf, mun) as ArquivoOkLinha[];
  }

  // Arquivo que o manifest dava como ok mas cujo conteúdo no staging não confere.
  marcarArquivoInconsistente(s: SecaoChave, hash: string, nome: string, erro: string): void {
    this.marcarArquivo(s, hash, nome, { status: 'erro', erro });
    this.finalizarSecao(s, { status: 'erro', erro: `${nome}: ${erro}` });
  }

  finalizarSecao(s: SecaoChave, { status, bytes = 0, erro = null }: { status: string; bytes?: number; erro?: string | null }): void {
    this.#abrirTransacao();
    this.#st.finalizarSecao!.run({ ...chave(s), status, bytes, erro, agora: agora() });
    this.#contar();
  }

  marcarEmpacotado(pleito: string, uf: string, mun: string, zipBytes: number): void {
    this.#abrirTransacao();
    this.#st.marcarEmpacotado!.run(agora(), zipBytes, pleito, uf, mun);
    this.#contar();
  }

  reabrirMunicipio(pleito: string, uf: string, mun: string): void {
    this.#abrirTransacao();
    this.#resumo = null;
    this.db.transaction(() => {
      this.#st.reabrirSecoes!.run(pleito, uf, mun);
      this.#st.reabrirArquivos!.run(pleito, uf, mun);
      this.#st.reabrirMunicipio!.run(pleito, uf, mun);
    })();
    this.#contar();
  }

  registrarEvento(nivel: string, uf: string | null, msg: string): void {
    this.#abrirTransacao();
    this.#st.registrarEvento!.run(agora(), nivel, uf, msg);
    this.#contar();
  }

  eventos(limite: number): Evento[] {
    return this.#st.eventos!.all(limite) as Evento[];
  }

  resumoPorUf(): ResumoLinha[] {
    this.#verificarErro();
    if (this.#resumo && Date.now() - this.#resumo.ts < this.#cacheResumoMs) return this.#resumo.linhas;
    const linhas = (this.#st.resumoPorUf!.all() as (Omit<ResumoLinha, 'bytes'> & { bytes: number | null })[]).map((r) => ({ ...r, bytes: r.bytes ?? 0 }));
    this.#resumo = { ts: Date.now(), linhas };
    return linhas;
  }

  indisponiveisPorUf(): { uf: string; n: number }[] {
    this.#verificarErro();
    return this.#st.indisponiveisPorUf!.all() as { uf: string; n: number }[];
  }

  errosRecentes(limite: number): ErroSecao[] {
    return this.#st.errosRecentes!.all(limite) as ErroSecao[];
  }
}
