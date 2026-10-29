// Gravação de tabelas em Parquet via DuckDB: banco temporário em disco (para não estourar a memória
// com o log inteiro), appender por tabela e COPY ... TO parquet no fim.
import { DuckDBInstance } from '@duckdb/node-api';
import { rename, rm } from 'node:fs/promises';

const APPEND = {
  VARCHAR: (a, v) => a.appendVarchar(String(v)),
  INTEGER: (a, v) => a.appendInteger(v),
  BIGINT: (a, v) => a.appendBigInt(BigInt(v)),
  BOOLEAN: (a, v) => a.appendBoolean(Boolean(v)),
};

const aspas = (s) => `'${s.replaceAll("'", "''")}'`;

export class GravadorParquet {
  static async abrir(arquivoBanco) {
    await rm(arquivoBanco, { force: true });
    await rm(`${arquivoBanco}.wal`, { force: true });
    const g = new GravadorParquet();
    g.arquivoBanco = arquivoBanco;
    g.instancia = await DuckDBInstance.create(arquivoBanco);
    g.con = await g.instancia.connect();
    g.tabelas = new Map();
    return g;
  }

  // colunas: [[nome, tipo]], tipo em VARCHAR | INTEGER | BIGINT | BOOLEAN | TIMESTAMP (gravado como texto ISO)
  async criar(nome, colunas) {
    const ddl = colunas.map(([c, t]) => `"${c}" ${t === 'TIMESTAMP' ? 'VARCHAR' : t}`).join(', ');
    await this.con.run(`CREATE TABLE "${nome}" (${ddl})`);
    const appender = await this.con.createAppender(nome);
    this.tabelas.set(nome, { colunas, appender, linhas: 0 });
  }

  inserir(nome, linha) {
    const t = this.tabelas.get(nome);
    for (const [c, tipo] of t.colunas) {
      const v = linha[c];
      if (v == null) t.appender.appendNull();
      else (APPEND[tipo] ?? APPEND.VARCHAR)(t.appender, v);
    }
    t.appender.endRow();
    t.linhas++;
  }

  // Exporta cada tabela para <pasta>/<nome>.parquet; colunas TIMESTAMP são convertidas no COPY.
  async exportar(pasta) {
    const contagem = {};
    for (const [nome, t] of this.tabelas) {
      t.appender.closeSync();
      const sel = t.colunas.map(([c, tipo]) => (tipo === 'TIMESTAMP' ? `CAST("${c}" AS TIMESTAMP) AS "${c}"` : `"${c}"`)).join(', ');
      const destino = `${pasta}/${nome}.parquet`;
      await this.con.run(`COPY (SELECT ${sel} FROM "${nome}") TO ${aspas(`${destino}.part`)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
      await rm(destino, { force: true });
      await rename(`${destino}.part`, destino);
      contagem[nome] = t.linhas;
    }
    return contagem;
  }

  async fechar() {
    this.con.closeSync();
    this.instancia.closeSync();
    await rm(this.arquivoBanco, { force: true });
    await rm(`${this.arquivoBanco}.wal`, { force: true });
  }
}
