import { describe, it, expect } from "vitest";
import { testPool } from "../helpers/db.js";

describe("schema", () => {
  it("has every table the spec names", async () => {
    const { rows } = await testPool().query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["assets", "api_keys", "ledgers", "accounts", "transfers", "transfer_legs", "holds", "journal", "events", "schema_migrations"]) {
      expect(names).toContain(t);
    }
  });
  it("seeds six assets with the right exponents", async () => {
    const { rows } = await testPool().query<{ code: string; exponent: number }>("select code, exponent from assets order by code");
    expect(rows).toEqual([
      { code: "BTC", exponent: 8 }, { code: "ETH", exponent: 8 }, { code: "GHS", exponent: 2 },
      { code: "HKD", exponent: 2 }, { code: "USD", exponent: 2 }, { code: "USDT", exponent: 6 },
    ]);
  });
  it("returns bigint columns as strings", async () => {
    const { rows } = await testPool().query<{ n: string }>("select 9223372036854775807::bigint as n");
    expect(rows[0]?.n).toBe("9223372036854775807");
    expect(typeof rows[0]?.n).toBe("string");
  });
  it("is idempotent", async () => {
    const { runMigrations } = await import("../../src/db/migrate.js");
    const { testDatabaseUrl } = await import("../helpers/db.js");
    expect(await runMigrations(testDatabaseUrl())).toEqual([]);
  });
});
