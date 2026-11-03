import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import pg from 'pg';

export type SqlDialect = 'sqlite' | 'postgres';

export interface Sql {
  dialect: SqlDialect;
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  close(): Promise<void>;
}

function bind(params: unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'string'
    ) {
      return value;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return String(value);
  });
}

export function createSqliteSql(dataDir: string): Sql {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'mayak.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    dialect: 'sqlite',
    async exec(sql: string) {
      db.exec(sql);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...bind(params)) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).get(...bind(params)) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...bind(params));
      return { changes: Number(result.changes) };
    },
    async close() {
      db.close();
    },
  };
}

/** `?` placeholders become `$1`, `$2`, … for node-postgres. */
export function toPostgres(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function createPostgresSql(databaseUrl: string): Promise<Sql> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    dialect: 'postgres',
    async exec(sql: string) {
      for (const statement of statements(sql)) {
        await pool.query(toPostgres(statement));
      }
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const result = await pool.query(toPostgres(sql), params);
      return result.rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const result = await pool.query(toPostgres(sql), params);
      return result.rows[0] as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      const result = await pool.query(toPostgres(sql), params);
      return { changes: result.rowCount ?? 0 };
    },
    async close() {
      await pool.end();
    },
  };
}
