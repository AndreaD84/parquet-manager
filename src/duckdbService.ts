import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const nodeRequire = createRequire(__filename);

export interface SqlColumn {
  name: string;
  type: string;
}

export interface SqlQueryResult {
  columns: SqlColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

type DuckDbBlockingModule = {
  createDuckDB: (
    bundles: DuckDbBundles,
    logger: unknown,
    runtime: unknown,
  ) => Promise<DuckDbBindings>;
  ConsoleLogger: new (level?: number) => unknown;
  LogLevel: { WARNING: number };
  selectBundle: (bundles: DuckDbBundles) => Promise<DuckDbBundle>;
  NODE_RUNTIME: unknown;
};

type DuckDbBundles = {
  mvp: { mainModule: string; mainWorker: string };
  eh: { mainModule: string; mainWorker: string };
};

type DuckDbBundle = {
  mainModule: string;
  mainWorker: string;
  pthreadWorker: string | null;
};

type DuckDbBindings = {
  instantiate: () => Promise<DuckDbBindings>;
  open: (config: { path: string }) => void;
  connect: () => DuckDbConnection;
  reset: () => void;
  copyFileToBuffer: (name: string) => Uint8Array;
  copyFileToPath: (name: string, path: string) => void;
  dropFile: (name: string) => void;
};

type DuckDbConnection = {
  query: (sql: string) => ArrowTable;
  close: () => void;
};

type ArrowTable = {
  schema: { fields: { name: string }[] };
  toArray: () => ArrowRow[];
};

type ArrowRow = Record<string, unknown> & { get?: (name: string) => unknown };

export class DuckdbService {
  private bindings: DuckDbBindings | null = null;
  private conn: DuckDbConnection | null = null;
  private initializedFor: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly extensionPath: string) {}

  async ensureReady(filePath: string): Promise<void> {
    if (this.initializedFor === filePath && this.conn) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      if (this.initializedFor === filePath) {
        return;
      }
    }
    this.initPromise = this.initialize(filePath);
    await this.initPromise;
  }

  async query(filePath: string, sql: string): Promise<SqlQueryResult> {
    await this.ensureReady(filePath);
    if (!this.conn) {
      throw new Error('DuckDB is not connected.');
    }
    const table = this.conn.query(sql);
    return tableToResult(table);
  }

  async getColumnTypes(filePath: string): Promise<Map<string, string>> {
    await this.ensureReady(filePath);
    if (!this.conn) {
      throw new Error('DuckDB is not connected.');
    }
    const table = this.conn.query('DESCRIBE parquet_data');
    const result = tableToResult(table);
    const map = new Map<string, string>();
    for (const row of result.rows) {
      const name = row.column_name;
      const type = row.column_type;
      if (typeof name === 'string' && typeof type === 'string') {
        map.set(name, type);
      }
    }
    return map;
  }

  async writeRowUpdate(
    filePath: string,
    tmpPath: string,
    rowIndex: number,
    changedValues: Record<string, unknown>,
    codec: string,
  ): Promise<void> {
    await this.ensureReady(filePath);
    if (!this.conn) {
      throw new Error('DuckDB is not connected.');
    }
    const types = await this.getColumnTypes(filePath);
    const replaceClauses: string[] = [];
    for (const [colName, value] of Object.entries(changedValues)) {
      if (!types.has(colName)) {
        throw new Error(`Unknown column "${colName}".`);
      }
      const colType = types.get(colName) ?? 'VARCHAR';
      const q = quoteIdent(colName);
      const literal = toSqlLiteralCast(value, colType);
      this.validateCast(colName, colType, literal, value);
      replaceClauses.push(
        `CASE WHEN __rn = ${Math.trunc(rowIndex)} THEN ${literal} ELSE ${q} END AS ${q}`,
      );
    }

    const escFile = filePath.replace(/\\/g, '/').replace(/'/g, "''");
    const replaceSql = replaceClauses.length > 0 ? `REPLACE (${replaceClauses.join(', ')})` : '';
    const vfsName = `parquet-manager-output-${Date.now()}.parquet`;
    const sql = `COPY (
      SELECT * EXCLUDE (__rn) ${replaceSql}
      FROM (
        SELECT *, (ROW_NUMBER() OVER ()) - 1 AS __rn FROM read_parquet('${escFile}')
      )
    ) TO '${vfsName}' (FORMAT PARQUET, CODEC '${codec}')`;

    this.conn.query(sql);

    if (!this.bindings) {
      throw new Error('DuckDB bindings unavailable.');
    }
    let bytes: Uint8Array;
    try {
      bytes = this.bindings.copyFileToBuffer(vfsName);
    } finally {
      try {
        this.bindings.dropFile(vfsName);
      } catch {
      }
    }
    await fs.writeFile(tmpPath, bytes);
  }

  private validateCast(
    colName: string,
    colType: string,
    literal: string,
    rawValue: unknown,
  ): void {
    if (!this.conn) {
      throw new Error('DuckDB is not connected.');
    }
    try {
      this.conn.query(`SELECT ${literal}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const display =
        rawValue === null || rawValue === undefined
          ? 'NULL'
          : typeof rawValue === 'string'
            ? `"${rawValue}"`
            : String(rawValue);
      throw new Error(
        `Invalid value for column "${colName}" (${colType}): ${display}. ${detail}`,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
    if (this.bindings) {
      this.bindings.reset();
      this.bindings = null;
    }
    this.initializedFor = null;
    this.initPromise = null;
  }

  private loadDuckdb(): DuckDbBlockingModule {
    return nodeRequire('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs') as DuckDbBlockingModule;
  }

  private getBundles(): DuckDbBundles {
    const dist = path.join(this.extensionPath, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
    return {
      mvp: {
        mainModule: path.join(dist, 'duckdb-mvp.wasm'),
        mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs'),
      },
      eh: {
        mainModule: path.join(dist, 'duckdb-eh.wasm'),
        mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs'),
      },
    };
  }

  private async initialize(filePath: string): Promise<void> {
    const duckdb = this.loadDuckdb();
    const bundles = this.getBundles();

    await this.dispose();

    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    this.bindings = await duckdb.createDuckDB(bundles, logger, duckdb.NODE_RUNTIME);
    await this.bindings.instantiate();
    this.bindings.open({ path: ':memory:' });
    this.conn = this.bindings.connect();

    const escapedPath = filePath.replace(/\\/g, '/').replace(/'/g, "''");
    this.conn.query(
      `CREATE OR REPLACE VIEW parquet_data AS SELECT * FROM read_parquet('${escapedPath}')`,
    );
    this.initializedFor = filePath;
  }
}

function tableToResult(table: ArrowTable): SqlQueryResult {
  const names = table.schema.fields.map((f) => f.name);
  const rows = table.toArray().map((row) => {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const value = row[name];
      out[name] = value !== undefined ? value : row.get?.(name);
    }
    return out;
  });

  const columns: SqlColumn[] = names.map((name) => {
    const sample = rows.find((r) => r[name] !== null && r[name] !== undefined);
    return { name, type: inferColumnType(sample?.[name]) };
  });

  return { columns, rows, rowCount: rows.length };
}

function inferColumnType(value: unknown): string {
  if (value === null || value === undefined) {
    return 'unknown';
  }
  if (typeof value === 'boolean') {
    return 'BOOLEAN';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'INT64' : 'DOUBLE';
  }
  if (typeof value === 'bigint') {
    return 'INT64';
  }
  if (value instanceof Date) {
    return 'TIMESTAMP';
  }
  return 'STRING';
}

export function assertSelectOnly(sql: string): void {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim();
  const upper = stripped.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    throw new Error('Only SELECT queries (including WITH … SELECT) are allowed.');
  }
  if (/[;]/.test(stripped.replace(/;+\s*$/, ''))) {
    throw new Error('Multiple SQL statements are not allowed.');
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toSqlLiteralCast(value: unknown, colType: string): string {
  if (value === null || value === undefined) {
    return `CAST(NULL AS ${colType})`;
  }
  if (typeof value === 'boolean') {
    return `CAST(${value ? 'TRUE' : 'FALSE'} AS ${colType})`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return `CAST(NULL AS ${colType})`;
    }
    return `CAST(${value} AS ${colType})`;
  }
  if (typeof value === 'bigint') {
    return `CAST(${value.toString()} AS ${colType})`;
  }
  const asString = typeof value === 'string' ? value : JSON.stringify(value);
  const escaped = asString.replace(/'/g, "''");
  return `CAST('${escaped}' AS ${colType})`;
}
