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
);
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
);
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

// Estado persistente da coleta. Fica no HD, ao lado dos dados; journal em modo DELETE
// (sem WAL, que depende de memória compartilhada e se dá mal com NTFS) e synchronous FULL,
// para sobreviver a um HD desconectado no meio de uma escrita.
export class Manifest {
  #st;

  constructor(caminho) {
    this.db = new Database(caminho);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
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
      errosRecentes: p(`SELECT pleito, uf, mun, zona, secao, erro, atualizado_em FROM secoes
                        WHERE status = 'erro' ORDER BY atualizado_em DESC LIMIT ?`),
    };
  }

  fechar() {
    if (this.db.open) this.db.close();
  }

  registrarUfs(ufs) {
    this.db.transaction(() => {
      for (const uf of ufs) this.#st.inserirUf.run(uf, UFS.indexOf(uf));
    })();
  }

  ufs() {
    return this.#st.ufs.all();
  }

  definirPausa(uf, pausada) {
    this.#st.definirPausa.run(pausada ? 1 : 0, uf);
  }

  ufPausada(uf) {
    return this.#st.ufPausada.get(uf)?.pausada === 1;
  }

  registrarConfig(pleito, uf, municipios) {
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
    this.db.transaction(() => {
      for (const c of conjuntos) {
        this.#st.inserirConjunto.run({ ...chave(s), hash: c.hash, status: c.status, data: c.data, hora: c.hora });
        for (const a of c.arquivos) {
          this.#st.inserirArquivo.run({ ...chave(s), hash: c.hash, nome: a.nome, tipo: a.tipo, url: urlDe(c.hash, a.nome) });
        }
      }
    })();
  }

  arquivosDaSecao(s) {
    return this.#st.arquivosDaSecao.all(chave(s));
  }

  marcarArquivo(s, hash, nome, { status, bytes = null, md5 = null, sha512 = null, verificacao = null, erro = null }) {
    this.#st.marcarArquivo.run({ ...chave(s), hash, nome, status, bytes, md5, sha512, verificacao, erro, agora: agora() });
  }

  finalizarSecao(s, { status, bytes = 0, erro = null }) {
    this.#st.finalizarSecao.run({ ...chave(s), status, bytes, erro, agora: agora() });
  }

  marcarEmpacotado(pleito, uf, mun, zipBytes) {
    this.#st.marcarEmpacotado.run(agora(), zipBytes, pleito, uf, mun);
  }

  registrarEvento(nivel, uf, msg) {
    this.#st.registrarEvento.run(agora(), nivel, uf, msg);
  }

  eventos(limite) {
    return this.#st.eventos.all(limite);
  }

  resumoPorUf() {
    return this.#st.resumoPorUf.all().map((r) => ({ ...r, bytes: r.bytes ?? 0 }));
  }

  errosRecentes(limite) {
    return this.#st.errosRecentes.all(limite);
  }
}
