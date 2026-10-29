import Database from 'better-sqlite3';
import { UFS } from '../ufs.js';

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

const ONDE_SECAO = 'pleito = @pleito AND uf = @uf AND mun = @mun AND zona = @zona AND secao = @secao';
const chave = (s) => ({ pleito: s.pleito, uf: s.uf, mun: s.mun, zona: s.zona, secao: s.secao });
const agora = () => new Date().toISOString();

const LIMITE_GRAVACOES = 500;

// Estado persistente da coleta. Fica no HD, ao lado dos dados; journal de rollback (TRUNCATE,
// sem WAL, que depende de memória compartilhada e se dá mal com NTFS) e synchronous NORMAL,
// que ainda protege contra corrupção. As escritas ficam numa transação aberta, confirmada a
// cada 500 escritas ou após intervaloCommitMs; perder ~1 s das últimas atualizações é seguro,
// pois o download é refeito. Leituras usam a mesma conexão e enxergam o que ainda não foi
// confirmado. Erro no commit por timer é guardado e lançado na próxima chamada pública.
export class Manifest {
  #st;
  #timer = null;
  #resumo = null;
  #gravacoes = 0;
  #erroPendente = null;
  #intervaloCommitMs;
  #cacheResumoMs;

  constructor(caminho, { intervaloCommitMs = 1000, cacheResumoMs = 5000 } = {}) {
    this.#intervaloCommitMs = intervaloCommitMs;
    this.#cacheResumoMs = cacheResumoMs;
    this.db = new Database(caminho);
    this.db.pragma('journal_mode = TRUNCATE');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(ESQUEMA);
    const p = (sql) => this.db.prepare(sql);
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
      errosRecentes: p(`SELECT pleito, uf, mun, zona, secao, erro, atualizado_em FROM secoes
                        WHERE status = 'erro' ORDER BY atualizado_em DESC LIMIT ?`),
    };
  }

  fechar() {
    try {
      // Com erro de commit guardado, o rollback acontece ao fechar.
      if (!this.#erroPendente) this.descarregar();
    } finally {
      clearTimeout(this.#timer);
      this.#timer = null;
      if (this.db.open) this.db.close();
    }
  }

  // Erro de commit guardado: só some reabrindo o Manifest depois que o disco voltar.
  get erro() {
    return this.#erroPendente ?? null;
  }

  // Confirma a transação aberta, se houver.
  descarregar() {
    this.#verificarErro();
    clearTimeout(this.#timer);
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

  registrarUfs(ufs) {
    this.#abrirTransacao();
    this.db.transaction(() => {
      for (const uf of ufs) this.#st.inserirUf.run(uf, UFS.indexOf(uf));
    })();
    this.#contar();
  }

  ufs() {
    return this.#st.ufs.all();
  }

  definirPausa(uf, pausada) {
    this.#abrirTransacao();
    this.#st.definirPausa.run(pausada ? 1 : 0, uf);
    this.#contar();
  }

  ufPausada(uf) {
    return this.#st.ufPausada.get(uf)?.pausada === 1;
  }

  registrarConfig(pleito, uf, municipios) {
    this.#abrirTransacao();
    this.#resumo = null;
    this.db.transaction(() => {
      const ts = agora();
      for (const m of municipios) {
        this.#st.inserirMunicipio.run({ pleito, uf, mun: m.mun, nome: m.nome });
        for (const s of m.secoes) {
          this.#st.inserirSecao.run({
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

  municipiosDaUf(uf) {
    return this.#st.municipiosDaUf.all(uf);
  }

  municipio(pleito, uf, mun) {
    return this.#st.municipio.get(pleito, uf, mun);
  }

  secoesPendentes(pleito, uf, mun) {
    return this.#st.secoesPendentes.all(pleito, uf, mun);
  }

  secao(s) {
    return this.#st.secao.get(chave(s));
  }

  registrarIndice(s, conjuntos, urlDe) {
    this.#abrirTransacao();
    this.db.transaction(() => {
      for (const c of conjuntos) {
        this.#st.inserirConjunto.run({ ...chave(s), hash: c.hash, status: c.status, data: c.data, hora: c.hora });
        for (const a of c.arquivos) {
          this.#st.inserirArquivo.run({ ...chave(s), hash: c.hash, nome: a.nome, tipo: a.tipo, url: urlDe(c.hash, a.nome) });
        }
      }
    })();
    this.#contar();
  }

  arquivosDaSecao(s) {
    return this.#st.arquivosDaSecao.all(chave(s));
  }

  marcarArquivo(s, hash, nome, { status, bytes = null, md5 = null, sha512 = null, verificacao = null, erro = null }) {
    this.#abrirTransacao();
    this.#st.marcarArquivo.run({ ...chave(s), hash, nome, status, bytes, md5, sha512, verificacao, erro, agora: agora() });
    this.#contar();
  }

  arquivosOkDoMunicipio(pleito, uf, mun) {
    return this.#st.arquivosOkDoMunicipio.all(pleito, uf, mun);
  }

  // Arquivo que o manifest dava como ok mas cujo conteúdo no staging não confere.
  marcarArquivoInconsistente(s, hash, nome, erro) {
    this.marcarArquivo(s, hash, nome, { status: 'erro', erro });
    this.finalizarSecao(s, { status: 'erro', erro: `${nome}: ${erro}` });
  }

  finalizarSecao(s, { status, bytes = 0, erro = null }) {
    this.#abrirTransacao();
    this.#st.finalizarSecao.run({ ...chave(s), status, bytes, erro, agora: agora() });
    this.#contar();
  }

  marcarEmpacotado(pleito, uf, mun, zipBytes) {
    this.#abrirTransacao();
    this.#st.marcarEmpacotado.run(agora(), zipBytes, pleito, uf, mun);
    this.#contar();
  }

  reabrirMunicipio(pleito, uf, mun) {
    this.#abrirTransacao();
    this.#resumo = null;
    this.db.transaction(() => {
      this.#st.reabrirSecoes.run(pleito, uf, mun);
      this.#st.reabrirArquivos.run(pleito, uf, mun);
      this.#st.reabrirMunicipio.run(pleito, uf, mun);
    })();
    this.#contar();
  }

  registrarEvento(nivel, uf, msg) {
    this.#abrirTransacao();
    this.#st.registrarEvento.run(agora(), nivel, uf, msg);
    this.#contar();
  }

  eventos(limite) {
    return this.#st.eventos.all(limite);
  }

  resumoPorUf() {
    this.#verificarErro();
    if (this.#resumo && Date.now() - this.#resumo.ts < this.#cacheResumoMs) return this.#resumo.linhas;
    const linhas = this.#st.resumoPorUf.all().map((r) => ({ ...r, bytes: r.bytes ?? 0 }));
    this.#resumo = { ts: Date.now(), linhas };
    return linhas;
  }

  errosRecentes(limite) {
    return this.#st.errosRecentes.all(limite);
  }
}
