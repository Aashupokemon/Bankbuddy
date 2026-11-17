import { createPgliteDatabase, createPostgresDatabase } from "./driver.ts";
import type { Database, Queryable } from "./driver.ts";

export * from "./driver.ts";
export { writeAudit } from "./audit.ts";
export type { AuditInput } from "./audit.ts";

export interface DatabaseOptions {
  connectionString?: string | undefined;
  dataDir?: string | undefined;
}

/**
 * Uses a real Postgres when DATABASE_URL is set, otherwise the embedded Postgres (PGlite).
 * Local development therefore needs no Docker, and production uses a managed instance.
 */
export async function openDatabase(options: DatabaseOptions = {}): Promise<Database> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL ?? "";
  if (connectionString.trim()) {
    return createPostgresDatabase(connectionString.trim());
  }
  const dataDir = options.dataDir ?? process.env.PGLITE_DIR ?? ".data/pg";
  return createPgliteDatabase(dataDir);
}

/** Opens a throwaway in-memory database — used by tests so no state leaks between runs. */
export async function openTestDatabase(): Promise<Database> {
  return createPgliteDatabase();
}

export interface RequestIdentity {
  userId: string;
  branchId: string;
}

/**
 * Runs `fn` inside a transaction whose `app.branch_id` / `app.user_id` settings are derived from the
 * authenticated membership. Row-level security, and therefore every query inside, sees only that
 * branch.
 */
export async function withRequestContext<T>(
  database: Database,
  identity: RequestIdentity,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const tx = await database.begin();
  try {
    await tx.query("select set_config('app.branch_id', $1, true)", [identity.branchId]);
    await tx.query("select set_config('app.user_id', $1, true)", [identity.userId]);
    // Switch off owner privileges so the RLS policies are enforced, not bypassed.
    await tx.query("set local role bankbuddy_app");
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
