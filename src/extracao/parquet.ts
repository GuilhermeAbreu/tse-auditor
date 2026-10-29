// Gravação de tabelas em Parquet via DuckDB: banco temporário em disco (para não estourar a memória
// com o log inteiro), appender por tabela e COPY ... TO parquet no fim.
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBAppender, DuckDBConnection } from '@duckdb/node-api';

export type TipoColuna = 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'BOOLEAN' | 'TIMESTAMP' | 'DOUBLE';
export type Coluna = readonly [string, TipoColuna];
type Tabela = { colunas: readonly Coluna[]; appender: DuckDBAppender; linhas: number };
import { rename, rm } from 'node:fs/promises';

const APPEND: Partial<Record<TipoColuna, (a: DuckDBAppender, v: unknown) => void>> & { VARCHAR: (a: DuckDBAppender, v: unknown) => void } = {
  VARCHAR: (a, v) => a.appendVarchar(String(v)),
  INTEGER: (a, v) => a.appendInteger(v as number),
  BIGINT: (a, v) => a.appendBigInt(BigInt(v as number)),
  BOOLEAN: (a, v) => a.appendBoolean(Boolean(v)),
};

const aspas = (s: string) => `'${s.replaceAll("'", "''")}'`;

export class GravadorParquet {
  declare arquivoBanco: string;
  declare instancia: DuckDBInstance;
  declare con: DuckDBConnection;
  declare tabelas: Map<string, Tabela>;

  static async abrir(arquivoBanco: string, { memoriaLimite = '2GB' }: { memoriaLimite?: string } = {}): Promise<GravadorParquet> {
    await rm(arquivoBanco, { force: true });
    await rm(`${arquivoBanco}.wal`, { force: true });
    const g = new GravadorParquet();
    g.arquivoBanco = arquivoBanco;
    // memória limitada: o que passar vai para o arquivo temporário do próprio DuckDB
    g.instancia = await DuckDBInstance.create(arquivoBanco, { memory_limit: memoriaLimite, temp_directory: `${arquivoBanco}.tmp` });
    g.con = await g.instancia.connect();
    g.tabelas = new Map();
    return g;
  }

  // colunas: [[nome, tipo]], tipo em VARCHAR | INTEGER | BIGINT | BOOLEAN | TIMESTAMP (gravado como texto ISO)
  async criar(nome: string, colunas: readonly Coluna[]): Promise<void> {
    const ddl = colunas.map(([c, t]) => `"${c}" ${t === 'TIMESTAMP' ? 'VARCHAR' : t}`).join(', ');
    await this.con.run(`CREATE TABLE "${nome}" (${ddl})`);
    const appender = await this.con.createAppender(nome);
    this.tabelas.set(nome, { colunas, appender, linhas: 0 });
  }

  inserir(nome: string, linha: Record<string, unknown>): void {
    const t = this.tabelas.get(nome)!;
    for (const [c, tipo] of t.colunas) {
      const v = linha[c];
      if (v == null) t.appender.appendNull();
      else (APPEND[tipo] ?? APPEND.VARCHAR)(t.appender, v);
    }
    t.appender.endRow();
    t.linhas++;
  }

  // Descarrega os appenders no banco em disco (chamado a cada município para não acumular em memória).
  descarregar(): void {
    for (const t of this.tabelas.values()) t.appender.flushSync();
  }

  // Exporta cada tabela para <pasta>/<nome>.parquet; colunas TIMESTAMP são convertidas no COPY.
  async exportar(pasta: string): Promise<Record<string, number>> {
    const contagem: Record<string, number> = {};
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

  async fechar(): Promise<void> {
    this.con.closeSync();
    this.instancia.closeSync();
    await rm(this.arquivoBanco, { force: true });
    await rm(`${this.arquivoBanco}.wal`, { force: true });
    await rm(`${this.arquivoBanco}.tmp`, { recursive: true, force: true });
  }
}
