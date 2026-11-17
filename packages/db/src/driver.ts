/**
 * Database abstraction.
 *
 * Two drivers implement the same surface:
 *   - `createPostgresDatabase` for a real server (docker-compose or a bank-managed instance);
 *   - `createPgliteDatabase` for the embedded Postgres (WASM) used by local development and tests.
 *
 * Both are real Postgres, so row-level security, triggers and constraint behaviour are identical.
 */
import { mkdirSync } from "node:fs";

import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface Transaction extends Queryable {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface Database extends Queryable {
  begin(): Promise<Transaction>;
  close(): Promise<void>;
}

type Row = Record<string, unknown>;

export function createPostgresDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 10 });

  return {
    async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async begin(): Promise<Transaction> {
      const client = await pool.connect();
      await client.query("BEGIN");
      let finished = false;
      const guard = (): void => {
        if (finished) throw new Error("transaction already finished");
      };
      return {
        async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
          guard();
          const result = await client.query(sql, params);
          return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
        },
        async exec(sql: string): Promise<void> {
          guard();
          await client.query(sql);
        },
        async commit(): Promise<void> {
          if (finished) return;
          finished = true;
          try {
            await client.query("COMMIT");
          } finally {
            client.release();
          }
        },
        async rollback(): Promise<void> {
          if (finished) return;
          finished = true;
          try {
            await client.query("ROLLBACK");
          } finally {
            client.release();
          }
        },
      };
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * PGlite is a single connection, so work is serialised through a mutex. That is exactly the
 * behaviour a single-writer pilot needs, and it keeps concurrent transaction tests meaningful.
 */
export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const instance = dataDir ? new PGlite(dataDir) : new PGlite();
  await instance.waitReady;

  let chain: Promise<void> = Promise.resolve();
  let txActive = false;

  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = chain;
    chain = previous.then(() => held);
    await previous;
    return release;
  };

  const rawQuery = async <T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    const result = await instance.query(sql, params as never[]);
    const rows = (result.rows ?? []) as T[];
    return {
      rows,
      // PGlite reports affectedRows as 0 for SELECTs, and node-postgres reports rows for everything,
      // so prefer whichever count is meaningful for the statement that ran.
      rowCount: rows.length || (result.affectedRows ?? 0),
    };
  };

  const rawExec = async (sql: string): Promise<void> => {
    await instance.exec(sql);
  };

  return {
    async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      if (txActive) return rawQuery<T>(sql, params);
      const release = await acquire();
      try {
        return await rawQuery<T>(sql, params);
      } finally {
        release();
      }
    },
    async exec(sql: string): Promise<void> {
      if (txActive) return rawExec(sql);
      const release = await acquire();
      try {
        await rawExec(sql);
      } finally {
        release();
      }
    },
    async begin(): Promise<Transaction> {
      const release = await acquire();
      txActive = true;
      await rawExec("BEGIN");
      let finished = false;
      const finish = async (statement: "COMMIT" | "ROLLBACK"): Promise<void> => {
        if (finished) return;
        finished = true;
        try {
          await rawExec(statement);
        } finally {
          txActive = false;
          release();
        }
      };
      return {
        query: <T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => rawQuery<T>(sql, params),
        exec: (sql: string): Promise<void> => rawExec(sql),
        commit: () => finish("COMMIT"),
        rollback: () => finish("ROLLBACK"),
      };
    },
    async close(): Promise<void> {
      await instance.close();
    },
  };
}

export const DEMO_ORIGIN = "http://localhost:8787";
