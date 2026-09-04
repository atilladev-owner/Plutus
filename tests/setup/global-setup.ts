import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate.js";

// A real Postgres for every test run. TEST_DATABASE_URL wins (CI uses a
// service container). Otherwise embedded-postgres starts one in a temp dir.
export default async function setup(): Promise<() => Promise<void>> {
  let url = process.env.TEST_DATABASE_URL;
  let stop: () => Promise<void> = async () => {};
  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = mkdtempSync(join(tmpdir(), "plutus-pg-"));
    const port = 54_300 + Math.trunc(Math.random() * 500);
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: "plutus",
      password: "plutus",
      port,
      persistent: false,
      // Windows initdb defaults to the OS codepage (WIN1252 here), which
      // cannot store the non ASCII bytes the canonical JSON tests send.
      // Force UTF8 so the cluster matches every other environment.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("plutus_test");
    url = `postgres://plutus:plutus@localhost:${port}/plutus_test`;
    stop = async () => { await pg.stop(); };
  }
  process.env.TEST_DATABASE_URL = url;
  await runMigrations(url);
  return async () => { await stop(); };
}
