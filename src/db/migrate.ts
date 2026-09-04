import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export async function runMigrations(connectionString: string, dir = join(process.cwd(), "db", "migrations")): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    // One writer at a time, so CI and a laptop cannot race each other.
    await client.query("select pg_advisory_lock(7245100)");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await client.query("select pg_advisory_unlock(7245100)");
  } finally {
    await client.end();
  }
  return applied;
}
