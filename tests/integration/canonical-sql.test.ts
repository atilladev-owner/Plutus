import { describe, it, expect } from "vitest";
import { testPool } from "../helpers/db.js";
import { canonicalJson, hashEntry, GENESIS_HASH } from "../../src/domain/canonical.js";

const VECTORS: Array<Record<string, unknown>> = [
  { b: 1, a: { d: "x", c: [true, null] } },
  { s: 'q"\\\n\t\u0001' },
  { s: "cedi ₵", z: [], o: {} },
  { seq: 12, amount: "100000000", at: "2026-09-04T10:00:00.000Z", legs: [{ from: "a", to: "b", from_hold: null }] },
];

describe("canonical_json in SQL matches canonicalJson in TypeScript", () => {
  for (const v of VECTORS) {
    it(JSON.stringify(v).slice(0, 40), async () => {
      const { rows } = await testPool().query<{ c: string }>("select canonical_json($1::jsonb) as c", [JSON.stringify(v)]);
      expect(rows[0]?.c).toBe(canonicalJson(v as never));
    });
  }
  it("hashes the same bytes", async () => {
    const canonical = '{"a":1}';
    const { rows } = await testPool().query<{ h: string }>(
      "select encode(sha256(decode(repeat('00', 32), 'hex') || convert_to($1, 'UTF8')), 'hex') as h", [canonical],
    );
    expect(rows[0]?.h).toBe(hashEntry(GENESIS_HASH, canonical).toString("hex"));
  });
  it("refuses fractional numbers", async () => {
    await expect(testPool().query("select canonical_json('{\"x\":1.5}'::jsonb)")).rejects.toThrow(/integer/);
  });
});
