import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "./driver.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const migrationsDir = join(here, "migrations");

export async function migrate(database: Database): Promise<string[]> {
  await database.exec(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await database.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const tx = await database.begin();
    try {
      await tx.exec(sql);
      await tx.query("insert into schema_migrations (id) values ($1)", [file]);
      await tx.commit();
      ran.push(file);
    } catch (error) {
      await tx.rollback();
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return ran;
}

export async function resetSchema(database: Database): Promise<void> {
  await database.exec("drop schema public cascade; create schema public;");
}
